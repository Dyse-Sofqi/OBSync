import { ItemView, Setting, WorkspaceLeaf } from "obsidian";
import type { LocaleStrings } from "../../../core/i18n";
import type { SyncService } from "../syncService";
import type { SimpleGitManager } from "../simpleGitManager";

/**
 * 源码控制视图。
 *
 * 刻意做得比 obsidian-git 的同类视图简单：它有树形文件视图、hunk 级暂存、
 * blame 等约 3k 行的可选增强，全部在 PLAN.md 的「明确不做」清单里。
 * 用户在这里需要的核心信息是「现在有什么没同步」，以及四个动作按钮。
 */

export const SYNC_VIEW_TYPE = "obsync-sync-view";

export class SourceControlView extends ItemView {
    constructor(
        leaf: WorkspaceLeaf,
        private readonly service: SyncService,
        private readonly git: SimpleGitManager,
        private readonly t: LocaleStrings,
        private readonly onEditRemote: () => void
    ) {
        super(leaf);
    }

    getViewType(): string {
        return SYNC_VIEW_TYPE;
    }

    getDisplayText(): string {
        return this.t.sync.viewTitle;
    }

    getIcon(): string {
        return "git-fork";
    }

    async onOpen(): Promise<void> {
        await this.render();
    }

    async onClose(): Promise<void> {
        this.contentEl.empty();
    }

    private async render(): Promise<void> {
        const { contentEl } = this;
        contentEl.empty();
        const t = this.t;

        new Setting(contentEl)
            .setName(t.sync.viewTitle)
            .setHeading()
            .addButton((button) =>
                button
                    .setButtonText(t.sync.actSync)
                    .setCta()
                    .onClick(() => void this.run(() => this.service.sync()))
            );

        new Setting(contentEl)
            .addButton((button) =>
                button
                    .setButtonText(t.sync.actCommit)
                    .onClick(() => void this.run(() => this.service.commitAll()))
            )
            .addButton((button) =>
                button
                    .setButtonText(t.sync.actPull)
                    .onClick(() => void this.run(() => this.service.pull()))
            )
            .addButton((button) =>
                button
                    .setButtonText(t.sync.actPush)
                    .onClick(() => void this.run(() => this.service.push()))
            )
            .addButton((button) =>
                button
                    .setIcon("settings-2")
                    .setTooltip(t.sync.actEditRemote)
                    .onClick(() => this.onEditRemote())
            );

        await this.renderStatus(contentEl);
    }

    private async renderStatus(contentEl: HTMLElement): Promise<void> {
        const t = this.t;
        const status = await this.service.refresh();

        if (!status) {
            contentEl.createEl("p", {
                text: t.sync.notARepo,
                cls: "obsync-empty",
            });
            return;
        }

        // 分支选择
        const branches = await this.safeListBranches();
        if (branches.length > 0) {
            new Setting(contentEl)
                .setName(t.sync.branchLabel)
                .addDropdown((dropdown) => {
                    for (const branch of branches) {
                        dropdown.addOption(branch.name, branch.name);
                    }
                    const current = branches.find((branch) => branch.current);
                    if (current) dropdown.setValue(current.name);
                    dropdown.onChange(
                        (value) => void this.run(() => this.git.checkout(value))
                    );
                });
        }
        // 变更列表
        const changes = [...status.staged, ...status.unstaged, ...status.untracked];
        if (changes.length === 0 && status.conflicted.length === 0) {
            contentEl.createEl("p", { text: t.sync.nothingToCommit, cls: "obsync-empty" });
        } else {
            const list = contentEl.createEl("ul", { cls: "obsync-changes" });
            for (const change of changes) {
                list.createEl("li", { text: `${markOf(change.status)} ${change.path}` });
            }
            for (const path of status.conflicted) {
                list.createEl("li", {
                    text: `⚠ ${path}`,
                    cls: "obsync-conflict",
                });
            }
        }
    }

    private async safeListBranches(): Promise<Array<{ name: string; current: boolean }>> {
        try {
            return await this.git.listBranches();
        } catch {
            return [];
        }
    }

    /** 动作跑完重绘整个视图。错误由 SyncService 内部提示，这里只需兜底。 */
    private async run(action: () => Promise<unknown>): Promise<void> {
        try {
            await action();
        } catch {
            // 通知已经由 service/notifier 完成；视图只负责恢复可用状态。
        }
        await this.render();
    }
}

function markOf(status: string): string {
    switch (status) {
        case "added":
            return "A";
        case "modified":
            return "M";
        case "deleted":
            return "D";
        case "renamed":
            return "R";
        case "conflicted":
            return "⚠";
        default:
            return "?";
    }
}
