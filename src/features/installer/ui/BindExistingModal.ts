import { Modal, Setting, type App, type ButtonComponent } from "obsidian";
import type { LocaleStrings } from "../../../core/i18n";
import { availableUpdateKey } from "../../../core/settings";
import { formatRepoId } from "../../../host/repoRef";
import type { CommunityPluginIndex } from "../communityPlugins";
import type { CommunityThemeIndex } from "../communityThemes";
import type { BindCandidate, ExistingPlugin } from "../existingPlugins";
import { resolveBindCandidates } from "../existingPlugins";
import type { ExistingTheme, ThemeBindCandidate } from "../existingThemes";
import { resolveThemeBindCandidates } from "../existingThemes";
import type { InstallerService } from "../installerService";
import type { TrackedKind } from "../types";

/**
 * 绑定库里已有的插件与主题。
 *
 * 打开即自动扫描：已装对象 × 官方社区索引 → 分出「可绑定」（来源已识别，
 * 勾选后加入跟踪列表）与「来源未识别」。已在跟踪列表里的不出现在列表中。
 *
 * 绑定动作很轻（只写跟踪列表，不碰文件、不切换当前主题），所以不做二次确认 ——
 * 绑错了在列表里移除就行。
 *
 * ## 两处刻意的不对称（都是数据决定的）
 *
 * 1. **未识别的主题可以手填仓库地址，未识别的插件不行**。插件有「添加插件仓库」
 *    那个兜底入口；本次范围里主题没有新装路径，不手填的话未识别主题永远纳不进来。
 * 2. **主题的候选与未识别分两组展示**，而不是混在一起：主题身份是目录名、
 *    插件身份是 manifest id，混排会让「这行到底是哪个」变得要靠猜。
 */
export class BindExistingModal extends Modal {
    private pluginCandidates: BindCandidate[] | undefined;
    private pluginUnresolved: ExistingPlugin[] = [];
    private themeCandidates: ThemeBindCandidate[] = [];
    private themeUnresolved: ExistingTheme[] = [];

    /** 已勾选的对象，键为 `availableUpdateKey`（`<kind>:<id>`）。 */
    private selected = new Set<string>();
    /** 未识别主题那一列里，用户填的仓库地址（键为主题目录名）。 */
    private manualRepos = new Map<string, string>();

    private loadError: string | undefined;
    private busy = false;

    constructor(
        app: App,
        private readonly service: InstallerService,
        private readonly pluginIndex: CommunityPluginIndex,
        private readonly themeIndex: CommunityThemeIndex,
        private readonly t: LocaleStrings,
        private readonly onBound: (count: number) => void
    ) {
        super(app);
    }

    onOpen(): void {
        this.titleEl.setText(this.t.installer.bindTitle);
        void this.scan();
    }

    onClose(): void {
        this.contentEl.empty();
    }

    private keyOf(kind: TrackedKind, id: string): string {
        return availableUpdateKey({ kind, id });
    }

    private async scan(): Promise<void> {
        const t = this.t;
        this.render();

        try {
            const tracked = this.service.deps.getSettings().installer.tracked;
            const trackedKeys = new Set(tracked.map((item) => availableUpdateKey(item)));

            // 两个索引都在 GitHub raw 上，一起等（它们同源，一个不通另一个大概也不通）。
            const [plugins, themes] = await Promise.all([
                resolveBindCandidates(this.app, this.pluginIndex),
                resolveThemeBindCandidates(this.app, this.themeIndex),
            ]);

            // 已跟踪的不再出现 —— 绑定是给「漏网」的对象用的。
            this.pluginCandidates = plugins.bindable.filter(
                (candidate) => !trackedKeys.has(this.keyOf("plugin", candidate.id))
            );
            this.pluginUnresolved = plugins.unresolved.filter(
                (plugin) => !trackedKeys.has(this.keyOf("plugin", plugin.id))
            );
            this.themeCandidates = themes.bindable.filter(
                (candidate) => !trackedKeys.has(this.keyOf("theme", candidate.id))
            );
            this.themeUnresolved = themes.unresolved.filter(
                (theme) => !trackedKeys.has(this.keyOf("theme", theme.id))
            );
            this.loadError = undefined;
        } catch (err) {
            this.loadError = this.service.deps.notifier.describeError(
                err,
                t.installer.bindLoadFailed
            );
            this.pluginCandidates = [];
        }

        this.render();
    }

    private render(): void {
        const t = this.t;
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl("p", {
            text: t.installer.bindDesc,
            cls: "setting-item-description",
        });

        if (this.pluginCandidates === undefined) {
            contentEl.createEl("p", { text: t.installer.bindScanning, cls: "obsync-modal-status" });
            // 扫描要拉社区索引（可能几秒），期间也得有「取消」可点 ——
            // 否则用户只能按 Esc 或点弹窗外，和其他状态不一致。
            this.renderFooter();
            return;
        }

        if (this.loadError) {
            contentEl.createEl("p", {
                text: this.loadError,
                cls: "obsync-modal-warning",
            });
        }

        const nothingToBind =
            this.pluginCandidates.length === 0 &&
            this.themeCandidates.length === 0 &&
            this.pluginUnresolved.length === 0 &&
            this.themeUnresolved.length === 0;

        if (nothingToBind) {
            contentEl.createEl("p", {
                text: t.installer.bindEmpty,
                cls: "obsync-empty",
            });
            // 空状态同样要有「取消」—— 没有可绑定的东西不代表用户就该被困住。
            this.renderFooter();
            return;
        }

        this.renderPluginCandidates();
        this.renderThemeCandidates();
        this.renderUnresolvedPlugins();
        this.renderUnresolvedThemes();

        this.renderFooter();
    }

    private renderPluginCandidates(): void {
        const t = this.t;
        const candidates = this.pluginCandidates ?? [];
        if (candidates.length === 0) return;

        this.renderGroupHeader(t.installer.bindPluginsHeading(candidates.length), "plugin", candidates.map((c) => c.id));

        for (const candidate of candidates) {
            new Setting(this.contentEl)
                .setName(candidate.name)
                .setDesc(
                    `GitHub · ${formatRepoId(candidate.repo)} · ` +
                        `${t.common.version} ${candidate.version}`
                )
                .addToggle((toggle) =>
                    toggle
                        .setValue(this.selected.has(this.keyOf("plugin", candidate.id)))
                        .onChange((value) => {
                            this.toggleSelection("plugin", candidate.id, value);
                        })
                );
        }
    }

    private renderThemeCandidates(): void {
        const t = this.t;
        if (this.themeCandidates.length === 0) return;

        this.renderGroupHeader(
            t.installer.bindThemesHeading(this.themeCandidates.length),
            "theme",
            this.themeCandidates.map((c) => c.id)
        );

        for (const candidate of this.themeCandidates) {
            const facts = [`GitHub · ${formatRepoId(candidate.repo)}`];
            // 版本未知（目录里没有 manifest）时不写这一段，见 TrackedItemsList 里同样的处理。
            if (candidate.version) facts.push(`${t.common.version} ${candidate.version}`);

            new Setting(this.contentEl)
                .setName(candidate.name)
                .setDesc(facts.join(" · "))
                .addToggle((toggle) =>
                    toggle
                        .setValue(this.selected.has(this.keyOf("theme", candidate.id)))
                        .onChange((value) => {
                            this.toggleSelection("theme", candidate.id, value);
                        })
                );
        }
    }

    /** 一组候选的标题行 —— 右侧是这一组的「全选 / 取消全选」。 */
    private renderGroupHeader(heading: string, kind: TrackedKind, ids: string[]): void {
        new Setting(this.contentEl)
            .setName(heading)
            .addExtraButton((button) =>
                button
                    .setIcon("check-check")
                    .setTooltip(this.t.installer.bindSelectAll)
                    .onClick(() => {
                        const keys = ids.map((id) => this.keyOf(kind, id));
                        const allSelected = keys.every((key) => this.selected.has(key));
                        for (const key of keys) {
                            if (allSelected) this.selected.delete(key);
                            else this.selected.add(key);
                        }
                        this.render();
                    })
            );
    }

    private toggleSelection(kind: TrackedKind, id: string, selected: boolean): void {
        const key = this.keyOf(kind, id);
        if (selected) this.selected.add(key);
        else this.selected.delete(key);
        // 只更新底部按钮，不重建内容区（重建会让开关丢焦点）。
        this.renderFooter();
    }

    private renderUnresolvedPlugins(): void {
        const t = this.t;
        if (this.pluginUnresolved.length === 0) return;

        this.contentEl.createEl("p", {
            text: t.installer.bindUnresolvedHeading(this.pluginUnresolved.length),
            cls: "setting-item-description",
        });

        for (const plugin of this.pluginUnresolved) {
            new Setting(this.contentEl)
                .setName(plugin.manifest.name)
                .setDesc(`${plugin.id} · ${t.installer.bindUnresolved}`)
                .setClass("obsync-muted");
        }
    }

    /**
     * 未识别主题：给一个手填仓库地址的入口。
     *
     * 按钮的可用性**在输入时就地更新**，不能靠重绘 —— 重建内容区会销毁输入框，
     * 用户每敲一个字就丢焦点与光标（AddRepoModal 的「识别」按钮踩过这个坑）。
     */
    private renderUnresolvedThemes(): void {
        const t = this.t;
        if (this.themeUnresolved.length === 0) return;

        this.contentEl.createEl("p", {
            text: t.installer.bindUnresolvedThemesHeading(this.themeUnresolved.length),
            cls: "setting-item-description",
        });

        for (const theme of this.themeUnresolved) {
            const setting = new Setting(this.contentEl)
                .setName(theme.name)
                .setDesc(t.installer.bindUnresolvedTheme)
                .setClass("obsync-muted");

            let bindButton: ButtonComponent | undefined;

            setting.addText((text) =>
                text
                    .setPlaceholder(t.installer.bindRepoPlaceholder)
                    .setValue(this.manualRepos.get(theme.id) ?? "")
                    .onChange((value) => {
                        this.manualRepos.set(theme.id, value);
                        bindButton?.setDisabled(value.trim().length === 0 || this.busy);
                    })
            );

            setting.addButton((button) => {
                bindButton = button;
                return button
                    .setButtonText(t.installer.bindManualBind)
                    .setDisabled((this.manualRepos.get(theme.id) ?? "").trim().length === 0)
                    .onClick(async () => {
                        const input = (this.manualRepos.get(theme.id) ?? "").trim();
                        if (!input) return;

                        button.setDisabled(true);
                        try {
                            const added = await this.service.bindThemeToRepo(theme, input);
                            this.onBound(added);
                            this.close();
                        } catch (err) {
                            button.setDisabled(false);
                            this.service.deps.notifier.reportError(
                                err,
                                t.installer.bindManualFailed
                            );
                        }
                    });
            });
        }
    }

    private footerSetting: Setting | undefined;

    private renderFooter(): void {
        const t = this.t;
        this.footerSetting?.settingEl.remove();

        this.footerSetting = new Setting(this.contentEl)
            .addButton((button) =>
                button
                    .setButtonText(t.common.cancel)
                    .onClick(() => this.close())
            )
            .addButton((button) => {
                button
                    .setButtonText(t.installer.bindConfirm(this.selected.size))
                    .setCta()
                    .setDisabled(this.selected.size === 0 || this.busy)
                    .onClick(() => void this.bind());
                return button;
            });
    }

    private async bind(): Promise<void> {
        const t = this.t;
        if (!this.pluginCandidates) return;

        const chosenPlugins = this.pluginCandidates.filter((candidate) =>
            this.selected.has(this.keyOf("plugin", candidate.id))
        );
        const chosenThemes = this.themeCandidates.filter((candidate) =>
            this.selected.has(this.keyOf("theme", candidate.id))
        );

        this.busy = true;
        this.render();

        try {
            const addedPlugins = await this.service.bindExisting(chosenPlugins);
            const addedThemes = await this.service.bindExistingThemes(chosenThemes);
            this.onBound(addedPlugins + addedThemes);
            this.close();
        } catch (err) {
            this.busy = false;
            this.render();
            this.service.deps.notifier.reportError(err, t.installer.bindLoadFailed);
        }
    }
}
