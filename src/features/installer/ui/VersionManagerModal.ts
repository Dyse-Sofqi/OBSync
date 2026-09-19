import { Modal, Setting, type App } from "obsidian";
import type { LocaleStrings } from "../../../core/i18n";
import { logger } from "../../../core/logger";
import type { RepoRef } from "../../../host/types";
import type { InstallerService, VersionOption } from "../installerService";
import { compareVersions } from "../versions";
import { VersionSuggestModal } from "./VersionSuggestModal";

/**
 * 「版本管理」弹窗 —— 把一个已跟踪的插件切到另一个**已发布的版本**。
 *
 * ## 为什么要有这个入口
 *
 * `requestedVersion` 这个字段一直存在（`install` 每次都会写它，「重装」也读它），
 * 但界面上**没有任何地方能改它** —— 只有「添加插件仓库」弹窗里那一次选择算数。
 * 于是装完之后：用户既改不了这个选择，也看不见它。一个装坏了的版本除了等作者
 * 发新版，没有别的出路，而「回退到上一版」恰恰是遇到坏版本时最该能做的事。
 *
 * ## 三条刻意的行为
 *
 * 1. **列的是发布版本**：选旧版本就是回退。列表第一项仍是「最新版本」，
 *    选它等于把钉住的那个选择解开（恢复跟随最新）。
 * 2. **把当前装在磁盘上的那一版标出来**（`versionCurrent`）：一串 tag 里认不出
 *    自己在哪一版，就没法「退回上一版」—— 而这正是用户来这里的理由。
 * 3. **拉不到版本列表就如实说**，不画一个空下拉框装傻：Gitee 上「只有源码、
 *    不发 release」是常态，那种仓库根本没有版本可切。不说清楚，用户会以为
 *    按钮坏了（与 AddRepoModal 里 `versionListFailed` 的用意相同）。
 *
 * 它**不自己执行安装**：选定之后交给调用方（`onChoose`），与 `ConfirmMirrorModal`
 * 的分工一致 —— 通知与列表重绘属于列表那一层。
 *
 * ## 为什么只有插件用得到
 *
 * 主题在设计上就没有版本钉选（`TrackedTheme` 上没有 `requestedVersion`，
 * `updateTheme` 永远按最新走）。所以这个弹窗只被插件那一行调用，
 * 主题行上根本不出现那个按钮 —— 这条不对称见 `installer/types.ts` 里
 * `TrackedPlugin.requestedVersion` 的注释。
 */

export interface VersionSubject {
    /** 显示名（`manifest.name`），用在标题反馈与日志里。 */
    name: string;
    /**
     * **实际使用**的来源地址（走镜像时即镜像）。
     * 版本列表必须按它查 —— 与更新检查、下载同源。
     */
    repoRef: RepoRef;
    /** 磁盘上实际安装的版本（空串 = 读不到，手工装的目录可能如此）。 */
    installedVersion: string;
    /** 记录里「用户要求的版本」：`"latest"` 或具体 tag。 */
    requestedVersion: string;
}

export class VersionManagerModal extends Modal {
    /** 拉到的版本列表；`undefined` 表示还没拉到（与「拉到空列表」是两件事）。 */
    private options: VersionOption[] | undefined;
    /** 拉列表失败时的说明（由 Notifier 翻译，逻辑层不拼文案）。 */
    private errorText: string | undefined;
    /** 下拉框里选中的值。默认取**记录里那个**，见构造函数。 */
    private selected: string;

    constructor(
        app: App,
        private readonly service: InstallerService,
        private readonly t: LocaleStrings,
        private readonly subject: VersionSubject,
        private readonly onChoose: (option: VersionOption) => void
    ) {
        super(app);
        // 默认选中**记录里那个选择**，而不是「最新版本」：用户再次打开这个弹窗时
        // 看到的应该是现在的状态。默认成「最新」会把它变成一个不断把用户往最新
        // 版本拽的控件，而「我钉在哪一版」才是他要确认的事。
        this.selected = subject.requestedVersion || "latest";
    }

    onOpen(): void {
        this.titleEl.setText(this.t.installer.versionManageTitle);
        this.render();
        void this.loadVersions();
    }

    onClose(): void {
        this.contentEl.empty();
    }

    private async loadVersions(): Promise<void> {
        try {
            this.options = await this.service.listVersions(this.subject.repoRef);
        } catch (err) {
            // 拉不到不算「没有版本」—— 两者给用户的信息完全不同，见 render()。
            logger.warn(`listing versions for ${this.subject.name} failed`, err);
            this.errorText = this.service.deps.notifier.describeError(
                err,
                this.t.installer.versionFetchFailed
            );
        }

        // 记录里那个 tag 可能已经不在列表里（release 被删、改名、或超出 limit）——
        // 回落到第一项，否则下拉框会显示一个不存在的值。
        if (this.options && !this.options.some((option) => option.value === this.selected)) {
            this.selected = this.options[0]?.value ?? "latest";
        }
        this.render();
    }

    /** 这个选项是不是**当前装在磁盘上**的那一版（用于标「当前」）。 */
    private isInstalled(option: VersionOption): boolean {
        const installed = this.subject.installedVersion.trim();
        // 「最新版本」不是版本号，而是「跟着最新走」——拿它跟已装版本比没有意义。
        if (!installed || option.value === "latest") return false;

        // tag 与 manifest 里的 version 经常不同形（`v1.2.3` ↔ `1.2.3`），
        // 而且 `1.10.0` 与 `1.9.0` 直接用字符串比会得出相反结论 —— 所以走
        // 版本比较（与更新检查同一个判据），只有非 semver 的 tag 才退化成相等比较。
        const compared = compareVersions(option.value, installed);
        return compared === undefined ? option.value.trim() === installed : compared === 0;
    }

    private label(option: VersionOption): string {
        return this.isInstalled(option)
            ? `${option.label} · ${this.t.installer.versionCurrent}`
            : option.label;
    }

    private render(): void {
        const t = this.t;
        const { contentEl } = this;
        contentEl.empty();

        // 先说「你现在在哪一版」——下面那一串 tag 要靠它才有参照。
        contentEl.createEl("p", {
            text: this.subject.installedVersion
                ? t.installer.versionInstalled(this.subject.installedVersion)
                : t.installer.versionInstalledUnknown,
            cls: "obsync-modal-status",
        });
        contentEl.createEl("p", {
            text: t.installer.versionManageDesc,
            cls: "setting-item-description",
        });

        // 还在拉列表：只说「正在获取」，不画一个空下拉框（空的看着像「没有版本」）。
        if (!this.options && !this.errorText) {
            contentEl.createEl("p", {
                text: t.installer.versionLoading,
                cls: "obsync-modal-status",
            });
            return;
        }

        if (this.errorText) {
            contentEl.createEl("p", { text: this.errorText, cls: "obsync-modal-warning" });
        }

        const options = this.options ?? [];
        // 只有「最新版本」一项 = 这个仓库一个 release 都没发（`listVersions`
        // 总是把「最新版本」放在第一项），也就是**没有版本可切**。
        const hasChoice = options.length > 1;

        new Setting(contentEl)
            .setName(t.installer.versionLabel)
            .addDropdown((dropdown) => {
                for (const option of options) {
                    dropdown.addOption(option.value, this.label(option));
                }
                dropdown.setValue(this.selected);
                dropdown.onChange((value) => {
                    this.selected = value;
                });
            })
            // 版本多的时候（实测有 21 个 release 的主题/插件）下拉框不好翻，
            // 与「添加插件仓库」弹窗同一个出口：丢给可搜索的 SuggestModal。
            .addExtraButton((button) =>
                button
                    .setIcon("list")
                    .setTooltip(t.installer.versionLabel)
                    .setDisabled(!hasChoice)
                    .onClick(() => {
                        new VersionSuggestModal(
                            this.app,
                            options.map((option) => ({ ...option, label: this.label(option) })),
                            t,
                            (option) => {
                                this.selected = option.value;
                                this.render();
                            }
                        ).open();
                    })
            );

        // 「没有版本可切」与「拉不到列表」是两件事，必须分开说：前者是仓库的
        // 事实（只能从源码装），后者是这次请求失败了（可以重试）。
        if (!hasChoice && !this.errorText) {
            contentEl.createEl("p", {
                text: t.installer.versionNoneAvailable,
                cls: "obsync-modal-warning",
            });
        }

        new Setting(contentEl)
            .addButton((button) =>
                button.setButtonText(t.common.cancel).onClick(() => this.close())
            )
            .addButton((button) => {
                button
                    .setButtonText(t.installer.versionApply)
                    .setCta()
                    .setDisabled(!hasChoice)
                    .onClick(() => this.apply(options));
            });
    }

    /** 把选中的版本交出去。弹窗先关，避免安装期间它还盖在设置页上。 */
    private apply(options: VersionOption[]): void {
        const option = options.find((candidate) => candidate.value === this.selected);
        // 按钮在没有可选项时是置灰的，正常点不到这里。
        if (!option) return;
        this.close();
        this.onChoose(option);
    }
}
