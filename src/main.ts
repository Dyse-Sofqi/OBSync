import { Platform, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { getTranslations, type LocaleStrings } from "./core/i18n";
import { logger } from "./core/logger";
import { Notifier } from "./core/notice";
import { SecretStore } from "./core/secretStore";
import {
    DEFAULT_SETTINGS,
    normalizeSettings,
    type ObsyncSettings,
} from "./core/settings";
import { createImageSyncModule, type ImageSyncModule } from "./features/images";
import { isEditableImage, isImagePath, isInsideFolders, normalizeFolders } from "./features/images/imageScan";
import { ImageEditorModal } from "./features/images/ui/ImageEditorModal";
import { IMAGE_VIEW_TYPE, ImageManagerView } from "./features/images/ui/ImageManagerView";
import { registerImageToolbar } from "./features/images/ui/imageToolbar";
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
import { DiffModal } from "./features/sync/ui/DiffModal";
import { SourceControlView, SYNC_VIEW_TYPE } from "./features/sync/ui/SourceControlView";
import { setHttpDebugLogger } from "./host/http";
import { redactUrl } from "./host/redact";
import { ObsyncSettingsTab } from "./settingsTab";

/**
 * 状态栏全宽开关作用的类名（`styles.css` 里那条 `.status-bar:has(...)` 规则
 * 挂在它下面）。
 *
 * 为什么用「给 `body` 加类」而不是「运行时改内联样式」：
 * - 那条规则用到了 `:has()`，只能写在 CSS 里；
 * - 内联样式得自己去改 Obsidian 核心元素的 `style`，那会与主题/其他插件互相覆盖，
 *   而且插件卸载后留下的内联样式更难清干净。
 *
 * 开关关掉时**移除**这个类，CSS 自然不生效 —— 没有第二条规则要同步维护。
 */
const STATUS_BAR_FULL_WIDTH_CLASS = "obsync-status-bar-full-width";

/** 按设置给 `body` 加上/摘掉状态栏全宽那个类。 */
function applyStatusBarWidth(fullWidth: boolean): void {
    document.body.toggleClass(STATUS_BAR_FULL_WIDTH_CLASS, fullWidth);
}

/**
 * SyncHub 主类。
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

    /**
     * 图片同步模块。
     *
     * 与 `sync` 不同，**移动端也有**：它走 Obsidian 的 `requestUrl` 与 vault 的
     * 文件读写，两条在移动端都可用（见 `features/images/index.ts` 的说明）。
     */
    images?: ImageSyncModule;

    private translations: LocaleStrings = getTranslations("auto");

    async onload(): Promise<void> {
        await this.loadSettings();

        // 上次把 SyncHub 自己更新过、但用户没重启 —— 这次加载跑的就是新版本了，
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

        // 图片同步模块。**两个平台都装**（见 `images` 字段的说明），
        // 而且必须用静态 import —— 它是移动端可达的，动态 import 反而会让
        // `scripts/checks.mjs` 的「移动端安全」看不出它到底依赖了什么。
        this.images = createImageSyncModule({
            app: this.app,
            notifier: this.notifier,
            getSettings: () => this.settings,
            getT: () => this.translations,
            secretStore: this.secretStore,
        });

        // 阅读视图里给每张库内图片挂悬浮工具条（裁剪 / 压缩、复制云端链接）。
        registerImageToolbar(this, {
            app: this.app,
            getT: () => this.translations,
            openEditor: (file) => this.openImageEditor(file),
            copyRemoteUrl: (file) => void this.copyImageLink(file),
        });

        // 删掉一张本地图片时，问一句「云端那份也删吗」。
        //
        // 这是删除的**唯一**入口：同步本身只会复制，不会删除（见
        // `features/images/imageSyncService.ts` 的文件头说明）。挂在这里而不是
        // 图片模块内部，是为了让那个模块不必依赖 `Plugin`（它要能在移动端加载）。
        this.registerEvent(
            this.app.vault.on("delete", (file) => this.images?.noteDeleted(file))
        );

        this.installer = createInstallerModule(this.createInstallerHost(), this.app);
        this.registerInstallerCommands();

        // 侧栏图标：**两个**。原来只有一个，而它打开的是安装器 —— 于是想找
        // 同步详情的人点开看到一个装插件的弹窗，找不到「同步面板在哪」。
        // 现在同步那个图标（与 obsidian-git 的位置一致）打开仓库同步视图。
        if (this.sync) {
            this.addRibbonIcon("git-fork", this.t.plugin.ribbonSync, () => {
                void this.openSyncView();
            });
        }
        this.addRibbonIcon("download", this.t.plugin.ribbonInstaller, () => {
            this.installer.openAddRepoModal();
        });
        // 图片管理。**移动端也挂**（图片模块两个平台都在），而它在手机上尤其
        // 有用：命令面板在手机上很难用，而「哪些图没人引用、哪些还没传上去」
        // 恰恰是手机上翻笔记时才会发现的问题。
        this.addRibbonIcon("images", this.t.plugin.ribbonImages, () => {
            void this.openImageManager();
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

        // 图片管理视图（主工作区标签页）。与上面那条**正好相反，两个平台都注册**：
        // 图片模块移动端也装（见 `images` 字段的说明），工厂函数解引用它不会踩空。
        const images = this.images;
        if (images) {
            this.registerView(
                IMAGE_VIEW_TYPE,
                (leaf: WorkspaceLeaf) =>
                    new ImageManagerView(leaf, {
                        app: this.app,
                        // `getT` 而不是快照：标签页是常驻的（同 SourceControlView）。
                        getT: () => this.translations,
                        notifier: this.notifier,
                        service: images.service,
                        // 批量删除必须走模块（它会抑制 `noteDeleted` 的重复询问），
                        // 不能直接调 `service` —— 见 `ImageSyncModule.deleteImages`。
                        deleteImages: (paths, options) => images.deleteImages(paths, options),
                    })
            );
        }
        this.registerSyncCommands();
        this.registerImageCommands();

        // 等 Obsidian 自身启动完成后再做后台动作，避免争抢资源。
        this.app.workspace.onLayoutReady(() => {
            this.installer.scheduleStartupCheck();
            this.sync?.start();
            this.images?.start();
        });

        logger.info("plugin loaded", {
            language: this.settings.language,
            desktop: Platform.isDesktopApp,
            secretStorage: this.secretStore.isUsingSecretStorage(),
            tracked: this.settings.installer.tracked.length,
            syncAvailable: this.sync !== undefined,
            imageFolders: this.settings.images.folders.length,
        });
    }

    onunload(): void {
        this.sync?.stop();
        this.images?.stop();
        // 把状态栏的类摘掉：不摘的话，插件被禁用/卸载后那条全宽规则还挂在
        // body 上（CSS 由 Obsidian 继续加载到下次重载），状态栏会莫名其妙
        // 保持全宽，而且谁也看不出是谁干的。
        applyStatusBarWidth(false);
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
        applyStatusBarWidth(this.settings.statusBarFullWidth);
        this.sync?.reload();
        // 图片同步的开关与间隔变了要重起定时器。与 `sync.reload()` 同一个理由：
        // 只在设置页改值而不通知逻辑层，会让「拨了开关没反应」。
        // `?.` 是必需的：`applyDerivedSettings()` 在 `onload` 里**先于**模块装配被调用。
        this.images?.reload();
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
                void this.runSyncAction(async () => {
                    // 打不开就说清为什么、并指向能改它的地方 —— 一个点了没反应的
                    // 命令会被当成「插件坏了」（见 `openGitignore` 的说明）。
                    if (!(await this.sync!.service.openGitignore())) {
                        this.notifier.warn(this.t.sync.gitignoreOpenFailed);
                    }
                }),
        });

        this.addCommand({
            id: "open-source-control-view",
            // 命令名用 `cmdOpenView` 而不是 `viewTitle`：命令面板里要能搜到，
            // 所以必须以 `SyncHub` 开头（有测试钉着），而面板标题不该带前缀。
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

        // 差异视图的入口。面板上每一行也有一个，但命令面板这条路是**给
        // 「我现在正看着这个文件」用的** —— 从笔记里直接看它的改动，
        // 不用先去侧边栏里找那一行。
        this.addCommand({
            id: "open-diff",
            name: t.sync.cmdOpenDiff,
            checkCallback: (checking) => {
                const file = this.app.workspace.getActiveFile();
                if (!file) return false;
                if (!checking) this.openFileDiff(file.path);
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

    // ── 图片同步与图片编辑 ────────────────────────────────────────────────

    /**
     * 图片相关的命令与右键菜单。
     *
     * **不放在 `registerSyncCommands()` 里**：那个方法在移动端会整个提前返回
     * （笔记同步依赖系统 git），而图片同步与裁剪压缩在移动端是可用的。
     * 混在一起写会让移动端用户一条图片命令都找不到，且看不出原因。
     */
    private registerImageCommands(): void {
        const t = this.t;

        this.addCommand({
            id: "sync-images",
            name: t.images.cmdSync,
            callback: () => void this.runImageSync(),
        });

        this.addCommand({
            id: "preview-image-sync",
            name: t.images.cmdPreview,
            callback: () => void this.previewImageSync(),
        });

        this.addCommand({
            id: "edit-image",
            name: t.images.cmdEdit,
            // `checkCallback`：没有打开图片时这条命令不该出现在命令面板里 ——
            // 列出来却点了没反应，比不列出来更让人困惑。
            checkCallback: (checking) => {
                const file = this.activeImageFile();
                if (!file) return false;
                if (!checking) this.openImageEditor(file);
                return true;
            },
        });

        this.addCommand({
            id: "copy-image-link",
            name: t.images.cmdCopyLink,
            checkCallback: (checking) => {
                const file = this.activeImageFile();
                if (!file) return false;
                if (!checking) void this.copyImageLink(file);
                return true;
            },
        });

        this.addCommand({
            id: "manage-images",
            name: t.images.cmdManage,
            callback: () => void this.openImageManager(),
        });

        this.registerEvent(
            this.app.workspace.on("file-menu", (menu, file) => {
                // 只对图片文件加这两项：给每个文件都挂「裁剪」是噪音。
                if (!(file instanceof TFile) || !isImagePath(file.path)) return;

                menu.addItem((item) =>
                    item
                        .setTitle(t.images.toolbar.crop)
                        .setIcon("crop")
                        .onClick(() => this.openImageEditor(file))
                );
                menu.addItem((item) =>
                    item
                        .setTitle(t.images.toolbar.copyLink)
                        .setIcon("link")
                        .onClick(() => void this.copyImageLink(file))
                );
            })
        );
    }

    /** 当前笔记如果是图片，返回它；否则 null。 */
    private activeImageFile(): TFile | null {
        const file = this.app.workspace.getActiveFile();
        if (!file || !isImagePath(file.path)) return null;
        return file;
    }

    /**
     * 打开图片管理标签页（主工作区）。
     *
     * 2026-09-23 从弹窗改成标签页：整理图片时要**一边看着笔记一边决定哪张能删**，
     * 弹窗把整个库盖住只能二选一，标签页可以并排在笔记旁边。
     *
     * 已经开着就把它显示出来，而不是再开一个 —— 两个标签页扫的是同一批图，
     * 而每扫一遍要好几秒。这与 `openSyncView` 是同一套做法。
     *
     * 公开的：设置页的「打开图片管理」按钮走它（见 `ObsyncSettingsTab`）。
     */
    async openImageManager(): Promise<void> {
        const images = this.images;
        if (!images) return;

        const { workspace } = this.app;
        const existing = workspace.getLeavesOfType(IMAGE_VIEW_TYPE)[0];
        if (existing) {
            await workspace.revealLeaf(existing);
            return;
        }

        try {
            // `getLeaf(true)` = 在根分栏里新建一个标签页（主工作区），
            // 不是右侧边栏 —— 盖住笔记正是弹窗被换掉的原因。
            const leaf = workspace.getLeaf(true);
            await leaf.setViewState({ type: IMAGE_VIEW_TYPE, active: true });
            await workspace.revealLeaf(workspace.getLeavesOfType(IMAGE_VIEW_TYPE)[0] ?? leaf);
        } catch (err) {
            this.notifier.reportError(err, this.t.images.manager.scanFailed);
        }
    }

    /**
     * 打开裁剪 / 压缩弹窗。
     *
     * 不支持画布重编码的格式（svg / gif）在这里就拦下并说明原因 ——
     * 让弹窗自己去拒绝的话，用户会先看到一整套控件、点完保存才发现不行。
     */
    private openImageEditor(file: TFile): void {
        const t = this.t;
        if (!isEditableImage(file.path)) {
            this.notifier.warn(t.images.editor.unsupported);
            return;
        }

        try {
            new ImageEditorModal(this.app, file, {
                app: this.app,
                // `getT` 而不是快照：弹窗可能开着的时候用户切了语言。
                getT: () => this.translations,
                defaults: () => ({
                    quality: this.settings.images.compressQuality,
                    maxEdge: this.settings.images.compressMaxEdge,
                    format: this.settings.images.compressFormat,
                }),
                onSaved: (saved) => {
                    this.notifier.success(t.images.editor.saved(saved.path));
                    // 顺手把这一张推到云端。**不 await、失败也不打断** ——
                    // 它是附带的优化，因为云端不可达而让用户以为「没存上」是本末倒置。
                    void this.images?.service.syncPath(saved.path);
                },
                onError: (error) => {
                    this.notifier.reportError(error, t.images.editor.saveFailed);
                },
            }).open();
        } catch (err) {
            this.notifier.reportError(err, t.images.notice.editorOpenFailed);
        }
    }

    /** 复制一张图的公网地址。 */
    private async copyImageLink(file: TFile): Promise<void> {
        const t = this.t;
        const service = this.images?.service;
        if (!service) return;

        // 范围外 / 没配公网地址时给出**具体**的原因，而不是一个空剪贴板。
        if (!isInsideFolders(file.path, normalizeFolders(this.settings.images.folders))) {
            this.notifier.warn(t.images.notice.notInScope);
            return;
        }

        const url = service.publicUrlFor(file.path);
        if (!url) {
            this.notifier.warn(t.images.notice.noPublicBase);
            return;
        }

        try {
            await navigator.clipboard.writeText(url);
            this.notifier.success(t.images.notice.linkCopied(url));
        } catch (err) {
            this.notifier.reportError(err, t.images.notice.linkCopied(url));
        }
    }

    /** 「立即同步图片」。用户主动发起的动作，所以结束要说一声。 */
    private async runImageSync(): Promise<void> {
        const t = this.t;
        const service = this.images?.service;
        if (!service) return;

        const problem = service.configProblem();
        if (problem) {
            this.notifier.error(this.notifier.describeError(problem, t.images.notice.notConfigured));
            return;
        }

        const progress = this.notifier.progress(t.settings.images.syncing);
        try {
            const summary = await service.run();
            progress.done();

            const didNothing = summary.uploaded === 0 && summary.downloaded === 0;

            if (didNothing) {
                this.notifier.success(t.images.notice.syncNothing);
            } else {
                this.notifier.success(
                    t.images.notice.syncDone(summary.uploaded, summary.downloaded)
                );
            }
            if (summary.failed > 0) {
                this.notifier.warn(t.images.notice.syncFailedMany(summary.failed));
            }
        } catch (err) {
            progress.done();
            this.notifier.reportError(err, t.images.notice.syncFailed);
        }
    }

    /** 「预览变更」：只算不做。 */
    private async previewImageSync(): Promise<void> {
        const t = this.t;
        const service = this.images?.service;
        if (!service) return;

        try {
            const plan = await service.plan();
            const counts = { upload: 0, download: 0, skip: 0, conflict: 0 };
            for (const entry of plan.entries) counts[entry.action] += 1;

            this.notifier.info(
                t.images.plan.counts(
                    counts.upload,
                    counts.download,
                    counts.conflict,
                    counts.skip
                )
            );
            if (plan.truncated) this.notifier.warn(t.images.plan.truncated);
        } catch (err) {
            this.notifier.reportError(err, t.images.notice.previewFailed);
        }
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

    /**
     * 打开当前文件的差异（命令面板那条路）。
     *
     * 与面板上那一行的入口是同一个弹窗、同一份数据，只是**从哪儿点**不同：
     * 面板是「我扫到了这一行」，命令面板是「我正在看这个文件」。
     */
    private openFileDiff(vaultPath: string): void {
        const service = this.sync?.service;
        if (!service) return;

        new DiffModal(this.app, {
            target: vaultPath,
            getT: () => this.translations,
            load: async () => {
                const diff = await service.fileDiff(vaultPath);
                return [
                    { kind: "working", files: [diff.unstaged] },
                    { kind: "staged", files: [diff.staged] },
                ];
            },
        }).open();
    }

    private async openFileHistoryOnRemote(vaultPath: string): Promise<void> {
        await this.openRemoteUrl(vaultPath, fileHistoryOnRemoteUrl);
    }

    /** 仓库同步视图里点某条提交：在远端网页上看它。 */
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
