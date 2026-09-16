import { Platform, Plugin } from "obsidian";
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

    private translations: LocaleStrings = getTranslations("auto");

    async onload(): Promise<void> {
        await this.loadSettings();

        this.secretStore = new SecretStore(this.app);
        this.notifier = new Notifier({
            getShowNotices: () => this.settings.showNotices,
            getT: () => this.translations,
        });

        this.applyDerivedSettings();

        this.addSettingTab(new ObsyncSettingsTab(this));

        this.installer = createInstallerModule(this.createInstallerHost(), this.app);
        this.registerInstallerCommands();

        this.addRibbonIcon("git-fork", this.t.plugin.ribbonTooltip, () => {
            this.installer.openAddRepoModal();
        });

        // 等 Obsidian 自身启动完成后再做更新检查，避免争抢资源。
        this.app.workspace.onLayoutReady(() => {
            this.installer.scheduleStartupCheck();
        });

        logger.info("plugin loaded", {
            language: this.settings.language,
            desktop: Platform.isDesktopApp,
            secretStorage: this.secretStore.isUsingSecretStorage(),
            tracked: this.settings.installer.tracked.length,
        });
    }

    onunload(): void {
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
}
