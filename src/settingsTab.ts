import {
    PluginSettingTab,
    Setting,
    type App,
    type ButtonComponent,
    type TextComponent,
} from "obsidian";
import { LANGUAGE_OPTIONS, type LanguageSetting, type LocaleStrings } from "./core/i18n";
import { logger } from "./core/logger";
import type {
    DiagnosticCheck,
    DiagnosticsReport,
} from "./features/sync/types";
import { describeSelfState } from "./features/installer/selfUpdate";
import { shouldCheckOnSettingsOpen } from "./features/installer/updateChecker";
import type { SelfUpdateCheck } from "./features/installer/types";
import { renderTrackedItems } from "./features/installer/ui/TrackedItemsList";
import type ObsyncPlugin from "./main";
import { getHost } from "./host/hostRegistry";
import { SUPPORTED_HOSTS, type HostKind } from "./host/types";

/**
 * 设置页的四个标签页。
 *
 * 顺序即显示顺序。把「插件与主题」放第一页：用户进设置页多半是想看
 * 哪个有更新、或再装一个，而不是来调开关的。
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

    /**
     * 打开设置页时发现的「重复插件 id」条目（列表上方据此给出警告）。
     *
     * 实测坑：`plugins/` 里多出一份同 id 的残留备份，Obsidian 重启后加载了那份
     * 旧版本，而 OBSync 记录里还写着新版本 —— 更新检查永远报「已是最新」。
     * 这种状态只能靠人清理，所以必须摆到界面上，而不是只写进日志。
     */
    private duplicateFolders: Array<{ name: string; count: number }> = [];

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

        if (justOpened) {
            void this.autoCheckOnOpen();
            void this.reconcileOnOpen();
        }
    }

    /**
     * 打开设置页时用**磁盘上的事实**校正记录里的版本号。
     *
     * 记录里的 `installedVersion` 是装的那一刻的快照，之后被别的工具改过、被同步回来
     * 的旧文件覆盖过，它都不会知道 —— 于是更新检查拿着过期版本去比远端，永远报
     * 「已是最新」。这里顺手校正并告知用户（不静默改数据）。
     */
    private async reconcileOnOpen(): Promise<void> {
        const t = this.obsync.t;
        try {
            const { corrected, duplicated } =
                await this.obsync.installer.service.reconcileInstalledVersions();

            const duplicatesChanged =
                JSON.stringify(duplicated) !== JSON.stringify(this.duplicateFolders);
            this.duplicateFolders = duplicated;

            if (corrected.length > 0) {
                this.obsync.notifier.info(t.installer.versionCorrected(corrected.join("、")));
            }
            // 有变化才重绘：`display()` 这一次的 `justOpened` 已是 false，不会递归。
            if (corrected.length > 0 || duplicatesChanged) this.display();
        } catch (err) {
            // 校正失败不该影响设置页。
            logger.debug("could not reconcile installed versions", err);
        }
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
                text: `${updates}`,
                cls: "obsync-tab-count is-update",
            });
        }
    }

    /** 标签一：已跟踪的插件与主题 —— 头部栏（标题 + 说明 + 三个主操作）+ 列表。 */
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
                    // 装完立刻重绘列表 —— 否则新条目要等下一次「检查全部更新」
                    // 顺带的那次重绘才出现（用户以为没装上）。
                    .onClick(() => this.obsync.installer.openAddRepoModal(() => this.display()))
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
                    // 检查要逐个仓库打接口，可能好几秒 —— 得让用户知道在跑。
                    // 旁边的「测试」令牌按钮就是这么做的，保持一致。
                    button.setDisabled(true);
                    button.setButtonText(t.installer.checking);
                    try {
                        await this.checkAllUpdates();
                    } finally {
                        button.setDisabled(false);
                        button.setButtonText(t.installer.checkAll);
                    }
                })
            );

        // 重复 id 警告放在列表**上方**：它说的是「你看到的不一定是你跑的」，
        // 放在列表下面会被当成脚注忽略掉。
        for (const duplicate of this.duplicateFolders) {
            this.containerEl.createEl("p", {
                cls: "obsync-duplicate-warning",
                text: t.installer.duplicateFolders(duplicate.name, duplicate.count),
            });
        }

        renderTrackedItems(this.containerEl, {
            app: this.obsync.app,
            t,
            service: this.obsync.installer.service,
            checker: this.obsync.installer.checker,
            getTracked: () => this.obsync.settings.installer.tracked,
            // 键是 `<kind>:<id>`（见 availableUpdateKey）—— 插件 id 与主题目录名
            // 是两个命名空间，用裸 id 会让两者互相覆盖。
            getUpdateFor: (key) => this.obsync.settings.installer.availableUpdates[key],
            // 疑似镜像的提议：**列出来等用户确认**，绝不自动采用（见
            // installer.mirrorSuggestions 的注释与 ConfirmMirrorModal 的警告）。
            getMirrorSuggestion: (key) =>
                this.obsync.settings.installer.mirrorSuggestions[key],
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

        // 由 `SUPPORTED_HOSTS` 驱动 —— 之前是两个写死的平台名，
        // 加平台时这里会静默漏掉一个输入框。
        for (const host of SUPPORTED_HOSTS) this.renderTokenField(host);
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

        new Setting(this.containerEl)
            .setName(t.settings.general.statusBarFullWidth)
            .setDesc(t.settings.general.statusBarFullWidthDesc)
            .addToggle((toggle) =>
                toggle
                    .setValue(this.obsync.settings.statusBarFullWidth)
                    .onChange(async (value) => {
                        this.obsync.settings.statusBarFullWidth = value;
                        // `commit()` → `applyDerivedSettings()` → 给 body 加/摘那个类，
                        // 所以拨开关是**立刻**生效的（不用重载插件、也不用重开设置页）。
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

        // 「启动检查」关着时延迟项没有意义 —— 置灰比藏起来更少困惑（用户能看到它还在）。
        // 但置灰状态必须跟着开关**即时**变：只在渲染时算一次的话，
        // 用户打开开关后会发现下面的输入框还是灰的，得切走再切回来。
        let delayField: TextComponent | undefined;

        new Setting(this.containerEl)
            .setName(t.settings.installer.autoCheck)
            .setDesc(t.settings.installer.autoCheckDesc)
            .addToggle((toggle) =>
                toggle.setValue(settings.autoCheckOnStartup).onChange(async (value) => {
                    settings.autoCheckOnStartup = value;
                    delayField?.setDisabled(!value);
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
                delayField = text;
                text.inputEl.type = "number";
                text.inputEl.min = "0";
                text.inputEl.max = "3600";
                text.setValue(String(settings.autoCheckDelaySeconds));
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

        // OBSync 自身放在本页最后：它是自举用的，与「装别的插件」不是一类事，
        // 但同属「来源与版本」的范畴（跟踪列表那边是「用户装了什么」，自己不在其中）。
        this.renderSelfUpdate();

        // 令牌属于「怎么访问插件来源」的范畴，跟着安装器页走 ——
        // 列表与操作按钮已移到「已追踪插件」页。
        this.renderTokens();
    }

    /**
     * 「OBSync 自身」一节：检查更新 + 更新 + 一行状态。
     *
     * 状态行由 `describeSelfState` 拼（纯函数，单测覆盖）—— 这里只负责在合适的
     * 时机重绘它：**不能**用 `this.display()` 重绘整页来刷新状态，那会把用户
     * 正在看的滚动位置与焦点一起丢掉（`AddRepoModal` 的按钮可用性踩过同一个坑）。
     */
    private renderSelfUpdate(): void {
        const t = this.obsync.t;
        const currentVersion = this.obsync.manifest.version;

        let check: SelfUpdateCheck | undefined;
        let busy: "checking" | "updating" | undefined;
        let checkButton: ButtonComponent | undefined;
        let updateButton: ButtonComponent | undefined;
        let status: HTMLElement | undefined;

        const renderStatus = (): void => {
            status?.setText(
                describeSelfState(
                    {
                        currentVersion,
                        check,
                        pendingRestartVersion:
                            this.obsync.settings.installer.pendingRestartVersion,
                        busy,
                    },
                    t
                )
            );
        };

        const setBusy = (value: "checking" | "updating" | undefined): void => {
            busy = value;
            checkButton?.setDisabled(value !== undefined);
            updateButton?.setDisabled(value !== undefined);
            renderStatus();
        };

        new Setting(this.containerEl)
            .setName(t.settings.installer.selfHeading)
            .setDesc(t.settings.installer.selfDesc)
            .addButton((button) => {
                checkButton = button;
                return button.setButtonText(t.installer.checkOne).onClick(async () => {
                    setBusy("checking");
                    try {
                        check = await this.obsync.installer.checker.checkSelf(currentVersion);
                    } finally {
                        setBusy(undefined);
                    }
                });
            })
            .addButton((button) => {
                updateButton = button;
                return button
                    .setButtonText(t.installer.updateToLatest)
                    .onClick(async () => {
                        setBusy("updating");
                        try {
                            const result = await this.obsync.installer.service.updateSelf(
                                currentVersion
                            );
                            this.obsync.notifier.success(
                                t.installer.selfUpdateDone(result.version)
                            );
                            // 检查结果作废：磁盘上已经是那个版本了，接下来该显示的是
                            // 「待重启」（由 pendingRestartVersion 驱动，重启后自动消失）。
                            check = undefined;
                        } catch (err) {
                            this.obsync.notifier.reportError(err, t.installer.selfUpdateFailed);
                        } finally {
                            setBusy(undefined);
                        }
                    });
            });

        // 状态行放在按钮行下方 —— 先渲染 Setting 再创建它，保证顺序。
        status = this.containerEl.createEl("p", { cls: "setting-item-description" });
        renderStatus();
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

        // 注意事项：放在标题正下方，而不是塞进各设置项的描述里。
        // 两条都是**组合条件**才踩得到的坑（策略选「重置」+ 开着自动同步；
        // 多设备同时编辑同一个文件），写进单项描述没人读得到 ——
        // 用户是在配好之后才出问题，那时早就不翻设置了。
        const notes = this.containerEl.createDiv({ cls: "obsync-sync-notes" });
        notes.createDiv({ cls: "obsync-sync-notes-heading", text: t.settings.sync.notesHeading });
        const noteList = notes.createEl("ul");
        for (const note of t.settings.sync.notes) {
            noteList.createEl("li", { text: note });
        }

        const settings = this.obsync.settings.sync;

        /**
         * 策略为「重置」时把总开关灰掉。
         *
         * 真正的拦截在 `Automatics.start()`（那里读同一个字段），这里只是
         * **说明** —— 只灰不说，用户会以为插件坏了。
         *
         * 开关的**值**刻意不动：用户改回「合并」后自动恢复，不用重新拨一次。
         */
        const suspended = settings.syncStrategy === "reset";

        new Setting(this.containerEl)
            .setName(t.settings.sync.enabled)
            .setDesc(
                suspended ? t.settings.sync.enabledSuspendedByReset : t.settings.sync.enabledDesc
            )
            .addToggle((toggle) =>
                toggle
                    .setValue(settings.enabled)
                    .setDisabled(suspended)
                    .onChange(async (value) => {
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
                    // 必须重绘：策略决定上面那个总开关是否可用（见 `suspended`）。
                    // 不重绘的话，用户切到「重置」后开关看起来还是能拨的 ——
                    // 而实际行为已经停了，那比不灰掉更让人困惑。
                    await this.commit(true);
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

        this.renderDiagnostics();
    }

    /**
     * 连接测试。
     *
     * 存在的理由：**鉴权配得对不对，光看设置项判断不了** —— 令牌填了不代表有效，
     * 只有真的去连一次才有答案。而这个按钮就是「真的去连一次」。
     *
     * 放在同步设置的最后：用户配完远端与令牌，顺手就能验一下。
     */
    private renderDiagnostics(): void {
        const t = this.obsync.t;
        const sync = this.obsync.sync;
        if (!sync) return;

        new Setting(this.containerEl).setName(t.sync.diagnoseHeading).setHeading();
        this.containerEl.createEl("p", {
            cls: "setting-item-description",
            text: t.sync.diagnoseDesc,
        });

        const resultEl = this.containerEl.createDiv({ cls: "obsync-diagnostics" });

        new Setting(this.containerEl).addButton((button) =>
            button
                .setButtonText(t.sync.diagnoseRun)
                .setCta()
                .onClick(async () => {
                    button.setDisabled(true);
                    button.setButtonText(t.sync.diagnoseRunning);
                    resultEl.empty();
                    try {
                        this.renderDiagnosticsResult(resultEl, await sync.service.diagnose());
                    } catch (err) {
                        // diagnose 内部已经把每一步的失败收进报告了，走到这里说明
                        // 是意料之外的异常（比如 statusBar 渲染崩了）。
                        this.obsync.notifier.reportError(err, t.sync.diagnoseHasFailures);
                    } finally {
                        button.setDisabled(false);
                        button.setButtonText(t.sync.diagnoseRun);
                    }
                })
        );
    }

    private renderDiagnosticsResult(
        container: HTMLElement,
        report: DiagnosticsReport
    ): void {
        const t = this.obsync.t;

        container.createEl("p", {
            text: report.ok ? t.sync.diagnoseAllPassed : t.sync.diagnoseHasFailures,
            cls: report.ok ? "obsync-diag-ok" : "obsync-diag-failed",
        });

        // 通过时**必须**说清验到了哪一步。否则「全部通过」会被读成
        // 「推送也没问题」，而这个检查走的是 ls-remote —— 推送路径根本不在范围内
        // （实测：Gitee 的凭据用户名规则只在 push 路径执行，这里发现不了）。
        // 失败时不显示：那时用户手上已经有待处理的条目了。
        if (report.ok) {
            container.createEl("p", {
                text: t.sync.diagnoseScopeNote,
                cls: "obsync-diag-skipped",
            });
        }

        const list = container.createEl("ul", { cls: "obsync-diag-list" });
        for (const check of report.checks) {
            const mark = check.status === "ok" ? "✓" : check.status === "failed" ? "✗" : "–";
            // 类名写成显式字面量而不是模板串拼接：拼出来的类名 grep 不到，
            // 项目自查（scripts/checks.mjs）会把它们报成「定义了没用到」。
            const cls =
                check.status === "ok"
                    ? "obsync-diag-ok"
                    : check.status === "failed"
                      ? "obsync-diag-failed"
                      : "obsync-diag-skipped";
            const item = list.createEl("li", { cls });
            item.createSpan({ text: `${mark} ${t.sync.diagnoseCheck[check.id]}：` });
            item.createSpan({ text: describeCheck(check, t) });
        }
    }
}

/** 把一项检查渲染成用户能看懂的一句话。 */
function describeCheck(check: DiagnosticCheck, t: LocaleStrings): string {
    const d = t.sync.diagnoseDetail;
    const detail = check.detail ?? "";

    switch (check.id) {
        case "git":
            return check.status === "ok" ? d.gitOk : d.gitFailed(detail);
        case "repo":
            return check.status === "ok" ? d.repoOk : d.repoFailed;
        case "remote":
            return check.status === "ok" ? d.remoteOk(detail) : d.remoteFailed;
        case "platform":
            if (check.status === "ok") return d.platformOk(detail);
            // skipped 且带 detail = 平台认得出但没配令牌；不带 = 平台认不出
            return detail ? d.platformNoToken(detail) : d.platformUnknown;
        case "access":
            return check.status === "ok" ? d.accessOk(detail) : detail;
    }
}

/** 供测试与将来复用：从 app 构造设置页。 */
export function createSettingsTab(app: App, plugin: ObsyncPlugin): ObsyncSettingsTab {
    void app;
    return new ObsyncSettingsTab(plugin);
}
