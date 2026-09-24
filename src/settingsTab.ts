import {
    PluginSettingTab,
    Setting,
    type App,
    type ButtonComponent,
    type TextComponent,
} from "obsidian";
import { LANGUAGE_OPTIONS, type LanguageSetting, type LocaleStrings } from "./core/i18n";
import { logger } from "./core/logger";
import { DEFAULT_SETTINGS } from "./core/settings";
import { formatFolders, normalizeFolders, parseFolders } from "./features/images/imageScan";
import { FolderSuggestModal } from "./features/images/ui/FolderSuggestModal";
import type { ImageSyncService } from "./features/images/imageSyncService";
import type { SyncPlan, SyncSummary } from "./features/images/types";
import type {
    DiagnosticCheck,
    DiagnosticsReport,
} from "./features/sync/types";
import { describeSelfState, resolveSelfRepo } from "./features/installer/selfUpdate";
import { shouldCheckOnSettingsOpen } from "./features/installer/updateChecker";
import type { SelfUpdateCheck } from "./features/installer/types";
import { renderTrackedItems } from "./features/installer/ui/TrackedItemsList";
import type ObsyncPlugin from "./main";
import { getHost } from "./host/hostRegistry";
import { SUPPORTED_HOSTS, type HostKind } from "./host/types";

/**
 * 设置页的五个标签页。
 *
 * 顺序即显示顺序。把「插件与主题」放第一页：用户进设置页多半是想看
 * 哪个有更新、或再装一个，而不是来调开关的。
 *
 * 「图片同步」紧跟在「仓库同步」后面：两者都是「把库里的东西同步到远端」，
 * 用户找它们时的心智是连着的 —— 中间插一个「通用」会让它变得难找。
 */
type SettingsTabId = "tracked" | "installer" | "sync" | "images" | "general";

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
     * 旧版本，而 SyncHub 记录里还写着新版本 —— 更新检查永远报「已是最新」。
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
            case "images":
                this.renderImages();
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
            { id: "images", label: t.settings.tabs.images },
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

        // SyncHub 自身放在本页最后：它是自举用的，与「装别的插件」不是一类事，
        // 但同属「来源与版本」的范畴（跟踪列表那边是「用户装了什么」，自己不在其中）。
        this.renderSelfUpdate();

        // 令牌属于「怎么访问插件来源」的范畴，跟着安装器页走 ——
        // 列表与操作按钮已移到「已追踪插件」页。
        this.renderTokens();
    }

    /**
     * 「SyncHub 自身」一节：检查更新 + 更新 + 一行状态。
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
                        // 检查也要走**同一个来源** —— 否则会出现「检查说没有更新、
                        // 更新却从另一个仓库拉」这种自相矛盾（`updateSelf` 内部同样读这个设置）。
                        check = await this.obsync.installer.checker.checkSelf(
                            currentVersion,
                            resolveSelfRepo(this.obsync.settings.installer.selfUpdateSource)
                        );
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

        /**
         * 自身更新的**来源**。
         *
         * 放在按钮行下面而不是上面：它是「不常改、改了就一直生效」的配置，而上面那两个
         * 按钮是每次发新版都要点的动作 —— 先把常用动作给出来。
         *
         * 留空 = 官方仓库（`selfUpdate.ts` 的 `SELF_REPO`）；填了就用它，**不再探测镜像**。
         * 这与「Gitee 镜像发现」是两回事：那套是自动探测 + 只提议 + 要用户确认，每次都要
         * 探一遍；这里是用户写下的固定来源。
         */
        new Setting(this.containerEl)
            .setName(t.settings.installer.selfSource)
            .setDesc(t.settings.installer.selfSourceDesc)
            .addText((text) =>
                text
                    .setPlaceholder(t.settings.installer.selfSourcePlaceholder)
                    .setValue(this.obsync.settings.installer.selfUpdateSource)
                    .onChange(async (value) => {
                        this.obsync.settings.installer.selfUpdateSource = value.trim();
                        await this.commit();
                    })
            );
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

        this.renderGitignore();

        this.renderDiagnostics();
    }

    /**
     * `.gitignore` 一节：**在这里直接改内容**，不用另开编辑器。
     *
     * ## 为什么值得放进设置页
     *
     * `.gitignore` 不是「一个顺带的文件」，它是同步行为的一部分：哪些文件根本
     * 不会进版本控制由它决定（`workspace.json` 那种每次开关标签都会变的文件，
     * 不同步它是避免多设备冲突的关键）。而此前唯一的入口是命令面板里的
     * 「编辑 .gitignore」——**只有已经知道有这个功能的人才找得到**。
     *
     * 更要紧的是「看得见」：用户配好之后最想确认的一件事是
     * 「`workspace.json` 到底排除了没有」，而那需要把内容显示出来。
     *
     * ## 落盘时机
     *
     * 失焦落盘 + 一个显式的「保存」按钮。理由与令牌那一行不同（那里是密钥），
     * 但同源：**每敲一个键就写一次文件**会让 git 在用户还在打字的中间态上做判断
     * （`.gitignore` 一改，面板上的改动列表立刻就变）。失焦保存保证「点到别处
     * 不会丢」，显式按钮保证「我知道什么时候写下去了」。
     *
     * 文件不存在时**不自动创建**（`readGitignore` 的说明）：设置页只是被打开一下，
     * 不该因此往用户库里多出一个文件。要建就点「填入默认内容」再保存。
     */
    private renderGitignore(): void {
        const t = this.obsync.t;
        const sync = this.obsync.sync;
        if (!sync) return;

        const heading = new Setting(this.containerEl)
            .setName(t.settings.sync.gitignoreHeading)
            .setHeading();
        this.containerEl.createEl("p", {
            cls: "setting-item-description",
            text: t.settings.sync.gitignoreDesc,
        });

        // 状态徽标：用户最需要一眼确认的两件事 —— 磁盘上有没有这个文件、
        // 框里的改动写下去了没有。
        const statusEl = heading.nameEl.createSpan({ cls: "obsync-badge" });

        /** 框里的内容（内存暂存）。 */
        let pending = "";
        let dirty = false;
        let created = false;
        let saving = false;
        let saveButton: ButtonComponent | undefined;

        const refreshStatus = (): void => {
            statusEl.setText(
                saving
                    ? t.settings.sync.gitignoreSaving
                    : dirty
                      ? t.settings.sync.gitignoreDirty
                      : created
                        ? t.settings.sync.gitignoreSaved
                        : t.settings.sync.gitignoreMissing
            );
            statusEl.toggleClass("obsync-badge-update", dirty && !saving);
            statusEl.toggleClass("obsync-badge-ok", !dirty && created);
            statusEl.toggleClass("obsync-badge-muted", !dirty && !created);
            // 没有未保存的改动时按钮置灰：点了什么都不发生，只会让人怀疑它坏了。
            // 保存中也要灰 —— 写盘走同步队列，前面排着一个拉取时可能等几秒。
            saveButton?.setDisabled(saving || !dirty);
        };

        /**
         * 写下去。
         *
         * `announce` 只给显式点「保存」用 —— 失焦保存如果每次都弹一条提示，
         * 用户每点一下别处就被打扰一次；那时徽标从「有未保存的修改」翻成
         * 「已保存」本身就是反馈。
         */
        const save = async (announce: boolean): Promise<void> => {
            if (!dirty || saving) return;
            const value = pending;
            saving = true;
            refreshStatus();
            try {
                await sync.service.writeGitignore(value);
                // 只在内容没被继续改动时才清掉「未保存」：写盘期间用户接着敲的字
                // 不在刚写下去的那一份里，标成已保存就是撒谎。
                if (pending === value) dirty = false;
                created = true;
                if (announce) {
                    this.obsync.notifier.success(t.settings.sync.gitignoreSavedNotice);
                }
            } catch (err) {
                // 失败必须说清「磁盘上还是旧内容」：用户以为自己改了，
                // 而 git 那边一点变化都没有。
                this.obsync.notifier.reportError(err, t.settings.sync.gitignoreSaveFailed);
            } finally {
                saving = false;
                refreshStatus();
            }
        };

        /**
         * 代码框**直接挂在页面上**，不是某个 `Setting` 的控件。
         *
         * 放进 `.setting-item-control` 的话，它只会拿到右侧那几百像素宽 ——
         * 那是 Obsidian 给「一个下拉 / 一个输入框」留的宽度，而 12 行的规则清单
         * 挤在里面根本没法读。块级元素在块级容器里天然就是全宽，
         * 不依赖 Obsidian 设置页的 flex 细节（那些规则没有公开承诺）。
         */
        const areaEl = this.containerEl.createEl("textarea", { cls: "obsync-gitignore" });
        // 一行一条规则，12 行够看清一整套排除规则（模板大约 20 行，滚动即可）。
        areaEl.rows = 12;
        // 示例值用**本库的配置目录名**（可以不是 `.obsidian`）——
        // 写死的话用户在自定义配置目录的库里会照着填错。
        areaEl.placeholder = `${this.obsync.app.vault.configDir}/workspace.json`;
        areaEl.spellcheck = false;
        areaEl.value = pending;
        /**
         * 宽度与 `box-sizing` **只在 `styles.css` 里写**（`.obsync-gitignore`），
         * 这里刻意不碰 `areaEl.style`：
         *
         * 社区审核的 `obsidianmd/no-static-styles-assignment` 禁止直接写内联样式 ——
         * 而且 `setCssProps({ width: "100%" })` 同样会被判违规（那条规则只放行
         * `--*` 自定义属性）。静态宽度本来就该待在类里，动态值才需要 `setCssProps`。
         *
         * 于是这一格的全宽完全依赖样式表 —— 配套前提是**插件目录里有 `.hotreload`
         * 标记**（Hot Reload 才会在 styles.css 变化时重载插件）。没有那个标记时，
         * 「改了 CSS 看不到效果」会被误当成「宽度没生效」。
         */
        areaEl.addEventListener("input", () => {
            pending = areaEl.value;
            dirty = true;
            refreshStatus();
        });
        // 失焦也保存 —— 点到别处不会丢
        areaEl.addEventListener("blur", () => void save(false));

        // 按钮另起一行：三个按钮挤在代码框旁边只会互相压扁
        // （与图片同步页的文件夹选择入口同一个形状）。
        //
        // `obsync-gitignore-actions` 让按钮**贴左**：代码框是全宽的，而这一行
        // 没有名称/描述，Obsidian 默认会把控件推到最右 —— 那会离框太远，
        // 看不出这三个按钮是给上面那个框用的。
        new Setting(this.containerEl)
            .setClass("obsync-gitignore-actions")
            .addButton((button) => {
                saveButton = button;
                return button
                    .setButtonText(t.settings.sync.gitignoreSave)
                    .setCta()
                    .setDisabled(true)
                    .onClick(() => void save(true));
            })
            .addButton((button) =>
                button
                    .setButtonText(t.settings.sync.gitignoreRestore)
                    // 只**填进框里**，不直接写盘：覆盖掉用户自己的规则是数据损失，
                    // 让他先看一眼再决定要不要保存。
                    .onClick(() => {
                        pending = t.sync.gitignoreTemplate(this.obsync.app.vault.configDir);
                        dirty = true;
                        areaEl.value = pending;
                        refreshStatus();
                    })
            )
            .addButton((button) =>
                button.setButtonText(t.settings.sync.gitignoreOpen).onClick(async () => {
                    try {
                        if (!(await sync.service.openGitignore())) {
                            // 点了一个按钮什么也没发生是最容易被当成「插件坏了」
                            // 的一种失败 —— 说清发生了什么，并指向上面那个框。
                            this.obsync.notifier.warn(t.sync.gitignoreOpenFailed);
                        }
                    } catch (err) {
                        this.obsync.notifier.reportError(err);
                    }
                })
            );

        refreshStatus();

        // 读内容要 await，而渲染是同步的 —— 先把框画出来，读到了再填。
        void (async () => {
            try {
                const content = await sync.service.readGitignore();
                // 用户可能在读盘那几百毫秒里已经动手了 —— 别把输入盖掉。
                if (content !== undefined && !dirty) {
                    created = true;
                    pending = content;
                    areaEl.value = content;
                }
            } catch (err) {
                // 读不出来不该让整页崩：徽标留在「尚未创建」，用户仍然可以写一份新的。
                logger.debug("could not read .gitignore", err);
            }
            refreshStatus();
        })();
    }

    /**
     * 标签四：图片同步（R2 双副本）。
     *
     * 与「仓库同步」页同构：标题 → 注意事项 → 设置项 → 操作与结果。
     * 差别在注意事项的分量 —— 那页的坑是「数据可能丢」，这页的坑是
     * 「文件可能被**删掉**」，所以三条提示必须留在最上方，不能塞进单项描述。
     */
    private renderImages(): void {
        const t = this.obsync.t;
        const images = this.obsync.settings.images;
        const service = this.obsync.images?.service;

        new Setting(this.containerEl).setName(t.settings.images.heading).setHeading();

        const notes = this.containerEl.createDiv({ cls: "obsync-image-notes" });
        notes.createDiv({
            cls: "obsync-image-notes-heading",
            text: t.settings.images.notesHeading,
        });
        const noteList = notes.createEl("ul");
        for (const note of t.settings.images.notes) {
            noteList.createEl("li", { text: note });
        }

        new Setting(this.containerEl)
            .setName(t.settings.images.enabled)
            .setDesc(t.settings.images.enabledDesc)
            .addToggle((toggle) =>
                toggle.setValue(images.enabled).onChange(async (value) => {
                    images.enabled = value;
                    // 不重绘：这一页没有「可用性由 enabled 决定」的控件。
                    // 定时器在**逻辑层**读同一个字段（features/images/index.ts），
                    // 所以这里不需要额外做什么，拨完即生效。
                    await this.commit();
                })
            );

        new Setting(this.containerEl)
            .setName(t.settings.images.folders)
            .setDesc(t.settings.images.foldersDesc)
            .addTextArea((area) => {
                area.inputEl.rows = 3;
                area.setPlaceholder(t.settings.images.foldersPlaceholder);
                // 空串（整个库）显示成 `.`：一个空行读起来像「什么都没填」，
                // 而它正是默认值（见 formatFolderPath）。
                area.setValue(formatFolders(images.folders));
                area.onChange(async (value) => {
                    // 拆行 + 丢空行 + 归一都在 parseFolders 里：`/attachments/` 与
                    // `attachments` 必须变成同一个值，否则范围判断会悄悄失准；
                    // 而空行必须在这里丢 —— 进了 normalizeFolders 就会被当成
                    // 「整个库」（见那边的说明）。
                    images.folders = parseFolders(value);
                    await this.commit();
                });
            });

        if (images.folders.length === 0) {
            this.containerEl.createEl("p", {
                cls: "setting-item-description",
                text: t.settings.images.foldersEmpty,
            });
        }

        // 选择入口与「恢复默认」。
        //
        // 单独一行而不是塞进上面那一行：`.setting-item-control` 是 flex 且默认
        // 不换行（见 styles.css 里 obsync-actions 的注释），一个三行高的文本框
        // 再并两个按钮只会互相压扁。与页面底部那排「测试 / 预览 / 立即同步」
        // 同一形状 —— 无名称的设置行。
        new Setting(this.containerEl)
            .addButton((button) =>
                button.setButtonText(t.settings.images.foldersBrowse).onClick(() => {
                    new FolderSuggestModal(this.obsync.app, t, images.folders, (folder) => {
                        images.folders = normalizeFolders([...images.folders, folder]);
                        // 重绘：文本框要立刻显示新加的那一行（否则用户以为没选上），
                        // 「还没有指定文件夹」那行提示也要跟着消失。
                        void this.commit(true);
                    }).open();
                })
            )
            .addButton((button) =>
                button
                    .setButtonText(t.settings.images.foldersReset)
                    // 已经是默认值就置灰：点了什么都不发生，只会让人怀疑按钮是坏的。
                    // 置灰而不改值 —— 与仓库同步页的总开关同一个道理。
                    .setDisabled(isDefaultFolders(images.folders))
                    .onClick(async () => {
                        images.folders = normalizeFolders([...DEFAULT_SETTINGS.images.folders]);
                        await this.commit(true);
                    })
            );

        // ── 连接 ──
        new Setting(this.containerEl).setName(t.settings.images.connectionHeading).setHeading();

        new Setting(this.containerEl)
            .setName(t.settings.images.accountId)
            .setDesc(t.settings.images.accountIdDesc)
            .addText((text) =>
                text
                    .setPlaceholder(t.settings.images.accountIdPlaceholder)
                    .setValue(images.accountId)
                    .onChange(async (value) => {
                        images.accountId = value.trim();
                        await this.commit();
                    })
            );

        new Setting(this.containerEl)
            .setName(t.settings.images.bucket)
            .setDesc(t.settings.images.bucketDesc)
            .addText((text) =>
                text.setValue(images.bucket).onChange(async (value) => {
                    images.bucket = value.trim();
                    await this.commit();
                })
            );

        new Setting(this.containerEl)
            .setName(t.settings.images.accessKeyId)
            .setDesc(t.settings.images.accessKeyIdDesc)
            .addText((text) =>
                text.setValue(images.accessKeyId).onChange(async (value) => {
                    images.accessKeyId = value.trim();
                    await this.commit();
                })
            );

        this.renderR2Secret();

        new Setting(this.containerEl)
            .setName(t.settings.images.prefix)
            .setDesc(t.settings.images.prefixDesc)
            .addText((text) =>
                text
                    // 刻意**不给占位符**：示例值（对象键前缀）大小写敏感，而审核的
                    // `ui/sentence-case` 会把它报成「应为 'Images'」——照着改会让用户
                    // 填出一个不对的前缀。示例已经在描述里（「例如 images」）。
                    .setValue(images.prefix)
                    .onChange(async (value) => {
                        images.prefix = value.trim();
                        await this.commit();
                    })
            );

        new Setting(this.containerEl)
            .setName(t.settings.images.publicBaseUrl)
            .setDesc(t.settings.images.publicBaseUrlDesc)
            .addText((text) =>
                text
                    .setPlaceholder("https://img.example.com")
                    .setValue(images.publicBaseUrl)
                    .onChange(async (value) => {
                        images.publicBaseUrl = value.trim();
                        await this.commit();
                    })
            );

        // ── 冲突与删除 ──
        new Setting(this.containerEl).setName(t.settings.images.conflictHeading).setHeading();

        new Setting(this.containerEl)
            .setName(t.settings.images.conflictPolicy)
            .setDesc(t.settings.images.conflictPolicyDesc)
            .addDropdown((dropdown) => {
                dropdown
                    .addOption("newer", t.settings.images.conflictNewer)
                    .addOption("local", t.settings.images.conflictLocal)
                    .addOption("remote", t.settings.images.conflictRemote);
                dropdown.setValue(images.conflictPolicy);
                dropdown.onChange(async (value) => {
                    images.conflictPolicy = value as typeof images.conflictPolicy;
                    await this.commit();
                });
            });

        new Setting(this.containerEl)
            .setName(t.settings.images.deleteRemotePolicy)
            .setDesc(t.settings.images.deleteRemotePolicyDesc)
            .addDropdown((dropdown) => {
                dropdown
                    .addOption("ask", t.settings.images.deleteRemoteAsk)
                    .addOption("always", t.settings.images.deleteRemoteAlways)
                    .addOption("never", t.settings.images.deleteRemoteNever);
                dropdown.setValue(images.deleteRemotePolicy);
                dropdown.onChange(async (value) => {
                    images.deleteRemotePolicy = value as typeof images.deleteRemotePolicy;
                    await this.commit();
                });
            });

        new Setting(this.containerEl)
            .setName(t.settings.images.autoSync)
            .setDesc(t.settings.images.autoSyncDesc)
            .addText((text) => {
                text.inputEl.type = "number";
                text.inputEl.min = "0";
                text.setValue(String(images.autoSyncMinutes));
                text.onChange(async (value) => {
                    const parsed = Number.parseInt(value, 10);
                    if (!Number.isFinite(parsed)) return;
                    images.autoSyncMinutes = parsed;
                    await this.commit();
                });
            });

        // ── 裁剪与压缩的默认值 ──
        new Setting(this.containerEl).setName(t.settings.images.compressHeading).setHeading();

        new Setting(this.containerEl)
            .setName(t.settings.images.compressQuality)
            .setDesc(t.settings.images.compressQualityDesc)
            .addText((text) => {
                text.inputEl.type = "number";
                text.inputEl.min = "10";
                text.inputEl.max = "100";
                text.setValue(String(images.compressQuality));
                text.onChange(async (value) => {
                    const parsed = Number.parseInt(value, 10);
                    if (!Number.isFinite(parsed)) return;
                    images.compressQuality = parsed;
                    await this.commit();
                });
            });

        new Setting(this.containerEl)
            .setName(t.settings.images.compressMaxEdge)
            .setDesc(t.settings.images.compressMaxEdgeDesc)
            .addText((text) => {
                text.inputEl.type = "number";
                text.inputEl.min = "0";
                text.setValue(String(images.compressMaxEdge));
                text.onChange(async (value) => {
                    const parsed = Number.parseInt(value, 10);
                    images.compressMaxEdge = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
                    await this.commit();
                });
            });

        new Setting(this.containerEl)
            .setName(t.settings.images.compressFormat)
            .setDesc(t.settings.images.compressFormatDesc)
            .addDropdown((dropdown) => {
                for (const format of ["keep", "jpeg", "webp", "png"] as const) {
                    dropdown.addOption(format, t.images.formatOption[format]);
                }
                dropdown.setValue(images.compressFormat);
                dropdown.onChange(async (value) => {
                    images.compressFormat = value as typeof images.compressFormat;
                    await this.commit();
                });
            });

        // ── 操作 ──
        new Setting(this.containerEl).setName(t.settings.images.actionsHeading).setHeading();

        if (!service) {
            // 装配层没给出服务（理论上不会发生）—— 说明白，而不是给一堆点了没反应的按钮。
            this.containerEl.createEl("p", {
                cls: "setting-item-description",
                text: t.images.notice.notConfigured,
            });
            return;
        }

        const resultEl = this.containerEl.createDiv({ cls: "obsync-diagnostics" });

        // 图片管理标签页的入口。挂在这里而不是只留命令面板：设置页是用户排查
        // 「我库里这些图到底是什么状态」时的必经之路，而命令面板只有**已经知道
        // 有这个功能**的人才找得到。
        new Setting(this.containerEl)
            .setName(t.settings.images.openManager)
            .setDesc(t.settings.images.openManagerDesc)
            .addButton((button) =>
                button.setButtonText(t.settings.images.openManager).onClick(() => {
                    void this.obsync.openImageManager();
                })
            );

        this.renderImageActions(resultEl, service);
    }

    /**
     * R2 的 Secret Access Key。
     *
     * 与平台令牌同一套做法（内存暂存 + 失焦落盘 + 状态徽标），但多一个「保存」按钮：
     * 这个字段没有「测试」可以顺带触发落盘，而用户粘完密钥之后最常见的动作是
     * 直接去点下面的「测试连接」—— 那时如果还没落盘，测的就是**旧值**，
     * 报出来的错会让人去怀疑一个根本没被使用的密钥。
     */
    private renderR2Secret(): void {
        const t = this.obsync.t;
        const label = t.settings.images.secretKey;

        let pending = this.obsync.secretStore.getSecretValue("r2") ?? "";
        let statusEl: HTMLElement | undefined;

        const refreshStatus = (): void => {
            if (!statusEl) return;
            const configured = pending.trim().length > 0;
            statusEl.setText(
                configured
                    ? t.settings.images.secretConfigured
                    : t.settings.images.secretNotConfigured
            );
            statusEl.toggleClass("obsync-badge-ok", configured);
            statusEl.toggleClass("obsync-badge-muted", !configured);
        };

        const setting = new Setting(this.containerEl)
            .setName(label)
            .setDesc(t.settings.images.secretKeyDesc)
            .addText((text) => {
                text.inputEl.type = "password";
                text.inputEl.autocomplete = "off";
                text.inputEl.spellcheck = false;
                text.setPlaceholder(t.settings.images.secretPlaceholder);
                text.setValue(pending);
                text.onChange((value) => {
                    pending = value;
                });
            })
            .addButton((button) =>
                button.setButtonText(t.settings.images.secretSave).onClick(() => {
                    this.obsync.secretStore.setSecretValue("r2", pending);
                    refreshStatus();
                    this.obsync.notifier.success(t.settings.images.secretSaved);
                })
            )
            .addExtraButton((button) =>
                button
                    .setIcon("trash")
                    .setTooltip(t.settings.images.secretClear)
                    .onClick(() => {
                        this.obsync.secretStore.clearSecretValue("r2");
                        pending = "";
                        setting.settingEl.empty();
                        this.display();
                        this.obsync.notifier.info(t.settings.images.secretCleared);
                    })
            );

        statusEl = setting.nameEl.createSpan({ cls: "obsync-badge" });
        refreshStatus();
    }

    /** 三个操作按钮 + 结果区。 */
    private renderImageActions(resultEl: HTMLElement, service: ImageSyncService): void {
        const t = this.obsync.t;

        new Setting(this.containerEl)
            .addButton((button) =>
                button.setButtonText(t.settings.images.test).onClick(async () => {
                    button.setDisabled(true);
                    button.setButtonText(t.settings.images.testing);
                    resultEl.empty();
                    try {
                        const result = await service.testConnection();
                        if (result.ok) {
                            resultEl.createEl("p", {
                                cls: "obsync-diag-ok",
                                text: t.settings.images.testOk(this.obsync.settings.images.bucket),
                            });
                        } else {
                            resultEl.createEl("p", {
                                cls: "obsync-diag-failed",
                                text: this.obsync.notifier.describeError(
                                    result.error,
                                    t.settings.images.testFailed
                                ),
                            });
                        }
                    } finally {
                        button.setDisabled(false);
                        button.setButtonText(t.settings.images.test);
                    }
                })
            )
            .addButton((button) =>
                button.setButtonText(t.settings.images.preview).onClick(async () => {
                    button.setDisabled(true);
                    button.setButtonText(t.settings.images.previewing);
                    try {
                        this.renderPlanResult(
                            resultEl,
                            t.images.plan.heading,
                            await service.plan()
                        );
                    } catch (err) {
                        resultEl.empty();
                        resultEl.createEl("p", {
                            cls: "obsync-diag-failed",
                            text: this.obsync.notifier.describeError(err, t.images.notice.previewFailed),
                        });
                    } finally {
                        button.setDisabled(false);
                        button.setButtonText(t.settings.images.preview);
                    }
                })
            )
            .addButton((button) =>
                button
                    .setButtonText(t.settings.images.syncNow)
                    .setCta()
                    .onClick(async () => {
                        button.setDisabled(true);
                        button.setButtonText(t.settings.images.syncing);
                        try {
                            const summary = await service.run();
                            this.renderSummaryResult(resultEl, summary);
                        } catch (err) {
                            resultEl.empty();
                            resultEl.createEl("p", {
                                cls: "obsync-diag-failed",
                                text: this.obsync.notifier.describeError(err, t.images.notice.syncFailed),
                            });
                        } finally {
                            button.setDisabled(false);
                            button.setButtonText(t.settings.images.syncNow);
                        }
                    })
            );
    }

    /** 把一份计划渲染成用户能逐条核对的清单。 */
    private renderPlanResult(container: HTMLElement, heading: string, plan: SyncPlan): void {
        const t = this.obsync.t;
        container.empty();

        const counts = { upload: 0, download: 0, skip: 0, conflict: 0 };
        for (const entry of plan.entries) counts[entry.action] += 1;

        container.createEl("p", {
            cls: "obsync-diag-ok",
            // 冲突数单独列出来：它是这一页上唯一「有一边的改动会消失」的情况，
            // 而它不是用户主动要求的动作。
            text: `${heading} — ${t.images.plan.counts(
                counts.upload,
                counts.download,
                counts.conflict,
                counts.skip
            )}`,
        });

        // 截断要说出来：它意味着「云端有这一份但没被列到」会被当成缺一份而重传。
        // 那不是错误，但用户看到「明明一样却要重传」会以为是 bug。
        if (plan.truncated) {
            container.createEl("p", { cls: "obsync-diag-failed", text: t.images.plan.truncated });
        }

        const interesting = plan.entries.filter((entry) => entry.action !== "skip");
        if (interesting.length === 0) {
            container.createEl("p", { cls: "obsync-diag-skipped", text: t.images.plan.empty });
            return;
        }

        const list = container.createEl("ul", { cls: "obsync-diag-list" });
        // 只列前 50 条：一次列几千行既没人看，也会让设置页卡住。
        for (const entry of interesting.slice(0, 50)) {
            // 冲突用失败色标出来 —— 它是这一页上唯一「有东西会被覆盖掉」的情况。
            // 这一页存在的意义就是让用户在执行前看清那些。
            const cls = entry.action === "conflict" ? "obsync-diag-failed" : "obsync-diag-ok";
            const item = list.createEl("li", { cls });
            item.createSpan({
                text: `${t.images.plan.action[entry.action]} · ${t.images.plan.reason[entry.reason]} · `,
            });
            item.createSpan({ text: entry.path });
        }
        if (interesting.length > 50) {
            container.createEl("p", {
                cls: "obsync-diag-skipped",
                text: t.images.plan.more(interesting.length - 50),
            });
        }
    }

    /** 一轮执行之后的结果。 */
    private renderSummaryResult(container: HTMLElement, summary: SyncSummary): void {
        const t = this.obsync.t;
        container.empty();

        const didNothing = summary.uploaded === 0 && summary.downloaded === 0;

        container.createEl("p", {
            cls: summary.failed > 0 ? "obsync-diag-failed" : "obsync-diag-ok",
            text: didNothing
                ? t.images.notice.syncNothing
                : t.images.notice.syncDone(summary.uploaded, summary.downloaded),
        });

        // 截断只影响「结果完不完整」，不再是「不敢删」的说明（删除已经不在计划里）。
        if (summary.truncated) {
            container.createEl("p", { cls: "obsync-diag-failed", text: t.images.plan.truncated });
        }

        if (summary.errors.length > 0) {
            container.createEl("p", {
                cls: "obsync-diag-failed",
                text: t.images.notice.syncFailedMany(summary.errors.length),
            });
            const list = container.createEl("ul", { cls: "obsync-diag-list" });
            for (const entry of summary.errors.slice(0, 20)) {
                const item = list.createEl("li", { cls: "obsync-diag-failed" });
                item.createSpan({ text: `${entry.path}：` });
                item.createSpan({ text: entry.message });
            }
        }
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

/**
 * 当前列表是否就是默认值（仓库根目录）。
 *
 * 两边都过一遍 `normalizeFolders`：设置里的形状保证是归一后的（加载与每次写入
 * 都归一遍），而默认值写的是 `.` —— 不归一的话 `["."]` 与 `[""]` 会被判成不同，
 * 「恢复默认」在刚刚重置完的状态下仍然是可点的。
 */
function isDefaultFolders(folders: string[]): boolean {
    const current = normalizeFolders(folders);
    const fallback = normalizeFolders(DEFAULT_SETTINGS.images.folders);
    return current.length === fallback.length && current.every((item, index) => item === fallback[index]);
}
