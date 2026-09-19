import { ItemView, Setting, WorkspaceLeaf } from "obsidian";
import type { LocaleStrings } from "../../../core/i18n";
import { redactUrl } from "../../../host/redact";
import { changeRows, type ChangeRow } from "../changeRows";
import { formatBytes } from "../repoSize";
import { isFullyInSync } from "../syncState";
import type { SyncService } from "../syncService";
import type { SimpleGitManager } from "../simpleGitManager";
import type { CommitInfo, FileChangeStatus, RepoSize, RepoStatus } from "../types";

/**
 * 仓库同步视图（侧边栏面板）。
 *
 * 类名与视图类型仍是 `SourceControlView` / `obsync-sync-view`：改名只动了**显示
 * 的名字**（`t.sync.viewTitle`），没动标识符 —— 视图类型是持久化在用户
 * `workspace.json` 里的，改了会让已经打开的标签页失效。
 *
 * ## 它现在的样子与为什么
 *
 * 原先这里只有「一个标题 + 四个按钮 + 一串文件名」：没有分支的上游信息、
 * 看不出哪些文件已暂存、看不到提交历史、不是仓库时是一条死路（只提示
 * 「尚未初始化」而没有任何入口）。用户的原话是「我希望能在侧边栏打开查看详情，
 * 就像 git 插件一样」—— 于是参考 obsidian-git 的面板补成了现在这份：
 * 状态摘要（远端 / 领先落后）、冲突区、分组的更改列表（逐个文件
 * 暂存与取消暂存、点文件名打开、在远端打开）、最近提交（点 hash 在远端查看）。
 *
 * ## 顶部只有一行
 *
 * 2026-09-19：用户要求去掉面板内的「源码控制」标题，并把「标题右边的刷新按钮」
 * 「四个动作按钮」「下一行的分支下拉」并成一行 —— 侧边栏里垂直空间比横向更稀缺。
 * 同一天稍后又指定了顺序：**分步动作在左、立即同步在右、刷新最右**；体积那两块
 * （仓库大小 / 待提交改动）也从两行改成并排两栏。见 `renderToolbar` 与 `renderRepo`。
 *
 * 仍然**刻意不做**的（PLAN.md 的「明确不做」清单）：树形目录、hunk 级暂存、
 * blame、diff 视图。这些是 obsidian-git 那个 3k 行可选增强的部分，
 * 需要的不只是界面 —— diff 视图意味着要自己做一套编辑器内渲染。
 *
 * ## 状态是活的
 *
 * 面板打开后会一直挂着，而状态会在它背后变（自动提交定时器到点、库外的编辑器
 * 改了文件、命令面板触发了一次拉取）。所以 `onOpen` 里订阅 `service.onStatusChange`
 * —— 谁刷新了状态谁就通知这个面板重绘，而不是让面板自己轮询。
 *
 * 两处渲染守卫都是必需的，各挡住一个真实的问题，见 `render` 与 `run` 的注释。
 */

export const SYNC_VIEW_TYPE = "obsync-sync-view";

/** 历史里显示多少条提交。面板窄，再多也读不完，而每次都要跑一次 git log。 */
const HISTORY_LIMIT = 10;

export interface SourceControlViewDeps {
    service: SyncService;
    git: SimpleGitManager;
    /**
     * **每次渲染时取**文案，不要传 `t` 本身。
     *
     * 视图是**常驻**的（打开后一直挂在侧边栏），构造时快照 `t` 会让它
     * 在切换语言后一直显示旧语言 —— 这就是 `StatusBar` 踩过的那个坑
     * （见 statusBar.ts 里 `getT` 的说明），全项目统一用这个约定。
     */
    getT: () => LocaleStrings;
    /** 打开「编辑远端地址」弹窗。 */
    onEditRemote: () => void;
    /** 初始化仓库（含 .gitignore，以及给用户的那两条提示），由主类实现。 */
    onInitRepo: () => void;
    /** 在浏览器里打开某个文件 / 某条提交的远端页面。 */
    onOpenFileOnRemote: (path: string) => void;
    onOpenCommitOnRemote: (hash: string) => void;
}

export class SourceControlView extends ItemView {
    /** 正在渲染（含它内部的 await）。见 `render`。 */
    private rendering = false;
    /** 视图自己发起的动作进行中。见 `run`。 */
    private acting = false;
    private unsubscribe: (() => void) | undefined;

    constructor(
        leaf: WorkspaceLeaf,
        private readonly deps: SourceControlViewDeps
    ) {
        super(leaf);
    }

    getViewType(): string {
        return SYNC_VIEW_TYPE;
    }

    getDisplayText(): string {
        return this.deps.getT().sync.viewTitle;
    }

    getIcon(): string {
        return "git-fork";
    }

    async onOpen(): Promise<void> {
        // 订阅要在首次渲染**之前**挂上：首渲染里的 `service.refresh()` 会通知
        // 订阅者，早挂一次就能顺带把那一刻的状态也画进去。
        this.unsubscribe = this.deps.service.onStatusChange(() => {
            // 自己发起的动作不在这里重绘 —— `run` 会在动作结束后渲染一次，
            // 两处都渲染就会白跑一遍 git status。
            if (this.acting) return;
            void this.render();
        });
        await this.render();
    }

    async onClose(): Promise<void> {
        this.unsubscribe?.();
        this.unsubscribe = undefined;
        this.contentEl.empty();
    }

    /**
     * 渲染整个面板。
     *
     * **必须防重入。** `render()` 里会调 `service.refresh()`，而 refresh 会通知
     * 订阅者，订阅者又调 `render()` —— 没有这个标志就是无限递归：面板一打开
     * 就栈溢出，而且因为是被 promise 链吞掉的，界面上只会看到**一片空白**。
     */
    private async render(): Promise<void> {
        if (this.rendering) return;
        this.rendering = true;
        try {
            await this.renderContent();
        } finally {
            this.rendering = false;
        }
    }

    private async renderContent(): Promise<void> {
        const { contentEl } = this;
        const t = this.deps.getT();

        contentEl.empty();

        // 状态先拿到：工具条里的分支下拉属于它，而「不是仓库」时那一格要空着
        // （没有分支可切，也不该显示一个假的当前分支）。
        const status = await this.deps.service.refresh();
        await this.renderToolbar(contentEl, status);

        if (!status) {
            // 不是仓库时的**出路**：原来只有一句提示，用户只能自己去命令面板
            // 找「初始化仓库」。这里直接把入口放在眼前。
            const box = contentEl.createDiv({ cls: "obsync-view-empty" });
            box.createEl("p", { text: t.sync.notARepo, cls: "obsync-empty" });
            new Setting(box).addButton((button) =>
                button.setButtonText(t.sync.actInit).setCta().onClick(() => this.deps.onInitRepo())
            );
            return;
        }

        await this.renderRepo(contentEl, status);
        this.renderConflicts(contentEl, status);
        this.renderChanges(contentEl, status);
        await this.renderHistory(contentEl);
    }

    // ── 工具条 ────────────────────────────────────────────────────────────

    /**
     * 顶部工具条：提交 / 拉取 / 推送、分支下拉、立即同步、刷新，**都在一行**。
     *
     * 这里原来是三行 ——「源码控制」标题 + 刷新按钮、四个动作、分支下拉各占一行。
     * 标题不携带任何信息（标签页上已经写着视图名了）却占掉侧边栏一行；分支下拉
     * 独占一行更是浪费 —— 侧边栏本来就窄，垂直空间才是稀缺的。
     *
     * **排布是用户指定的**（2026-09-19 晚，第二次调整）：三个分步动作在左，
     * 立即同步在右，刷新在最右。立即同步是「一个顶三个」的那一下，放在收尾处
     * 也符合手感；刷新是随时可点的工具，压在边上不抢视线。
     *
     * 曾经这里还有第五个按钮「提交并推送」（= 立即同步去掉拉取）。用户判定它是
     * 多余的：立即同步已经是万全之策，而「不想拉取」的人用「提交」+「推送」
     * 两步就够 —— 于是连同命令与服务方法一起删掉了（别再加回来，除非有人
     * 真需要「不拉取」的单步动作）。
     *
     * 侧边栏窄，五个按钮加一个下拉框一行多半放不下 —— 交给 CSS
     * （`.obsync-actions`）换行，总比溢出把控件挤没了好。
     */
    private async renderToolbar(
        contentEl: HTMLElement,
        status: RepoStatus | undefined
    ): Promise<void> {
        const t = this.deps.getT();

        const row = new Setting(contentEl).setClass("obsync-actions");

        row.addButton((button) =>
            button
                .setButtonText(t.sync.actCommit)
                .setTooltip(t.sync.actCommitHint)
                .onClick(() =>
                    void this.run(() => this.deps.service.commitAll({ announce: true }))
                )
        );
        row.addButton((button) =>
            button
                .setButtonText(t.sync.actPull)
                .onClick(() => void this.run(() => this.deps.service.pull()))
        );
        row.addButton((button) =>
            button
                .setButtonText(t.sync.actPush)
                .setTooltip(t.sync.actPushHint)
                .onClick(() =>
                    void this.run(() => this.deps.service.push({ announceIfUpToDate: true }))
                )
        );

        if (status) await this.addBranchDropdown(row, status);

        row.addButton((button) => {
            button
                .setButtonText(t.sync.actSync)
                .setTooltip(t.sync.actSyncHint)
                .setCta()
                .onClick(() =>
                    void this.run(() => this.deps.service.sync({ announceInSync: true }))
                );
            // 侧边栏够宽时用 `margin-left: auto` 把它顶到右侧（见 styles.css）——
            // 要的是「在右侧」这个位置，而不只是「排在后面」。
            button.buttonEl.addClass("obsync-action-sync");
        });

        row.addExtraButton((button) =>
            button
                .setIcon("refresh-cw")
                .setTooltip(t.sync.actRefresh)
                .onClick(() => void this.render())
        );
    }

    /**
     * 分支下拉框 —— 工具条里没有「分支」两个字的位置了，所以那个标签挪到
     * `aria-label` 上：视觉上靠下拉框里的分支名自证，读屏仍然听得出它是什么。
     */
    private async addBranchDropdown(row: Setting, status: RepoStatus): Promise<void> {
        const t = this.deps.getT();
        const branches = await this.safeListBranches();

        row.addDropdown((dropdown) => {
            dropdown.selectEl.setAttribute("aria-label", t.sync.branchLabel);

            if (status.branch === null) {
                // 游离 HEAD：没有分支可切，但**这件事必须说出来** —— 这一格
                // 是它唯一的落点，藏起来的话用户只会觉得「少了点什么」。
                dropdown.addOption("", t.sync.detachedHeadLabel);
                dropdown.setValue("");
                dropdown.setDisabled(true);
                return;
            }
            const current = status.branch;

            if (branches.length === 0) {
                // 列不出分支（git 出错，或仓库还没有任何分支）。这时给一个
                // 能切的下拉框是**假象** —— 里面只有它自己，选了也不会有事发生。
                dropdown.addOption(current, current);
                dropdown.setValue(current);
                dropdown.setDisabled(true);
                return;
            }

            for (const branch of branches) dropdown.addOption(branch.name, branch.name);
            // 状态里的当前分支不一定在 listBranches 的结果里（别的窗口刚切过），
            // 少了这个补位，下拉框会显示成空的。
            if (!branches.some((branch) => branch.name === current)) {
                dropdown.addOption(current, current);
            }
            dropdown.setValue(current);
            // 走 service 而不是 git：切分支要排在同步队列里，否则可能与
            // 正在跑的拉取/提交并发写索引（视图原来就是直接调 git.checkout）。
            dropdown.onChange((value) =>
                void this.run(() => this.deps.service.checkoutBranch(value))
            );
        });
    }

    // ── 状态摘要：远端 / 领先落后 ─────────────────────────────────────────

    private async renderRepo(contentEl: HTMLElement, status: RepoStatus): Promise<void> {
        const t = this.deps.getT();

        const remoteUrl = await this.safeRemoteUrl();
        const remoteRow = new Setting(contentEl).setName(t.sync.remoteLabel);
        // 远端地址可能带着令牌（用户早先在别处配的，或在「编辑远端地址」里粘的），
        // 而这一行会**显示在屏幕上**。所以回显前统一脱敏。
        remoteRow.setDesc(remoteUrl ? redactUrl(remoteUrl) : t.sync.noRemote);
        remoteRow.addExtraButton((button) =>
            button
                .setIcon("settings-2")
                .setTooltip(t.sync.actEditRemote)
                .onClick(() => this.deps.onEditRemote())
        );

        contentEl.createEl("p", {
            text: remoteStateText(status, t),
            cls: isFullyInSync(status)
                ? "obsync-remote-state obsync-remote-synced"
                : "obsync-remote-state",
        });

        // 体积两栏：仓库多大、这次要提交多少。两个问题不一样（见 repoSize.ts 的说明），
        // 但都是「一个标签 + 一个数值」，各占一行太浪费侧边栏的垂直空间 ——
        // 用户要求横向排成一行两栏（`.obsync-metrics` 是个 flex 容器）。
        // 取不到体积就写「读不到」—— 不编一个 0 B，那会被当成「空仓库」。
        const repoSize = await this.safeRepoSize();
        const pending = changeRows(status);
        const pendingBytes = await this.deps.service.pendingChangeBytes(status);

        const metrics = contentEl.createDiv({ cls: "obsync-metrics" });
        new Setting(metrics)
            .setName(t.sync.repoSizeLabel)
            .setDesc(
                repoSize
                    ? t.sync.repoSizeDesc(formatBytes(repoSize.bytes), repoSize.objects)
                    : t.sync.sizeUnknown
            );
        new Setting(metrics)
            .setName(t.sync.pendingChangesLabel)
            .setDesc(
                pending.length === 0
                    ? t.sync.nothingToCommit
                    : t.sync.pendingChangesDesc(formatBytes(pendingBytes), pending.length)
            );
    }

    // ── 冲突 ──────────────────────────────────────────────────────────────

    private renderConflicts(contentEl: HTMLElement, status: RepoStatus): void {
        if (status.conflicted.length === 0) return;
        const t = this.deps.getT();

        new Setting(contentEl)
            .setName(t.sync.sectionConflicts(status.conflicted.length))
            .setDesc(t.sync.conflictHint)
            .setHeading()
            .addButton((button) =>
                button
                    .setButtonText(t.sync.actAbortMerge)
                    .setWarning()
                    .onClick(() => void this.run(() => this.deps.service.abortMerge()))
            );

        const list = contentEl.createDiv({ cls: "obsync-change-list" });
        for (const path of status.conflicted) {
            // 冲突行**不提供暂存开关**：`git add` 会让 git 认为冲突已解决，
            // 而这个面板看不到文件内容 —— 用户可能没改就把带 <<<<<<< 的文件
            // 暂存并提交上去。这里的职责是「告诉你哪些文件要处理 + 给你出路」。
            this.renderFileRow(list, { path, mark: "⚠", conflicted: true });
        }
    }

    // ── 更改列表 ──────────────────────────────────────────────────────────

    private renderChanges(contentEl: HTMLElement, status: RepoStatus): void {
        const t = this.deps.getT();
        const rows = changeRows(status);
        const staged = rows.filter((row) => row.staged);
        const unstaged = rows.filter((row) => !row.staged);

        if (rows.length === 0) {
            contentEl.createEl("p", { text: t.sync.nothingToCommit, cls: "obsync-empty" });
            return;
        }

        // 「已暂存」在前 —— 马上要被提交的是它们，用户最先想知道的是这个。
        this.renderChangeGroup(contentEl, t.sync.sectionStaged(staged.length), staged, true);
        this.renderChangeGroup(
            contentEl,
            t.sync.sectionChanges(unstaged.length),
            unstaged,
            false
        );
    }

    private renderChangeGroup(
        contentEl: HTMLElement,
        title: string,
        rows: ChangeRow[],
        staged: boolean
    ): void {
        if (rows.length === 0) return;
        const t = this.deps.getT();
        const paths = rows.map((row) => row.path);

        new Setting(contentEl)
            .setName(title)
            .setHeading()
            .addButton((button) =>
                button
                    .setButtonText(staged ? t.sync.actUnstageAll : t.sync.actStageAll)
                    .onClick(() =>
                        void this.run(() =>
                            staged
                                ? this.deps.service.unstageFiles(paths)
                                : this.deps.service.stageFiles(paths)
                        )
                    )
            );

        const list = contentEl.createDiv({ cls: "obsync-change-list" });
        for (const row of rows) {
            this.renderFileRow(list, {
                path: row.path,
                mark: markOf(row.status),
                staged: row.staged,
            });
        }
    }

    /**
     * 一行文件：状态位 + 可点开的文件名 + 「在远端打开」+「暂存 / 取消暂存」。
     *
     * 用 `Setting` 而不是裸 DOM：控件由 Obsidian 渲染，主题、键盘、无障碍
     * 都不用自己管；测试里也能直接驱动这些控件（`createdSettings` 那套）。
     */
    private renderFileRow(list: HTMLElement, spec: FileRowSpec): void {
        const t = this.deps.getT();
        const row = new Setting(list).setClass("obsync-change-row");
        // 一次只传一个类名：`setClass` 最终落到 `classList.add()`，
        // 而带空格的字符串在真实 DOM 里会抛 InvalidCharacterError。
        if (spec.conflicted) row.setClass("obsync-conflict");

        // 文件名做成可点的 —— 点开对应笔记去改，是看到「这个文件变了」之后
        // 最自然的下一步。这里重建 nameEl 的内容只是为了把状态位和路径分成
        // 两个元素（一个带样式、一个可点）。
        row.nameEl.empty();
        row.nameEl.createSpan({ text: spec.mark, cls: "obsync-change-mark" });
        const link = row.nameEl.createSpan({ text: spec.path, cls: "obsync-change-path" });
        link.setAttribute("title", t.sync.actOpenFile);
        link.addEventListener("click", () => void this.openFile(spec.path));

        row.addExtraButton((button) =>
            button
                .setIcon("external-link")
                .setTooltip(t.sync.actOpenFileOnRemote)
                .onClick(() => this.deps.onOpenFileOnRemote(spec.path))
        );

        if (spec.staged === undefined) return;

        const staged = spec.staged;
        row.addExtraButton((button) =>
            button
                .setIcon(staged ? "minus" : "plus")
                .setTooltip(staged ? t.sync.actUnstage : t.sync.actStage)
                .onClick(() =>
                    void this.run(() =>
                        staged
                            ? this.deps.service.unstageFiles([spec.path])
                            : this.deps.service.stageFiles([spec.path])
                    )
                )
        );
    }

    // ── 最近提交 ──────────────────────────────────────────────────────────

    private async renderHistory(contentEl: HTMLElement): Promise<void> {
        const t = this.deps.getT();
        new Setting(contentEl).setName(t.sync.sectionHistory).setHeading();

        const commits = await this.safeLog();
        if (!commits) {
            contentEl.createEl("p", { text: t.sync.historyFailed, cls: "obsync-empty" });
            return;
        }
        if (commits.length === 0) {
            contentEl.createEl("p", { text: t.sync.historyEmpty, cls: "obsync-empty" });
            return;
        }

        const list = contentEl.createDiv({ cls: "obsync-history" });
        for (const commit of commits) {
            const row = list.createDiv({ cls: "obsync-commit" });

            const hash = row.createSpan({ text: commit.shortHash, cls: "obsync-commit-hash" });
            hash.setAttribute("title", t.sync.commitOnRemote);
            hash.addEventListener("click", () => this.deps.onOpenCommitOnRemote(commit.hash));

            // 提交信息只取第一行：`git log` 的 message 可能是多行的
            // （合并提交、用户写了正文），面板里塞不下。
            row.createSpan({
                text: commit.message.split("\n")[0] ?? "",
                cls: "obsync-commit-message",
            });
            row.createSpan({
                text: `${commit.author} · ${shortDate(commit.date)}`,
                cls: "obsync-commit-meta",
            });
        }
    }

    // ── 动作与容错 ────────────────────────────────────────────────────────

    /**
     * 跑一个动作，然后重绘整个面板。
     *
     * **错误必须在这里报出去。** `SyncService` 只对「拉取冲突」与「没有远端」
     * 两种情况做了提示，其余错误（推送被拒、鉴权失败、找不到 git、网络问题）
     * 会原样上抛。早先这里静默吞掉，症状是：用户在视图里点「推送」，
     * 远端拒绝了，**界面上什么都不会发生** —— 连一句提示都没有。
     *
     * `acting` 标志让状态订阅在这期间不重绘：动作结束后下面那次 `render()`
     * 就够，两处都渲染会白跑一遍 git status（订阅是同步触发的，会先跑）。
     */
    private async run(action: () => Promise<unknown>): Promise<void> {
        this.acting = true;
        try {
            await action();
        } catch (err) {
            this.deps.service.deps.notifier.reportError(err);
        } finally {
            this.acting = false;
        }
        await this.render();
    }

    /** 在 Obsidian 里打开库里某个路径。 */
    private async openFile(path: string): Promise<void> {
        try {
            await this.app.workspace.openLinkText(path, "", false);
        } catch (err) {
            // 文件可能刚被删掉（状态是几秒前的），这时报出来比静默好 ——
            // 用户点了却没反应，只会以为面板坏了。
            this.deps.service.deps.notifier.reportError(err);
        }
    }

    private async safeListBranches(): Promise<Array<{ name: string; current: boolean }>> {
        try {
            return await this.deps.git.listBranches();
        } catch {
            return [];
        }
    }

    private async safeRemoteUrl(): Promise<string | undefined> {
        try {
            return await this.deps.git.getRemoteUrl();
        } catch {
            return undefined;
        }
    }

    private async safeLog(): Promise<CommitInfo[] | undefined> {
        try {
            return await this.deps.git.log(HISTORY_LIMIT);
        } catch {
            return undefined;
        }
    }

    /** 仓库体积；读不到时 undefined（面板显示「读不到」而不是编一个 0）。 */
    private async safeRepoSize(): Promise<RepoSize | undefined> {
        try {
            return await this.deps.git.repoSize();
        } catch {
            return undefined;
        }
    }
}

// ── 纯函数（可直接单测） ────────────────────────────────────────────────────

/** 渲染一行文件所需的全部信息。`staged` 为 undefined 表示不给暂存开关。 */
interface FileRowSpec {
    path: string;
    mark: string;
    staged?: boolean;
    conflicted?: boolean;
}

/**
 * 「本地和远端差多少」这一行的文案。
 *
 * `ahead` / `behind` 为 null 的语义是**没有 upstream**（见 `RepoStatus` 的注释），
 * 不是「0 个」—— 把它当 0 显示成「与远端一致」就正好说反了：那可能是
 * 一个从没推送过的分支，本地有几十个提交远端一个都没有。
 */
export function remoteStateText(status: RepoStatus, t: LocaleStrings): string {
    if (status.ahead === null || status.behind === null) return t.sync.noUpstreamHint;

    const parts: string[] = [];
    if (status.ahead > 0) parts.push(t.sync.aheadOf(status.ahead));
    if (status.behind > 0) parts.push(t.sync.behindOf(status.behind));
    return parts.length > 0 ? parts.join(" · ") : t.sync.inSyncWithRemote;
}

/** ISO 时间 → 简短的本地时间（`YYYY-MM-DD HH:mm`）。解不出来的原样返回。 */
export function shortDate(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;

    const pad = (value: number): string => String(value).padStart(2, "0");
    return (
        `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
        `${pad(date.getHours())}:${pad(date.getMinutes())}`
    );
}

function markOf(status: FileChangeStatus): string {
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
