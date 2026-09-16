import { ItemView, Setting, WorkspaceLeaf } from "obsidian";
import type { LocaleStrings } from "../../../core/i18n";
import type { SyncService } from "../syncService";
import type { SimpleGitManager } from "../simpleGitManager";
import type { FileChange, RepoStatus } from "../types";

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
        const changes = visibleChanges(status);

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

    /**
     * 跑一个动作，然后重绘整个视图。
     *
     * **错误必须在这里报出去。** `SyncService` 只对「拉取冲突」与「没有远端」
     * 两种情况做了提示，其余错误（推送被拒、鉴权失败、找不到 git、网络问题）
     * 会原样上抛。早先这里静默吞掉，症状是：用户在视图里点「推送」，
     * 远端拒绝了，**界面上什么都不会发生** —— 连一句提示都没有。
     */
    private async run(action: () => Promise<unknown>): Promise<void> {
        try {
            await action();
        } catch (err) {
            this.service.deps.notifier.reportError(err);
        }
        await this.render();
    }
}

/**
 * 变更列表里该显示的文件。
 *
 * **必须把冲突文件滤掉。** 它们在 `git status` 里是 `UU`，于是 `mapStatus`
 * 会把它**同时**归进 `staged`（index 位非空）与 `unstaged`（worktree 位非空）。
 * 不滤的话同一个冲突文件会在列表里出现三次：staged 一次、unstaged 一次、
 * 外加下面单独渲染的 conflicted 那一行。
 *
 * 抽成独立函数是为了能直接测 —— 这类"列表里多了一项"的问题靠读代码很难发现，
 * 而视图本身要做 DOM 级测试代价太高。
 */
export function visibleChanges(status: RepoStatus): FileChange[] {
    return [...status.staged, ...status.unstaged, ...status.untracked].filter(
        (change) => change.status !== "conflicted"
    );
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
