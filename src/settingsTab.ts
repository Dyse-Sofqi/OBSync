import { PluginSettingTab, Setting, type App } from "obsidian";
import { LANGUAGE_OPTIONS, type LanguageSetting } from "./core/i18n";
import { shouldCheckOnSettingsOpen } from "./features/installer/updateChecker";
import { renderTrackedPlugins } from "./features/installer/ui/TrackedPluginsList";
import type ObsyncPlugin from "./main";
import { getHost } from "./host/hostRegistry";
import type { HostKind } from "./host/types";

/**
 * 设置页的四个标签页。
 *
 * 顺序即显示顺序。把「已追踪插件」放第一页：用户进设置页多半是想看
 * 哪个插件能更新、或再装一个，而不是来调开关的。
 */
type SettingsTabId = "tracked" | "installer" | "sync" | "general";

/**
 * 设置页。
 *
 * 与参考项目 BRAT 的一个明显不同：BRAT 的 `SettingsTab.ts` 有 30KB，
 * 并且**新旧两套渲染方式并存**（声明式的 `getSettingDefinitions()` 与
 * 手写的 `display()`），因为要兼容不同 Obsidian 版本。这里只用后者 ——
 * 兼容包袱不值得背。
 *
 * ## 进入设置页自动检查更新
 *
 * Obsidian 每次打开页签都会调用 `display()`，关闭时调用 `hide()` ——
 * 用这两个时机区分「用户打开了设置页」与「页内重绘」（commit/refresh 也会
 * 调 display()）。再加一层时间节流（见 shouldCheckOnSettingsOpen），
 * 避免反复开合把接口配额打光。
 */
export class ObsyncSettingsTab extends PluginSettingTab {
    /** 页签当前是否打开（用于识别 display() 是「打开」还是「重绘」）。 */
    private tabOpen = false;

    /** 当前选中的标签页。显示顺序即数组顺序（见 renderTabs）。 */
    private activeTab: SettingsTabId = "tracked";

    constructor(private readonly obsync: ObsyncPlugin) {
        super(obsync.app, obsync);
    }

    display(): void {
        const justOpened = !this.tabOpen;
        this.tabOpen = true;

        const { containerEl } = this;
        containerEl.empty();
        // 样式作用域标记：下面的规则都挂在 .obsync-settings 下，
        // 避免污染 Obsidian 与其他插件的设置页（.setting-item-* 是全局类）。
        containerEl.addClass("obsync-settings");

        this.renderTabs();

        switch (this.activeTab) {
            case "tracked":
                this.renderTrackedTab();
                break;
            case "installer":
                this.renderInstaller();
                break;
            case "sync":
                this.renderSync();
                break;
            case "general":
                this.renderGeneral();
                break;
        }

        if (justOpened) void this.autoCheckOnOpen();
    }

    hide(): void {
        this.tabOpen = false;
        super.hide();
    }

    /**
     * 标签栏。
     *
     * Obsidian 的 PluginSettingTab 没有内建分页，自己画一条 ——
     * 用普通 button 而不是 Setting，因为它们只是导航，不承载设置语义。
     * 选中项存在内存里：页内重绘（改设置、刷新列表）后仍停在原标签，
     * 不会把用户弹回第一页。
     */
    private renderTabs(): void {
        const t = this.obsync.t;
        const tabs: Array<{ id: SettingsTabId; label: string }> = [
            { id: "tracked", label: t.settings.tabs.tracked },
            { id: "installer", label: t.settings.tabs.installer },
            { id: "sync", label: t.settings.tabs.sync },
            { id: "general", label: t.settings.tabs.general },
        ];

        const nav = this.containerEl.createDiv({ cls: "obsync-tabs" });
        for (const tab of tabs) {
            const button = nav.createEl("button", {
                text: tab.label,
                cls: "obsync-tab",
            });
            if (tab.id === this.activeTab) button.addClass("is-active");

            if (tab.id === "tracked") this.renderTrackedCounts(button);

            button.addEventListener("click", () => {
                if (this.activeTab === tab.id) return;
                this.activeTab = tab.id;
                // 切标签不触发自动检查（tabOpen 已为 true），只换内容。
                this.display();
            });
        }
    }

    /**
     * 在「已追踪插件」标签上挂计数。
     *
     * 有可更新项时用强调色 —— 用户不必点进去就知道有几处要处理。
     */
    private renderTrackedCounts(button: HTMLElement): void {
        const installer = this.obsync.settings.installer;
        const tracked = installer.tracked.length;
        if (tracked === 0) return;

        button.createSpan({ text: String(tracked), cls: "obsync-tab-count" });

        const updates = Object.keys(installer.availableUpdates).length;
        if (updates > 0) {
            button.createSpan({
                text: `↑${updates}`,
                cls: "obsync-tab-count is-update",
            });
        }
    }

    /** 标签一：已追踪插件 —— 头部栏（标题 + 说明 + 三个主操作）+ 跟踪列表。 */
    private renderTrackedTab(): void {
        const t = this.obsync.t;

        // 标题、说明与主操作放在同一行：左侧文字、右侧按钮，中间不留空。
        new Setting(this.containerEl)
            .setName(t.settings.installer.tracked)
            .setDesc(t.settings.installer.trackedDesc)
            .setClass("obsync-section-header")
            .addButton((button) =>
                button
                    .setButtonText(t.installer.modalTitle)
                    .setCta()
                    .onClick(() => this.obsync.installer.openAddRepoModal())
            )
            .addButton((button) =>
                button
                    .setButtonText(t.installer.bindTitle)
                    .onClick(() =>
                        this.obsync.installer.openBindExistingModal(() => this.display())
                    )
            )
            .addButton((button) =>
                button.setButtonText(t.installer.checkAll).onClick(async () => {
                    button.setDisabled(true);
                    await this.checkAllUpdates();
                    button.setDisabled(false);
                })
            );

        renderTrackedPlugins(this.containerEl, {
            app: this.obsync.app,
            t,
            service: this.obsync.installer.service,
            checker: this.obsync.installer.checker,
            getTracked: () => this.obsync.settings.installer.tracked,
            getUpdateFor: (pluginId) =>
                this.obsync.settings.installer.availableUpdates[pluginId],
            refresh: () => this.display(),
        });
    }

    /** 打开设置页时的自动检查（受设置与节流控制）。 */
    private async autoCheckOnOpen(): Promise<void> {
        const installer = this.obsync.settings.installer;
        const due = shouldCheckOnSettingsOpen({
            enabled: installer.enabled,
            autoCheckOnSettingsOpen: installer.autoCheckOnSettingsOpen,
            trackedCount: installer.tracked.length,
            lastCheckAt: installer.lastUpdateCheckAt,
            now: Date.now(),
        });
        if (!due) return;

        // 自动检查静默：全部最新时不弹提示（用户只是打开设置页看一眼，
        // 不需要被打扰）；有更新时列表徽标本身就是提示。
        await this.checkAllUpdates({ quietWhenNone: true });
    }

    /** 设置改完后统一走这里：落盘 + 重算派生状态 + 重绘。 */
    private async commit(redraw = false): Promise<void> {
        await this.obsync.saveSettings();
        this.obsync.applyDerivedSettings();
        if (redraw) this.display();
    }

    private renderLanguage(): void {
        const t = this.obsync.t;

        new Setting(this.containerEl)
            .setName(t.settings.language.name)
            .setDesc(t.settings.language.desc)
            .addDropdown((dropdown) => {
                for (const option of LANGUAGE_OPTIONS) {
                    dropdown.addOption(
                        option.value,
                        option.value === "auto" ? t.settings.language.auto : option.label
                    );
                }
                dropdown.setValue(this.obsync.settings.language);
                dropdown.onChange(async (value) => {
                    this.obsync.settings.language = value as LanguageSetting;
                    // 语言变了，整页文案都要换，所以重绘。
                    await this.commit(true);
                });
            });
    }

    private renderTokens(): void {
        const t = this.obsync.t;

        new Setting(this.containerEl).setName(t.settings.token.heading).setHeading();
        this.containerEl.createEl("p", {
            cls: "setting-item-description",
            text: t.settings.token.desc,
        });

        this.renderTokenField("github");
        this.renderTokenField("gitee");
    }

    private renderTokenField(host: HostKind): void {
        const t = this.obsync.t;
        const name =
            host === "github" ? t.settings.token.githubName : t.settings.token.giteeName;
        const desc =
            host === "github" ? t.settings.token.githubDesc : t.settings.token.giteeDesc;

        let pending = this.obsync.secretStore.getToken(host) ?? "";
        let dirty = false;

        // 状态徽标要跟着输入/清除即时变（渲染时机在构造 Setting 之后，
        // 所以用闭包持有元素引用，而不是等下一次 display()）。
        let statusEl: HTMLElement | undefined;
        const refreshStatus = (): void => {
            if (!statusEl) return;
            const configured = pending.trim().length > 0;
            statusEl.setText(
                configured ? t.settings.token.configured : t.settings.token.notConfigured
            );
            statusEl.toggleClass("obsync-badge-ok", configured);
            statusEl.toggleClass("obsync-badge-muted", !configured);
        };

        const setting = new Setting(this.containerEl)
            .setName(name)
            .setDesc(desc)
            .addText((text) => {
                text.inputEl.type = "password";
                text.inputEl.autocomplete = "off";
                text.inputEl.spellcheck = false;
                text.setPlaceholder(t.settings.token.placeholder);
                text.setValue(pending);
                // 每次按键都写密钥存储太浪费，改成内存暂存 + 失焦落盘。
                text.onChange((value) => {
                    pending = value;
                    dirty = true;
                });
                text.inputEl.addEventListener("blur", () => {
                    if (!dirty) return;
                    dirty = false;
                    this.obsync.secretStore.setToken(host, pending);
                    refreshStatus();
                });
            })
            .addButton((button) =>
                button.setButtonText(t.settings.token.test).onClick(async () => {
                    const token = pending.trim();
                    if (!token) {
                        this.obsync.secretStore.clearToken(host);
                        refreshStatus();
                        this.obsync.notifier.info(t.settings.token.cleared);
                        return;
                    }

                    this.obsync.secretStore.setToken(host, token);
                    dirty = false;
                    refreshStatus();

                    button.setDisabled(true);
                    button.setButtonText(t.settings.token.testing);
                    try {
                        const info = await getHost(host).validateToken(token);
                        if (info.valid) {
                            this.obsync.notifier.success(
                                t.settings.token.valid(
                                    getHost(host).displayName,
                                    info.account ?? t.common.unknown
                                )
                            );
                        } else {
                            this.obsync.notifier.error(
                                t.settings.token.invalid(getHost(host).displayName)
                            );
                        }
                    } catch (err) {
                        this.obsync.notifier.reportError(
                            err,
                            t.settings.token.invalid(getHost(host).displayName)
                        );
                    } finally {
                        button.setDisabled(false);
                        button.setButtonText(t.settings.token.test);
                    }
                })
            )
            .addExtraButton((button) =>
                button
                    .setIcon("trash")
                    .setTooltip(t.common.delete)
                    .onClick(async () => {
                        this.obsync.secretStore.clearToken(host);
                        pending = "";
                        dirty = false;
                        setting.settingEl.empty();
                        this.display();
                        this.obsync.notifier.info(t.settings.token.cleared);
                    })
            );

        void setting;

        // 一眼看出这个平台有没有配令牌（状态类信息做成徽标，不塞进描述文字）。
        statusEl = setting.nameEl.createSpan({ cls: "obsync-badge" });
        refreshStatus();
    }

    /** 标签四：通用 —— 界面语言 + 提示与日志。 */
    private renderGeneral(): void {
        const t = this.obsync.t;

        this.renderLanguage();

        new Setting(this.containerEl).setName(t.settings.general.heading).setHeading();

        new Setting(this.containerEl)
            .setName(t.settings.general.showNotices)
            .setDesc(t.settings.general.showNoticesDesc)
            .addToggle((toggle) =>
                toggle.setValue(this.obsync.settings.showNotices).onChange(async (value) => {
                    this.obsync.settings.showNotices = value;
                    await this.commit();
                })
            );

        new Setting(this.containerEl)
            .setName(t.settings.general.debugLogging)
            .setDesc(t.settings.general.debugLoggingDesc)
            .addToggle((toggle) =>
                toggle.setValue(this.obsync.settings.debugLogging).onChange(async (value) => {
                    this.obsync.settings.debugLogging = value;
                    await this.commit();
                })
            );
    }

    private renderInstaller(): void {
        const t = this.obsync.t;
        const settings = this.obsync.settings.installer;

        new Setting(this.containerEl).setName(t.settings.installer.heading).setHeading();

        new Setting(this.containerEl)
            .setName(t.settings.installer.enabled)
            .setDesc(t.settings.installer.enabledDesc)
            .addToggle((toggle) =>
                toggle.setValue(settings.enabled).onChange(async (value) => {
                    settings.enabled = value;
                    await this.commit();
                })
            );

        new Setting(this.containerEl)
            .setName(t.settings.installer.autoCheck)
            .setDesc(t.settings.installer.autoCheckDesc)
            .addToggle((toggle) =>
                toggle.setValue(settings.autoCheckOnStartup).onChange(async (value) => {
                    settings.autoCheckOnStartup = value;
                    await this.commit();
                })
            );

        new Setting(this.containerEl)
            .setName(t.settings.installer.autoCheckOnSettingsOpen)
            .setDesc(t.settings.installer.autoCheckOnSettingsOpenDesc)
            .addToggle((toggle) =>
                toggle.setValue(settings.autoCheckOnSettingsOpen).onChange(async (value) => {
                    settings.autoCheckOnSettingsOpen = value;
                    await this.commit();
                })
            );

        new Setting(this.containerEl)
            .setName(t.settings.installer.autoCheckDelay)
            .setDesc(t.settings.installer.autoCheckDelayDesc)
            .addText((text) => {
                text.inputEl.type = "number";
                text.inputEl.min = "0";
                text.inputEl.max = "3600";
                text.setValue(String(settings.autoCheckDelaySeconds));
                // 启动检查关着时这项没有意义 —— 置灰比藏起来更少困惑（用户能看到它还在）。
                text.setDisabled(!settings.autoCheckOnStartup);
                text.onChange(async (value) => {
                    const parsed = Number.parseInt(value, 10);
                    if (!Number.isFinite(parsed)) return;
                    settings.autoCheckDelaySeconds = parsed;
                    await this.commit();
                });
            });

        new Setting(this.containerEl)
            .setName(t.settings.installer.mirrorDiscovery)
            .setDesc(t.settings.installer.mirrorDiscoveryDesc)
            .addToggle((toggle) =>
                toggle.setValue(settings.discoverGiteeMirrors).onChange(async (value) => {
                    settings.discoverGiteeMirrors = value;
                    await this.commit();
                })
            );

        // 令牌属于「怎么访问插件来源」的范畴，跟着安装器页走 ——
        // 列表与操作按钮已移到「已追踪插件」页。
        this.renderTokens();
    }

    private async checkAllUpdates(options: { quietWhenNone?: boolean } = {}): Promise<void> {
        const t = this.obsync.t;
        const tracked = this.obsync.settings.installer.tracked;

        if (tracked.length === 0) {
            if (!options.quietWhenNone) {
                this.obsync.notifier.info(t.settings.installer.trackedEmpty);
            }
            return;
        }

        try {
            const summary = await this.obsync.installer.checker.checkAll(tracked);
            if (summary.outdated === 0 && summary.failed === 0) {
                if (!options.quietWhenNone) {
                    this.obsync.notifier.success(t.installer.checkNone);
                }
                return;
            }
            this.obsync.notifier.info(t.installer.checkSummary(summary.outdated, summary.failed));
        } catch (err) {
            this.obsync.notifier.reportError(err, t.installer.checkFailed);
        } finally {
            // 徽标常驻在列表里（availableUpdates 已由 checkAll 落盘），重绘让它可见。
            this.display();
        }
    }

    private renderSync(): void {
        const t = this.obsync.t;

        new Setting(this.containerEl).setName(t.settings.sync.heading).setHeading();

        // 移动端没有系统 git，直接说明原因，而不是给一堆点了没用的控件。
        if (!this.obsync.isSyncAvailable) {
            this.containerEl.createEl("p", {
                cls: "setting-item-description",
                text: t.settings.sync.desktopOnly,
            });
            return;
        }

        const settings = this.obsync.settings.sync;

        new Setting(this.containerEl)
            .setName(t.settings.sync.enabled)
            .setDesc(t.settings.sync.enabledDesc)
            .addToggle((toggle) =>
                toggle.setValue(settings.enabled).onChange(async (value) => {
                    settings.enabled = value;
                    await this.commit();
                })
            );

        const intervals: Array<{
            name: string;
            desc: string;
            get: () => number;
            set: (value: number) => void;
        }> = [
            {
                name: t.settings.sync.autoCommit,
                desc: t.settings.sync.autoCommitDesc,
                get: () => settings.autoCommitMinutes,
                set: (value) => (settings.autoCommitMinutes = value),
            },
            {
                name: t.settings.sync.autoPush,
                desc: t.settings.sync.autoPushDesc,
                get: () => settings.autoPushMinutes,
                set: (value) => (settings.autoPushMinutes = value),
            },
            {
                name: t.settings.sync.autoPull,
                desc: t.settings.sync.autoPullDesc,
                get: () => settings.autoPullMinutes,
                set: (value) => (settings.autoPullMinutes = value),
            },
        ];

        for (const interval of intervals) {
            new Setting(this.containerEl)
                .setName(interval.name)
                .setDesc(interval.desc)
                .addText((text) => {
                    text.inputEl.type = "number";
                    text.inputEl.min = "0";
                    text.setValue(String(interval.get()));
                    text.onChange(async (value) => {
                        const parsed = Number.parseInt(value, 10);
                        if (!Number.isFinite(parsed)) return;
                        interval.set(parsed);
                        await this.commit();
                    });
                });
        }

        new Setting(this.containerEl)
            .setName(t.settings.sync.commitMessage)
            .setDesc(t.settings.sync.commitMessageDesc)
            .addText((text) =>
                text.setValue(settings.commitMessage).onChange(async (value) => {
                    settings.commitMessage = value;
                    await this.commit();
                })
            );

        new Setting(this.containerEl)
            .setName(t.settings.sync.strategy)
            .setDesc(t.settings.sync.strategyDesc)
            .addDropdown((dropdown) => {
                dropdown
                    .addOption("merge", t.settings.sync.strategyMerge)
                    .addOption("rebase", t.settings.sync.strategyRebase)
                    .addOption("reset", t.settings.sync.strategyReset);
                dropdown.setValue(settings.syncStrategy);
                dropdown.onChange(async (value) => {
                    settings.syncStrategy = value as typeof settings.syncStrategy;
                    await this.commit();
                });
            });

        new Setting(this.containerEl)
            .setName(t.settings.sync.gitPath)
            .setDesc(t.settings.sync.gitPathDesc)
            .addText((text) =>
                text
                    .setPlaceholder("C:\\Program Files\\Git\\cmd\\git.exe")
                    .setValue(settings.gitPath)
                    .onChange(async (value) => {
                        settings.gitPath = value.trim();
                        await this.commit();
                    })
            );
    }
}

/** 供测试与将来复用：从 app 构造设置页。 */
export function createSettingsTab(app: App, plugin: ObsyncPlugin): ObsyncSettingsTab {
    void app;
    return new ObsyncSettingsTab(plugin);
}
