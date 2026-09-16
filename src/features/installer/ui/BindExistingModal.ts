import { Modal, Setting, type App } from "obsidian";
import type { LocaleStrings } from "../../../core/i18n";
import { formatRepoId } from "../../../host/repoRef";
import type { CommunityPluginIndex } from "../communityPlugins";
import type { BindCandidate, ExistingPlugin } from "../existingPlugins";
import { resolveBindCandidates } from "../existingPlugins";
import type { InstallerService } from "../installerService";

/**
 * 绑定库里已有的插件。
 *
 * 打开即自动扫描：已装插件 × 官方社区索引 → 分出「可绑定」（来源已识别，
 * 勾选后加入跟踪列表）与「来源未识别」（不在官方商店，保持只读并提示
 * 用「添加插件仓库」手动加）。已在跟踪列表里的不出现在列表中。
 *
 * 绑定动作很轻（只写跟踪列表，不碰文件），所以不做二次确认 ——
 * 绑错了在列表里移除就行。
 */
export class BindExistingModal extends Modal {
    private candidates: BindCandidate[] | undefined;
    private unresolved: ExistingPlugin[] = [];
    private selected = new Set<string>();
    private loadError: string | undefined;
    private busy = false;

    constructor(
        app: App,
        private readonly service: InstallerService,
        private readonly index: CommunityPluginIndex,
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

    private async scan(): Promise<void> {
        const t = this.t;
        this.render();

        try {
            const trackedIds = new Set(
                this.service.deps.getSettings().installer.tracked.map((item) => item.pluginId)
            );
            const result = await resolveBindCandidates(this.app, this.index);

            // 已跟踪的不再出现 —— 绑定是给「漏网」插件用的。
            this.candidates = result.bindable.filter(
                (candidate) => !trackedIds.has(candidate.pluginId)
            );
            this.unresolved = result.unresolved.filter(
                (plugin) => !trackedIds.has(plugin.pluginId)
            );
            this.loadError = undefined;
        } catch (err) {
            this.loadError = this.service.deps.notifier.describeError(
                err,
                t.installer.bindLoadFailed
            );
            this.candidates = [];
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

        if (this.candidates === undefined) {
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

        if (this.candidates.length === 0 && this.unresolved.length === 0) {
            contentEl.createEl("p", {
                text: t.installer.bindEmpty,
                cls: "obsync-empty",
            });
            // 空状态同样要有「取消」—— 没有可绑定的东西不代表用户就该被困住。
            this.renderFooter();
            return;
        }

        if (this.candidates.length > 0) {
            new Setting(contentEl)
                .setName(t.installer.bindDetected(this.candidates.length))
                .addExtraButton((button) =>
                    button
                        .setIcon("check-check")
                        .setTooltip(t.installer.bindSelectAll)
                        .onClick(() => {
                            if (this.selected.size === this.candidates!.length) {
                                this.selected.clear();
                            } else {
                                for (const candidate of this.candidates!) {
                                    this.selected.add(candidate.pluginId);
                                }
                            }
                            this.render();
                        })
                );

            for (const candidate of this.candidates) {
                new Setting(contentEl)
                    .setName(candidate.name)
                    .setDesc(
                        `GitHub · ${formatRepoId(candidate.repo)} · ` +
                            `${t.common.version} ${candidate.version}`
                    )
                    .addToggle((toggle) =>
                        toggle
                            .setValue(this.selected.has(candidate.pluginId))
                            .onChange((value) => {
                                if (value) this.selected.add(candidate.pluginId);
                                else this.selected.delete(candidate.pluginId);
                                this.renderFooter();
                            })
                    );
            }
        }

        if (this.unresolved.length > 0) {
            contentEl.createEl("p", {
                text: t.installer.bindUnresolvedHeading(this.unresolved.length),
                cls: "setting-item-description",
            });
            for (const plugin of this.unresolved) {
                new Setting(contentEl)
                    .setName(plugin.manifest.name)
                    .setDesc(`${plugin.pluginId} · ${t.installer.bindUnresolved}`)
                    .setClass("obsync-muted");
            }
        }

        this.renderFooter();
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
        if (!this.candidates) return;

        const chosen = this.candidates.filter((candidate) =>
            this.selected.has(candidate.pluginId)
        );

        this.busy = true;
        this.render();

        try {
            const added = await this.service.bindExisting(chosen);
            this.onBound(added);
            this.close();
        } catch (err) {
            this.busy = false;
            this.render();
            this.service.deps.notifier.reportError(err, t.installer.bindLoadFailed);
        }
    }
}
