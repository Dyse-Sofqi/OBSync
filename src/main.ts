import { Platform, Plugin, WorkspaceLeaf } from "obsidian";
import { getTranslations, type LocaleStrings } from "./core/i18n";
import { logger } from "./core/logger";
import { Notifier } from "./core/notice";
import { SecretStore } from "./core/secretStore";
import {
    DEFAULT_SETTINGS,
    normalizeSettings,
    type ObsyncSettings,
} from "./core/settings";
import { createInstallerModule, type InstallerModule } from "./features/installer";
import { downloadSourceLabel } from "./features/installer/downloadSource";
import { clearPendingRestart } from "./features/installer/selfUpdate";
import type { InstallerHost } from "./features/installer/installerService";
import type { SyncModule } from "./features/sync";
import {
    commitOnRemoteUrl,
    fileHistoryOnRemoteUrl,
    fileOnRemoteUrl,
    resolveRemoteContext,
    type RemoteContext,
} from "./features/sync/remoteLinks";
import { EditRemoteModal } from "./features/sync/ui/EditRemoteModal";
import { SourceControlView, SYNC_VIEW_TYPE } from "./features/sync/ui/SourceControlView";
import { setHttpDebugLogger } from "./host/http";
import { redactUrl } from "./host/redact";
import { ObsyncSettingsTab } from "./settingsTab";

/**
 * OBSync 主类。
 *
 * 设计上刻意保持「只做装配」：主类不实现任何业务逻辑，只负责
 * 加载设置、构造共用的基础设施（i18n / 令牌存储 / 提示器），
 * 然后把功能模块挂上去。
 *
 * 参考项目 obsidian-git 的 main.ts 有 60KB、把同步编排也塞在里面，
 * 结果是改任何一处都要先读完整个文件。这里从一开始就切开。
 */
/**
 * 只在桌面端加载同步模块。
 *
 * ## 为什么不能静态 import
 *
 * 同步模块依赖 `simple-git`，而它（及其依赖）在**模块初始化阶段**就
 * `require("child_process")` / `require("fs")`。移动端没有 Node 集成，
 * `require` 不可用 —— Obsidian 官方文档明确说这类调用「会让插件崩溃」。
 *
 * 静态导入会让整条依赖链在**插件加载时**就初始化，于是移动端一启用就崩，
 * 连纯 HTTP 的安装器都用不了。所以这里用**动态 import** 推迟到确认是桌面端之后。
 *
 * 实测依据（`scripts/verify-mobile-load.mjs`）：把打包产物放进一个
 * 「require 对 node 内置模块抛错」的环境里加载 —— 静态导入时以
 * `require is not defined: fs` 失败，改成动态 import 后不再抛错。
 * 那个脚本就是在模拟移动端，随时可以重跑：
 *
 *     pnpm verify:mobile      # 构建 + 验证，发布前该跑一次
 *
 * 另有 `scripts/checks.mjs` 的「移动端安全」一项从静态导入图做快速守卫 ——
 * 两者是「快速守卫 + 发布前实证」的关系。
 *
 * 注意**不要**改回 `require(...)`：Obsidian 桌面端能用，但测试环境是 ESM，
 * `require` 不存在，启动测试会全部失败。
 */
async function loadSyncModule(): Promise<typeof import("./features/sync")> {
    return await import("./features/sync");
}

export default class ObsyncPlugin extends Plugin {
    settings: ObsyncSettings = DEFAULT_SETTINGS;

    /** 令牌存储。令牌只在这里，不进 data.json。 */
    secretStore!: SecretStore;

    /** 统一的用户提示（受设置控制 + 错误翻译）。 */
    notifier!: Notifier;

    /** 插件安装器模块。 */
    installer!: InstallerModule;

    /** 笔记同步模块。移动端为 undefined。 */
    sync?: SyncModule;

    private translations: LocaleStrings = getTranslations("auto");

    async onload(): Promise<void> {
        await this.loadSettings();

        // 上次把 OBSync 自己更新过、但用户没重启 —— 这次加载跑的就是新版本了，
        // 待重启的标记到此为止（不清掉的话设置页会一直挂着「已下载 x，重启后生效」，
        // 而用户明明已经重启过）。见 features/installer/selfUpdate.ts。
        if (clearPendingRestart(this.settings)) {
            await this.saveSettings();
        }

        this.secretStore = new SecretStore(this.app);
        this.notifier = new Notifier({
            getShowNotices: () => this.settings.showNotices,
            getT: () => this.translations,
        });

        this.applyDerivedSettings();

        // 同步模块**只在桌面端加载**（理由见 loadSyncModule 的说明）。
        if (Platform.isDesktopApp) {
            const { createSyncModule } = await loadSyncModule();
            this.sync = createSyncModule({
                app: this.app,
                notifier: this.notifier,
                secretStore: this.secretStore,
                getSettings: () => this.settings,
                getT: () => this.translations,
                createStatusBarItem: () => this.addStatusBarItem(),
                // 状态栏条目点开的就是这个面板 —— 它是屏幕上唯一常驻的同步入口。
                openSourceControlView: () => void this.openSyncView(),
            });
        }

        this.addSettingTab(new ObsyncSettingsTab(this));

        this.installer = createInstallerModule(this.createInstallerHost(), this.app);
        this.registerInstallerCommands();

        // 侧栏图标：**两个**。原来只有一个，而它打开的是安装器 —— 于是想找
        // 同步详情的人点开看到一个装插件的弹窗，找不到「同步面板在哪」。
        // 现在同步那个图标（与 obsidian-git 的位置一致）打开源码控制视图。
        if (this.sync) {
            this.addRibbonIcon("git-fork", this.t.plugin.ribbonSync, () => {
                void this.openSyncView();
            });
        }
        this.addRibbonIcon("download", this.t.plugin.ribbonInstaller, () => {
            this.installer.openAddRepoModal();
        });

        // 视图只在桌面端注册 —— 工厂函数会解引用 sync 模块，移动端它是 undefined。
        // 虽然命令入口已经做了守卫，但视图类型一旦注册，恢复工作区布局时
        // 仍可能被实例化，所以守卫要放在注册这一步。
        if (this.sync) {
            const sync = this.sync;
            this.registerView(
                SYNC_VIEW_TYPE,
                (leaf: WorkspaceLeaf) =>
                    new SourceControlView(leaf, {
                        service: sync.service,
                        git: sync.git,
                        // `getT` 而不是 `this.t`：视图是常驻的，快照文案会让它
                        // 切换语言后一直显示旧语言（见视图的 deps 注释）。
                        getT: () => this.translations,
                        onEditRemote: () => this.editRemote(),
                        onInitRepo: () => void this.initRepo(),
                        onOpenFileOnRemote: (path) => void this.openFileOnRemote(path),
                        onOpenCommitOnRemote: (hash) => void this.openCommitOnRemote(hash),
                    })
            );
        }
        this.registerSyncCommands();

        // 等 Obsidian 自身启动完成后再做后台动作，避免争抢资源。
        this.app.workspace.onLayoutReady(() => {
            this.installer.scheduleStartupCheck();
            this.sync?.start();
        });

        logger.info("plugin loaded", {
            language: this.settings.language,
            desktop: Platform.isDesktopApp,
            secretStorage: this.secretStore.isUsingSecretStorage(),
            tracked: this.settings.installer.tracked.length,
            syncAvailable: this.sync !== undefined,
        });
    }

    onunload(): void {
        this.sync?.stop();
        logger.info("plugin unloaded");
    }

    /** 当前语言的翻译表。 */
    get t(): LocaleStrings {
        return this.translations;
    }

    /**
     * 笔记同步是否可用。
     *
     * 插件本身在移动端可加载（安装器是纯 HTTP 的），但同步依赖系统 git，
     * 所以运行时按平台判定，而不是用 manifest 的 `isDesktopOnly` 一刀切。
     * 这也是参考项目 obsidian-git 的做法。
     */
    get isSyncAvailable(): boolean {
        return Platform.isDesktopApp;
    }

    async loadSettings(): Promise<void> {
        this.settings = normalizeSettings(await this.loadData());
    }

    async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
    }

    /** 设置变更后调用：重新计算所有从设置派生的状态。 */
    applyDerivedSettings(): void {
        this.translations = getTranslations(this.settings.language);
        logger.setVerbose(this.settings.debugLogging);
        setHttpDebugLogger(
            this.settings.debugLogging ? (message) => logger.debug(message) : undefined
        );
        this.sync?.reload();
    }

    /** 供安装器模块使用的依赖。 */
    private createInstallerHost(): InstallerHost {
        return {
            app: this.app,
            notifier: this.notifier,
            secretStore: this.secretStore,
            getSettings: () => this.settings,
            getT: () => this.translations,
            saveSettings: () => this.saveSettings(),
        };
    }

    private registerInstallerCommands(): void {
        this.addCommand({
            id: "add-plugin-repo",
            name: this.t.installer.cmdAddRepo,
            callback: () => this.installer.openAddRepoModal(),
        });

        this.addCommand({
            id: "bind-installed-plugins",
            name: this.t.installer.cmdBindExisting,
            callback: () =>
                this.installer.openBindExistingModal((count) => {
                    if (count > 0) {
                        this.notifier.success(this.t.installer.bindDone(count));
                    }
                }),
        });

        this.addCommand({
            id: "check-plugin-updates",
            name: this.t.installer.cmdCheckUpdates,
            callback: () => void this.checkPluginUpdates(),
        });

        this.addCommand({
            id: "update-all-plugins",
            name: this.t.installer.cmdUpdateAll,
            callback: () => void this.updateAllPlugins(),
        });

        this.addCommand({
            id: "open-settings",
            name: this.t.settings.cmdOpenSettings,
            callback: () => this.openSettings(),
        });
    }

    private async checkPluginUpdates(): Promise<void> {
        const t = this.t;
        const tracked = this.settings.installer.tracked;
        if (tracked.length === 0) {
            this.notifier.info(t.settings.installer.trackedEmpty);
            return;
        }

        try {
            const summary = await this.installer.checker.checkAll(tracked);
            if (summary.outdated === 0 && summary.failed === 0) {
                this.notifier.success(t.installer.checkNone);
                return;
            }
            this.notifier.info(t.installer.checkSummary(summary.outdated, summary.failed));
        } catch (err) {
            this.notifier.reportError(err, t.installer.checkFailed);
        }
    }

    private async updateAllPlugins(): Promise<void> {
        const t = this.t;
        const tracked = this.settings.installer.tracked;
        if (tracked.length === 0) {
            this.notifier.info(t.settings.installer.trackedEmpty);
            return;
        }

        try {
            const summary = await this.installer.checker.checkAll(tracked);
            const { updated, failed } = await this.installer.checker.updateAll(summary.results);

            if (updated.length > 0) {
                // 来源去重后一并报出：一次「全部更新」可能有的走 GitHub、有的走
                // Gitee 镜像，用户要能看出这一点（也是「到底有没有用镜像」的答案）。
                const sources = [
                    ...new Set(updated.map((entry) => downloadSourceLabel(t, entry.source))),
                ];
                this.notifier.success(
                    t.installer.updatedMany(
                        updated.length,
                        updated.map((entry) => entry.tracked.name).join("、"),
                        sources.join("、")
                    )
                );
            }
            if (failed.length > 0) {
                // 逐条列出失败原因 —— 只说"更新失败"用户无从下手。
                this.notifier.error(
                    t.installer.updateFailedMany(failed.length) +
                        "\n" +
                        failed.map((item) => `${item.tracked.name}: ${item.error}`).join("\n")
                );
            }
            if (updated.length === 0 && failed.length === 0) {
                this.notifier.success(t.installer.checkNone);
            }
        } catch (err) {
            this.notifier.reportError(err, t.installer.installFailed);
        }
    }

    private openSettings(): void {
        const app = this.app as unknown as {
            setting?: { open(): void; openTabById(id: string): void };
        };
        app.setting?.open();
        app.setting?.openTabById(this.manifest.id);
    }

    // ── 同步命令 ──────────────────────────────────────────────────────────

    private registerSyncCommands(): void {
        if (!this.isSyncAvailable) return;
        const t = this.t;

        this.addCommand({
            id: "sync-now",
            name: t.sync.cmdSync,
            // `announceInSync`：用户主动发起的动作，结束且与远端一致时要说一声
            // （醒目提示，见 SyncService.announceInSync）。自动定时器不传。
            callback: () =>
                void this.runSyncAction(() =>
                    this.sync!.service.sync({ announceInSync: true })
                ),
        });

        this.addCommand({
            id: "commit-all",
            name: t.sync.cmdCommit,
            callback: () =>
                void this.runSyncAction(() =>
                    this.sync!.service.commitAll({ announce: true })
                ),
        });

        this.addCommand({
            id: "push",
            name: t.sync.cmdPush,
            // `announceIfUpToDate`：用户按下的动作必须有个回音 ——
            // 本地没有新提交时界面本来一点变化都没有（见 SyncService.push）。
            callback: () =>
                void this.runSyncAction(() =>
                    this.sync!.service.push({ announceIfUpToDate: true })
                ),
        });

        this.addCommand({
            id: "pull",
            name: t.sync.cmdPull,
            callback: () => void this.runSyncAction(() => this.sync!.service.pull()),
        });

        this.addCommand({
            id: "init-repo",
            name: t.sync.cmdInit,
            callback: () => void this.initRepo(),
        });

        this.addCommand({
            id: "abort-merge",
            name: t.sync.cmdAbortMerge,
            callback: () => void this.runSyncAction(() => this.sync!.service.abortMerge()),
        });

        this.addCommand({
            id: "edit-remote",
            name: t.sync.cmdEditRemote,
            callback: () => this.editRemote(),
        });

        this.addCommand({
            id: "edit-gitignore",
            name: t.sync.cmdEditGitignore,
            callback: () =>
                void this.runSyncAction(() => this.sync!.service.openGitignore()),
        });

        this.addCommand({
            id: "open-source-control-view",
            // 命令名用 `cmdOpenView` 而不是 `viewTitle`：命令面板里要能搜到，
            // 所以必须以 `OBSync` 开头（有测试钉着），而面板标题不该带前缀。
            name: t.sync.cmdOpenView,
            callback: () => void this.openSyncView(),
        });

        // 「在远端打开」—— 参考项目 obsidian-git 的 openInGitHub 能力，
        // 但 URL 模板走 host 层，所以 GitHub 与 Gitee 同一套代码。
        this.addCommand({
            id: "open-file-on-remote",
            name: t.sync.cmdOpenFileOnRemote,
            checkCallback: (checking) => {
                const file = this.app.workspace.getActiveFile();
                if (!file) return false;
                if (!checking) void this.openFileOnRemote(file.path);
                return true;
            },
        });

        this.addCommand({
            id: "open-file-history-on-remote",
            name: t.sync.cmdOpenFileHistoryOnRemote,
            checkCallback: (checking) => {
                const file = this.app.workspace.getActiveFile();
                if (!file) return false;
                if (!checking) void this.openFileHistoryOnRemote(file.path);
                return true;
            },
        });

        this.registerEvent(
            this.app.workspace.on("file-menu", (menu, file) => {
                menu.addItem((item) =>
                    item
                        .setTitle(t.sync.menuOpenOnRemote)
                        .setIcon("external-link")
                        .onClick(() => void this.openFileOnRemote(file.path))
                );
                menu.addItem((item) =>
                    item
                        .setTitle(t.sync.menuOpenHistoryOnRemote)
                        .setIcon("history")
                        .onClick(() => void this.openFileHistoryOnRemote(file.path))
                );
            })
        );
    }

    /**
     * 打开某个东西（文件 / 提交）在远端的网页地址。
     *
     * 拼不出链接时给出可行动的提示，而不是打开一个必然 404 的地址 ——
     * 拿不到远端、远端不是 GitHub/Gitee、仓库还没有提交，都会走到这里。
     *
     * `build` 收的是「怎么把这个东西拼成 URL」的函数，所以文件与提交共用
     * 这一条链路（早先这里写死了 `typeof fileOnRemoteUrl`，加提交时才发现
     * 参数类型把它挡住了）。
     */
    private async openRemoteUrl(
        target: string,
        build: (context: RemoteContext, target: string) => string
    ): Promise<void> {
        const git = this.sync?.git;
        if (!git) return;

        try {
            const context = await resolveRemoteContext(git);
            if (!context) {
                this.notifier.warn(this.t.sync.remoteLinkUnavailable);
                return;
            }
            window.open(build(context, target), "_blank");
        } catch (err) {
            this.notifier.reportError(err, this.t.sync.remoteLinkUnavailable);
        }
    }

    private async openFileOnRemote(vaultPath: string): Promise<void> {
        await this.openRemoteUrl(vaultPath, fileOnRemoteUrl);
    }

    private async openFileHistoryOnRemote(vaultPath: string): Promise<void> {
        await this.openRemoteUrl(vaultPath, fileHistoryOnRemoteUrl);
    }

    /** 源码控制视图里点某条提交：在远端网页上看它。 */
    private async openCommitOnRemote(hash: string): Promise<void> {
        await this.openRemoteUrl(hash, commitOnRemoteUrl);
    }

    /** 同步动作的统一错误出口。sync 层的错误类型都带用户可读文案，直接展示。 */
    private async runSyncAction(action: () => Promise<unknown>): Promise<void> {
        try {
            await action();
        } catch (err) {
            logger.warn("sync action failed", err);
            this.notifier.reportError(err);
        }
    }

    private async initRepo(): Promise<void> {
        const sync = this.sync;
        if (!sync) return;

        try {
            // 走 service 而不是直接 git.init()：service 会顺带处理 .gitignore
            // （没有就建一份默认的，避免用户把 workspace.json 同步出去）。
            const { createdGitignore } = await sync.service.initRepo();
            this.notifier.success(this.t.sync.repoInited);
            if (createdGitignore) {
                this.notifier.info(this.t.sync.gitignoreCreated);
            }
        } catch (err) {
            await this.runSyncAction(() => Promise.reject(err));
        }
    }

    private editRemote(): void {
        if (!this.sync) return;

        void this.sync.git.getRemoteUrl().then((current) => {
            new EditRemoteModal(this.app, current, this.t, async (url) => {
                try {
                    if (url) {
                        await this.sync!.git.setRemoteUrl(url);
                    }
                    // 回显前脱敏：用户完全可能填一个带令牌的地址
                    // （弹窗会警告，但选择权留给他），而这条提示会**弹在屏幕上**。
                    this.notifier.success(this.t.sync.editRemoteSaved(redactUrl(url) || "—"));
                    await this.sync!.service.refresh();
                } catch (err) {
                    await this.runSyncAction(() => Promise.reject(err));
                }
            }).open();
        });
    }

    private async openSyncView(): Promise<void> {
        const { workspace } = this.app;
        const existing = workspace.getLeavesOfType(SYNC_VIEW_TYPE)[0];
        if (existing) {
            workspace.revealLeaf(existing);
            return;
        }
        await workspace.getRightLeaf(false)?.setViewState({
            type: SYNC_VIEW_TYPE,
            active: true,
        });
        workspace.revealLeaf(workspace.getLeavesOfType(SYNC_VIEW_TYPE)[0]!);
    }
}
