import { Modal, Setting, type App } from "obsidian";
import type { LocaleStrings } from "../../../core/i18n";
import { logger } from "../../../core/logger";
import { formatRepoId } from "../../../host/repoRef";
import type { RepoRef } from "../../../host/types";
import type { CommunityPluginIndex } from "../communityPlugins";
import type { InstallerService, VersionOption } from "../installerService";
import type { InstallResult } from "../types";
import { CommunityPluginModal } from "./CommunityPluginModal";
import { VersionSuggestModal } from "./VersionSuggestModal";

/**
 * 添加插件仓库 —— 安装器的主入口。
 *
 * 流程：输入地址 → 识别（解析平台 + 可选镜像发现）→ 选版本 → 安装。
 *
 * 与参考项目 BRAT 的 `AddNewPluginModal` 相比，这里把「识别」做成显式一步：
 * BRAT 是在输入框失焦时自动去拉版本列表，用户看不到"正在识别什么、
 * 识别成了哪个平台"。多平台之后这个反馈变得必要 ——
 * 用户需要知道 `owner/repo` 被认成了 GitHub 还是 Gitee。
 */
export class AddRepoModal extends Modal {
    private repoInput = "";
    private version = "latest";
    private enableAfterInstall = true;

    private resolved: { ref: RepoRef; mirror?: RepoRef } | undefined;
    private versions: VersionOption[] = [];
    /** 拉版本列表失败时的说明，用于在界面上给出解释而不是静默降级。 */
    private versionError: string | undefined;
    /**
     * 正在做什么。用具体阶段而不是布尔量 —— 弹窗里要显示「正在识别…」
     * 还是「正在安装…」，笼统的「加载中…」会让用户不知道卡在哪一步。
     */
    private busy: "resolving" | "installing" | undefined;

    constructor(
        app: App,
        private readonly service: InstallerService,
        private readonly index: CommunityPluginIndex,
        private readonly t: LocaleStrings,
        private readonly onInstalled?: (result: InstallResult) => void
    ) {
        super(app);
    }

    onOpen(): void {
        this.titleEl.setText(this.t.installer.modalTitle);
        this.render();
    }

    onClose(): void {
        this.contentEl.empty();
    }

    private render(): void {
        const t = this.t;
        const { contentEl } = this;
        contentEl.empty();

        new Setting(contentEl)
            .setName(t.installer.repoLabel)
            .setDesc(t.installer.repoDesc)
            .addText((text) => {
                text.setPlaceholder(t.installer.repoPlaceholder)
                    .setValue(this.repoInput)
                    .setDisabled(this.busy !== undefined);
                text.onChange((value) => {
                    this.repoInput = value;
                });
                text.inputEl.addEventListener("keydown", (event) => {
                    if (event.key === "Enter") {
                        event.preventDefault();
                        void this.resolve();
                    }
                });
                // 让用户一进来就能直接粘贴
                window.setTimeout(() => text.inputEl.focus(), 0);
            })
            .addButton((button) =>
                button
                    .setButtonText(t.installer.resolve)
                    .setDisabled(this.busy !== undefined || this.repoInput.trim().length === 0)
                    .onClick(() => void this.resolve())
            )
            .addButton((button) =>
                button
                    .setButtonText(t.installer.browse)
                    .setDisabled(this.busy !== undefined)
                    .onClick(() => void this.browseCommunity())
            );

        if (this.busy) {
            contentEl.createEl("p", {
                text: this.busy === "resolving" ? t.installer.resolving : t.installer.installing,
                cls: "obsync-modal-status",
            });
            return;
        }

        if (this.resolved) this.renderResolved(contentEl);
    }

    private renderResolved(contentEl: HTMLElement): void {
        const t = this.t;
        const resolved = this.resolved!;

        contentEl.createEl("p", {
            text: t.installer.resolved(
                resolved.ref.host === "gitee" ? t.host.gitee : t.host.github,
                formatRepoId(resolved.ref)
            ),
            cls: "obsync-modal-status",
        });

        if (resolved.mirror) {
            contentEl.createEl("p", {
                text: t.installer.mirrorFound(formatRepoId(resolved.mirror)),
                cls: "obsync-modal-status",
            });
        }

        new Setting(contentEl)
            .setName(t.installer.versionLabel)
            .addDropdown((dropdown) => {
                for (const option of this.versions) {
                    dropdown.addOption(option.value, option.label);
                }
                dropdown.setValue(this.version);
                dropdown.onChange((value) => {
                    this.version = value;
                });
            })
            .addExtraButton((button) =>
                button
                    .setIcon("list")
                    .setTooltip(t.installer.versionLabel)
                    .setDisabled(this.versions.length <= 1)
                    .onClick(() => {
                        new VersionSuggestModal(this.app, this.versions, t, (option) => {
                            this.version = option.value;
                            this.render();
                        }).open();
                    })
            );

        if (this.versionError) {
            contentEl.createEl("p", {
                text: this.versionError,
                cls: "obsync-modal-warning",
            });
        }

        new Setting(contentEl).setName(t.installer.enableAfterInstall).addToggle((toggle) =>
            toggle.setValue(this.enableAfterInstall).onChange((value) => {
                this.enableAfterInstall = value;
            })
        );

        new Setting(contentEl).addButton((button) =>
            button
                .setButtonText(t.installer.install)
                .setCta()
                .onClick(() => void this.install())
        );
    }

    /** 识别仓库地址，并顺带拉取可选版本。 */
    private async resolve(): Promise<void> {
        const t = this.t;
        if (!this.repoInput.trim()) return;

        this.busy = "resolving";
        this.versionError = undefined;
        this.render();

        try {
            this.resolved = await this.service.resolveRepo(this.repoInput);
            this.versions = [{ value: "latest", label: t.installer.versionLatest, prerelease: false }];
            this.version = "latest";
        } catch (err) {
            logger.warn("resolve failed", err);
            this.busy = undefined;
            this.resolved = undefined;
            this.render();
            this.service.deps.notifier.reportError(err);
            return;
        }

        this.busy = undefined;
        this.render();

        // 版本列表单独拉，失败不影响安装（降级到源码通道照样能装）。
        try {
            const versions = await this.service.listVersions(this.resolved.ref);
            this.versions = versions;
        } catch (err) {
            logger.warn("listing versions failed", err);
            this.versionError = this.service.deps.notifier.describeError(
                err,
                t.installer.versionListFailed
            );
        }
        this.render();
    }

    private async browseCommunity(): Promise<void> {
        const t = this.t;
        try {
            await this.index.load();
        } catch (err) {
            this.service.deps.notifier.reportError(err, t.installer.communityLoadFailed);
            return;
        }

        new CommunityPluginModal(this.app, this.index, t, (plugin) => {
            this.repoInput = plugin.repo;
            this.render();
            void this.resolve();
        }).open();
    }

    private async install(): Promise<void> {
        const t = this.t;
        if (!this.resolved) return;

        this.busy = "installing";
        this.render();

        try {
            const result = await this.service.install({
                repo: formatRepoId(this.resolved.ref),
                version: this.version,
                enableAfterInstall: this.enableAfterInstall,
                // 已经在 resolveRepo 阶段做过镜像发现，这里不要重复做。
                allowMirror: false,
                defaultHost: this.resolved.ref.host,
            });

            const message = result.replaced
                ? t.installer.updated(result.manifest.name, result.version)
                : t.installer.installed(result.manifest.name, result.version);
            this.service.deps.notifier.success(message);
            this.onInstalled?.(result);
            this.close();
        } catch (err) {
            this.busy = undefined;
            this.render();
            this.service.deps.notifier.reportError(err, t.installer.installFailed);
        }
    }
}
