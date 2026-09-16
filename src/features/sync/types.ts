/**
 * Git 同步的领域类型。
 *
 * 刻意不让 simple-git 的类型泄漏到本模块之外：
 * 上层（syncService / UI / 状态栏）只知道这里的形状，
 * 将来若换实现（比如支持其他 git 后端）不用动上层。
 */

/** 同步策略三态，对应 obsidian-git 的三种 pull 行为。 */
export type SyncStrategy = "merge" | "rebase" | "reset";

/** 单个文件的变更状态。 */
export type FileChangeStatus =
    | "added"
    | "modified"
    | "deleted"
    | "renamed"
    | "conflicted"
    | "untracked";

export interface FileChange {
    path: string;
    status: FileChangeStatus;
    /** 重命名时的新路径。 */
    previousPath?: string;
}

/** 仓库当前状态快照，状态栏与源码控制视图共用。 */
export interface RepoStatus {
    /** 当前分支名。游离 HEAD 时为 null。 */
    branch: string | null;
    staged: FileChange[];
    unstaged: FileChange[];
    /** 未跟踪文件单独列出 —— 提交前要不要带上它是个显式决策。 */
    untracked: FileChange[];
    /** 双方都改了的文件（未解决的冲突）。 */
    conflicted: string[];
    /** 本地领先远端的提交数。没有 upstream 时为 null。 */
    ahead: number | null;
    /** 落后远端的提交数。没有 upstream 时为 null。 */
    behind: number | null;
}

/** 提交历史条目。 */
export interface CommitInfo {
    hash: string;
    /** hash 的短形式（7 位），用于展示。 */
    shortHash: string;
    message: string;
    author: string;
    /** ISO 8601 时间戳。 */
    date: string;
}

/** 一次 pull / push 的结果。 */
export interface SyncOutcome {
    /** 实际发生了什么，UI 据此给用户反馈。 */
    kind:
        | "committed"
        | "pulled"
        | "pushed"
        | "nothing-to-commit"
        | "up-to-date"
        | "fast-forwarded"
        /** 拉取产生冲突，现场已保留并写好指南 —— 链路必须在这里停住。 */
        | "conflict";
    /** 拉取/推送影响的提交数。 */
    commits?: number;
    /** 拉取时更新的文件数。 */
    files?: number;
}

// ── 诊断 ────────────────────────────────────────────────────────────────────

/**
 * 一项诊断检查。
 *
 * `id` 是**类型码**而不是文案 —— 与错误处理同一套约定：逻辑层产出结构化结果，
 * 展示层按 id 取 locale 文案。这样诊断逻辑不依赖 i18n，也能被单独测试。
 */
export interface DiagnosticCheck {
    id:
        /** git 可执行文件是否可用。 */
        | "git"
        /** 当前库是否已是 git 仓库。 */
        | "repo"
        /** 是否配置了远端。 */
        | "remote"
        /** 远端平台是否可识别（决定能不能注入令牌）。 */
        | "platform"
        /** 能否访问远端 —— **鉴权是否有效就看这一条**。 */
        | "access";
    status: "ok" | "failed" | "skipped";
    /** 可选的补充说明（技术细节，非本地化文案）。 */
    detail?: string;
}

export interface DiagnosticsReport {
    checks: DiagnosticCheck[];
    /** 全部通过（跳过不算失败）。 */
    ok: boolean;
}
