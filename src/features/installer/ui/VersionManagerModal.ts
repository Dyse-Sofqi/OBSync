import { Modal, Setting, type App, type ButtonComponent } from "obsidian";
import type { LocaleStrings } from "../../../core/i18n";
import { logger } from "../../../core/logger";
import { formatRepoId } from "../../../host/repoRef";
import type { RepoRef } from "../../../host/types";
import { hostLabel } from "../downloadSource";
import type { InstallerService, VersionOption } from "../installerService";
import { itemRepoRef, type TrackedPlugin } from "../types";
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
 * ## 下载来源也在这里（2026-09-19 追加）
 *
 * 「从哪个仓库下载」与「装哪一版」在用户心里是同一件事 —— 实测的原话是
 * 「我选了 1.0.2 旧版安装，但是他却不走 gitee 路线，也找不到选择 gitee 镜像下载的
 * 选择」。原因有两层：GitHub 的 release 资产域名在国内经常连不上（见 HANDOVER
 * 第七节第 19 条），而镜像**自动探测**要能猜出候选才行 —— 它只猜「同名仓库」和
 * 「你 Gitee 账号下的同名仓库」，后者还要先填 Gitee 令牌。镜像挂在第三个地方
 * （作者自己的 Gitee 账号，名字都不一样）时，探测永远找不到，而界面上原本
 * **没有任何入口**能把它指出来。所以这里给两条路：探测到了就一键改用；
 * 没探到就手填地址（照 manifest 的 `id` 校验，见 `InstallerService.setMirror`）。
 *
 * 只有插件用得到：主题在设计上就没有版本钉选（`TrackedTheme` 上没有
 * `requestedVersion`，`updateTheme` 永远按最新走）。
 */
export class VersionManagerModal extends Modal {
    /** 拉到的版本列表；`undefined` 表示还没拉到（与「拉到空列表」是两件事）。 */
    private options: VersionOption[] | undefined;
    /** 拉列表失败时的说明（由 Notifier 翻译，逻辑层不拼文案）。 */
    private errorText: string | undefined;
    /** 下拉框里选中的值。默认取**记录里那个**，见构造函数。 */
    private selected: string;
    /** 探测到的疑似镜像（**只提议，不采用** —— 与列表里那条提议同一套判据）。 */
    private mirror: RepoRef | undefined;
    /** 探测跑完了没有：跑完且没有候选，才显示「没发现镜像」那段解释。 */
    private probed = false;
    /** 手填的镜像地址。 */
    private manualInput = "";
    /** 正在核对/切换来源（或正在拉版本列表）。 */
    private busy = false;
    /** 切来源失败时的说明。 */
    private mirrorError: string | undefined;
    /**
     * 「改用这个地址」按钮的实例。
     *
     * 与 AddRepoModal 里那个 `resolveButton` 同一个理由：按钮可用性取决于输入，
     * 而输入变化时**不能重绘**（会销毁输入框、丢焦点与光标）—— 所以留住实例，
     * 在 onChange 里就地改禁用态。（AddRepoModal 踩过的坑：「识别」按钮永远是灰的。）
     */
    private manualButton: ButtonComponent | undefined;

    constructor(
        app: App,
        private readonly service: InstallerService,
        private readonly t: LocaleStrings,
        private readonly plugin: TrackedPlugin,
        private readonly handlers: {
            /** 用户选定了版本：装上它（弹窗先关，安装由列表那一层执行）。 */
            onChoose: (option: VersionOption) => void;
            /** 下载来源被改写了（记录已变）——调用方要重绘列表。 */
            onSourceChanged: () => void;
        }
    ) {
        super(app);
        // 默认选中**记录里那个选择**，而不是「最新版本」：用户再次打开这个弹窗时
        // 看到的应该是现在的状态。默认成「最新」会把它变成一个不断把用户往最新
        // 版本拽的控件，而「我钉在哪一版」才是他要确认的事。
        this.selected = plugin.requestedVersion || "latest";
    }

    onOpen(): void {
        this.titleEl.setText(this.t.installer.versionManageTitle);
        this.render();
        void this.loadVersions();
        void this.probeMirror();
    }

    onClose(): void {
        this.contentEl.empty();
    }

    // ── 版本列表 ──────────────────────────────────────────────────────────

    private async loadVersions(): Promise<void> {
        // 来源可能刚换过 —— 先把旧列表丢掉，否则会显示上一个仓库的版本。
        this.options = undefined;
        this.errorText = undefined;
        this.render();

        try {
            this.options = await this.service.listVersions(itemRepoRef(this.plugin));
        } catch (err) {
            // 拉不到不算「没有版本」—— 两者给用户的信息完全不同，见 render()。
            logger.warn(`listing versions for ${this.plugin.name} failed`, err);
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
        const installed = this.plugin.installedVersion.trim();
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

    // ── 下载来源 ──────────────────────────────────────────────────────────

    /** 探测一个疑似镜像（只提议）。失败与「没探到」都只是没有候选，不是错误。 */
    private async probeMirror(): Promise<void> {
        this.mirror = await this.service.probeMirror(this.plugin);
        this.probed = true;
        this.render();
    }

    /** 采用探测到的镜像。 */
    private async useDiscoveredMirror(): Promise<void> {
        const mirror = this.mirror;
        if (!mirror) return;

        this.busy = true;
        this.mirrorError = undefined;
        this.render();
        try {
            await this.service.confirmMirror(this.plugin, mirror);
            this.afterSourceSwitch(mirror);
        } catch (err) {
            this.failSourceSwitch(err);
        }
    }

    /** 采用手填的镜像地址（`setMirror` 会先按 manifest 的 `id` 校验）。 */
    private async useManualMirror(): Promise<void> {
        const input = this.manualInput.trim();
        if (!input) return;

        this.busy = true;
        this.mirrorError = undefined;
        this.render();
        try {
            const ref = await this.service.setMirror(this.plugin, input);
            this.manualInput = "";
            this.afterSourceSwitch(ref);
        } catch (err) {
            this.failSourceSwitch(err);
        }
    }

    /**
     * 换来源成功之后。
     *
     * 必须**按新来源重拉版本列表**：列表是从当前来源查的，换了仓库之后 tag 可能
     * 完全不同（实测 Trefoil 的 Gitee 镜像只有 1.0.2 / 1.0.3，GitHub 有四个版本）。
     * 不重拉的话，用户会在「已改用镜像」之后看到一个来自旧仓库、点了会失败的列表。
     */
    private afterSourceSwitch(ref: RepoRef): void {
        this.service.deps.notifier.success(
            this.t.installer.mirrorConfirmed(hostLabel(this.t, ref.host), formatRepoId(ref))
        );
        this.mirror = undefined;
        this.probed = false;
        this.busy = false;
        this.handlers.onSourceChanged();
        this.render();
        void this.loadVersions();
        void this.probeMirror();
    }

    private failSourceSwitch(err: unknown): void {
        logger.warn(`switching the download source for ${this.plugin.name} failed`, err);
        this.mirrorError = this.service.deps.notifier.describeError(
            err,
            this.t.installer.versionMirrorFailed
        );
        this.busy = false;
        this.render();
    }

    // ── 渲染 ──────────────────────────────────────────────────────────────

    private render(): void {
        const t = this.t;
        const { contentEl } = this;
        contentEl.empty();
        this.manualButton = undefined;

        // 先说「你现在在哪一版」——下面那一串 tag 要靠它才有参照。
        contentEl.createEl("p", {
            text: this.plugin.installedVersion
                ? t.installer.versionInstalled(this.plugin.installedVersion)
                : t.installer.versionInstalledUnknown,
            cls: "obsync-modal-status",
        });
        contentEl.createEl("p", {
            text: t.installer.versionManageDesc,
            cls: "setting-item-description",
        });

        this.renderSource(contentEl);

        // 拉列表期间只说「正在获取」并转起来，不画空下拉框（空的看着像「没有版本」）。
        // 用户的原话是「不然我根本不知道你是不是在更新」——所以要有个东西在转。
        if (!this.options && !this.errorText) {
            const status = contentEl.createEl("p", { cls: "obsync-modal-status" });
            status.createSpan({ cls: "obsync-spinner" });
            status.createSpan({ text: t.installer.versionLoading });
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
                    .setDisabled(!hasChoice || this.busy)
                    .onClick(() => this.apply(options));
            });
    }

    /**
     * 「下载来源」一节：现在走哪个地址 + 怎么换。
     *
     * 三条信息缺一不可：**现在走谁**（不然用户不知道要不要换）、**有没有候选**
     * （探到了就给一键改用）、以及**探不到时为什么**（否则「没发现镜像」会被读成
     * 「这个插件没有镜像」，而实际是探测的判据有限）。
     */
    private renderSource(contentEl: HTMLElement): void {
        const t = this.t;
        const ref = itemRepoRef(this.plugin);
        const setting = new Setting(contentEl).setName(t.installer.versionSourceLabel);

        setting.descEl.createDiv({
            text: t.installer.versionSourceCurrent(hostLabel(t, ref.host), formatRepoId(ref)),
        });
        // 记录里还留着源仓库（走镜像时才有）—— 把它也摆出来，用户才知道家在哪。
        if (this.plugin.origin) {
            setting.descEl.createDiv({
                cls: "obsync-mirror-line",
                text: t.installer.versionSourceOrigin(
                    hostLabel(t, this.plugin.origin.host),
                    formatRepoId(this.plugin.origin)
                ),
            });
        }

        if (this.mirror) {
            const mirror = this.mirror;
            setting.descEl.createDiv({
                cls: "obsync-mirror-line obsync-mirror-pending",
                text: t.installer.versionMirrorFound(
                    hostLabel(t, mirror.host),
                    formatRepoId(mirror)
                ),
            });
            setting.addButton((button) =>
                button
                    .setButtonText(t.installer.versionUseMirror(hostLabel(t, mirror.host)))
                    .setDisabled(this.busy)
                    .onClick(() => void this.useDiscoveredMirror())
            );
        } else if (this.probed && ref.host === "github") {
            // 探不到时**必须解释**：探测只猜两个候选，第三个地方（作者自己的
            // Gitee 账号，名字不同）永远猜不到 —— 实测 Trefoil 就是这一种。
            setting.descEl.createDiv({ cls: "obsync-mirror-line", text: t.installer.versionMirrorNone });
        }

        // 手填地址：自动探测的兜底，也是「镜像挂在别的账号下」唯一的路。
        new Setting(contentEl)
            .setName(t.installer.versionManualLabel)
            .setDesc(t.installer.versionManualDesc)
            .addText((text) => {
                text.setPlaceholder(t.installer.versionManualPlaceholder)
                    .setValue(this.manualInput)
                    .setDisabled(this.busy);
                text.onChange((value) => {
                    this.manualInput = value;
                    this.syncManualButton();
                });
            })
            .addButton((button) => {
                this.manualButton = button;
                button
                    .setButtonText(t.installer.versionManualApply)
                    .setDisabled(this.manualDisabled())
                    .onClick(() => void this.useManualMirror());
            });

        if (this.busy) {
            const status = contentEl.createEl("p", { cls: "obsync-modal-status" });
            status.createSpan({ cls: "obsync-spinner" });
            status.createSpan({ text: t.installer.versionManualChecking });
        }

        if (this.mirrorError) {
            contentEl.createEl("p", { text: this.mirrorError, cls: "obsync-modal-warning" });
        }
    }

    /** 空地址没有可核对的东西；忙着的时候也不该重复触发。 */
    private manualDisabled(): boolean {
        return this.busy || this.manualInput.trim().length === 0;
    }

    /** 输入变化后就地刷新按钮可用性（不重建内容区，保住焦点与光标）。 */
    private syncManualButton(): void {
        this.manualButton?.setDisabled(this.manualDisabled());
    }

    /** 把选中的版本交出去。弹窗先关，避免安装期间它还盖在设置页上。 */
    private apply(options: VersionOption[]): void {
        const option = options.find((candidate) => candidate.value === this.selected);
        // 按钮在没有可选项时是置灰的，正常点不到这里。
        if (!option) return;
        this.close();
        this.handlers.onChoose(option);
    }
}
