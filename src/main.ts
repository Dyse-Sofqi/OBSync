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
import type { InstallerHost } from "./features/installer/installerService";
import { createSyncModule, type SyncModule } from "./features/sync";
import {
    fileHistoryOnRemoteUrl,
    fileOnRemoteUrl,
    resolveRemoteContext,
} from "./features/sync/remoteLinks";
import { EditRemoteModal } from "./features/sync/ui/EditRemoteModal";
import { SourceControlView, SYNC_VIEW_TYPE } from "./features/sync/ui/SourceControlView";
import { setHttpDebugLogger } from "./host/http";
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

        this.secretStore = new SecretStore(this.app);
        this.notifier = new Notifier({
            getShowNotices: () => this.settings.showNotices,
            getT: () => this.translations,
        });

        this.applyDerivedSettings();

        // 同步模块在桌面端始终创建（它自己处理「还不是 git 仓库」的状态）。
        this.sync = createSyncModule({
            app: this.app,
            notifier: this.notifier,
            secretStore: this.secretStore,
            getSettings: () => this.settings,
            getT: () => this.translations,
            createStatusBarItem: () => this.addStatusBarItem(),
        });

        this.addSettingTab(new ObsyncSettingsTab(this));

        this.installer = createInstallerModule(this.createInstallerHost(), this.app);
        this.registerInstallerCommands();

        this.addRibbonIcon("git-fork", this.t.plugin.ribbonTooltip, () => {
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
                    new SourceControlView(
                        leaf,
                        sync.service,
                        sync.git,
                        this.t,
                        () => this.editRemote()
                    )
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
            name: this.t.installer.modalTitle,
            callback: () => this.installer.openAddRepoModal(),
        });

        this.addCommand({
            id: "bind-installed-plugins",
            name: this.t.installer.bindTitle,
            callback: () =>
                this.installer.openBindExistingModal((count) => {
                    if (count > 0) {
                        this.notifier.success(this.t.installer.bindDone(count));
                    }
                }),
        });

        this.addCommand({
            id: "check-plugin-updates",
            name: this.t.installer.checkAll,
            callback: () => void this.checkPluginUpdates(),
        });

        this.addCommand({
            id: "update-all-plugins",
            name: this.t.installer.updateAll,
            callback: () => void this.updateAllPlugins(),
        });

        this.addCommand({
            id: "open-settings",
            name: this.t.settings.title,
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
                this.notifier.success(
                    t.installer.updatedMany(
                        updated.length,
                        updated.map((item) => item.name).join("、")
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
            callback: () => void this.runSyncAction(() => this.sync!.service.sync()),
        });

        this.addCommand({
            id: "commit-all",
            name: t.sync.cmdCommit,
            callback: () => void this.runSyncAction(() => this.sync!.service.commitAll()),
        });

        this.addCommand({
            id: "push",
            name: t.sync.cmdPush,
            callback: () => void this.runSyncAction(() => this.sync!.service.push()),
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
            id: "open-source-control-view",
            name: t.sync.viewTitle,
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
     * 打开文件在远端的网页地址。
     *
     * 拼不出链接时给出可行动的提示，而不是打开一个必然 404 的地址 ——
     * 拿不到远端、远端不是 GitHub/Gitee、仓库还没有提交，都会走到这里。
     */
    private async openRemoteUrl(
        vaultPath: string,
        build: typeof fileOnRemoteUrl
    ): Promise<void> {
        const git = this.sync?.git;
        if (!git) return;

        try {
            const context = await resolveRemoteContext(git);
            if (!context) {
                this.notifier.warn(this.t.sync.remoteLinkUnavailable);
                return;
            }
            window.open(build(context, vaultPath), "_blank");
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
        const git = this.sync?.git;
        if (!git) return;

        try {
            await git.init();
            this.notifier.success(this.t.sync.repoInited);
            await this.sync!.service.refresh();
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
                    this.notifier.success(this.t.sync.editRemoteSaved(url || "—"));
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
