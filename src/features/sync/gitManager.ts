import type { CommitInfo, FileChange, FileChangeStatus, RepoStatus, SyncOutcome, SyncStrategy } from "./types";

/**
 * Git 操作的抽象接口。
 *
 * 为什么要接口而不是直接用 simple-git：阶段一决策「仅桌面」，但接口层
 * 留扩展位是 PLAN.md 的既定设计（v2 若做移动端 isomorphic-git，只需新增实现）。
 * 同时接口也是单测的接缝 —— syncService 的测试可以注入内存实现。
 *
 * 错误约定：实现必须把 git 的失败翻译成 `errors.ts` 里的类型
 * （`GitNotRepoError` / `GitBinaryMissingError` / `ConflictError` / ...），
 * 上层不允许解析 git 的原始 stderr。
 *
 * 约定：这里的所有操作都**不带凭据参数** —— 鉴权由实现内部处理
 * （见 `auth.ts`），调用方不感知平台差异。
 *
 * 同步策略三态（pull 的 `strategy` 参数）：
 * - `merge`  —— fetch + merge（可能产生合并提交）
 * - `rebase` —— fetch + rebase（历史线性）
 * - `reset`  —— 本地分支直接指向远端提交（丢弃本地未推送提交，「强制以远端为准」）
 */
export interface GitManager {
    /** vault 是否已经是 git 仓库。git 目录损坏时返回 false 并记日志。 */
    isRepo(): Promise<boolean>;

    /** 初始化仓库（`git init`）。已初始化时是幂等操作。 */
    init(): Promise<void>;

    /** 当前状态快照。非仓库时抛 `GitNotRepoError`。 */
    status(): Promise<RepoStatus>;

    /** 暂存指定文件；`paths` 为空数组时暂存全部变更（`git add -A`）。 */
    stage(paths: string[]): Promise<void>;

    /** 取消暂存。 */
    unstage(paths: string[]): Promise<void>;

    /** 创建提交。没有可提交内容时返回 false 而不是报错。 */
    commit(message: string): Promise<boolean>;

    /** 拉取远端并按策略整合：详见实现处的策略说明。遇冲突抛 `ConflictError`。 */
    pull(strategy: SyncStrategy): Promise<SyncOutcome>;

    /** 放弃进行中的合并（冲突恢复的出路之一：回到 pull 之前的状态）。 */
    abortMerge(): Promise<void>;

    /** 推送。没有 upstream 时自动设置（`-u origin <branch>`）。远端拒绝时抛 `PushRejectedError`。 */
    push(): Promise<SyncOutcome>;

    /** 只取回远端信息不合并。用于状态栏的 ahead/behind 展示。 */
    fetch(): Promise<void>;

    /** 列出本地分支，`*` 标注当前分支的语义用 `current` 字段表达。 */
    listBranches(): Promise<Array<{ name: string; current: boolean }>>;

    /** 切换分支。工作区有未提交变更时由调用方决定先提交还是 stash。 */
    checkout(branch: string): Promise<void>;

    /** 创建并切换到新分支。 */
    createBranch(name: string): Promise<void>;

    /** 删除本地分支。 */
    deleteBranch(name: string): Promise<void>;

    /** 最近 N 条提交（当前分支）。 */
    log(limit: number): Promise<CommitInfo[]>;

    /** 远端 URL（origin）。没有远端时返回 undefined。 */
    getRemoteUrl(): Promise<string | undefined>;

    /** 设置 / 修改 origin 的 URL。 */
    setRemoteUrl(url: string): Promise<void>;

    /** 单个文件的变更明细（用于差异查看，v1 只列文件级状态）。 */
    fileChanges(): Promise<FileChange[]>;

    /**
     * 测试能否访问远端（**只读**，不改变任何东西）。
     *
     * 这是「鉴权配置对不对」的唯一权威检查：私有仓库令牌不对时，
     * 只有真的去连一次才知道 —— 光看配置项无法判断令牌是否有效。
     * 用 `ls-remote` 而不是 `fetch`：前者不写任何本地状态。
     *
     * @returns 远端引用数量（>= 0）。失败时抛 `errors.ts` 里的领域错误
     *          （`GitAuthError` / `NetworkError` / …），由上层翻译成提示。
     * @throws 没有配置远端时抛 `NoUpstreamError`。
     */
    testRemoteAccess(): Promise<number>;
}

/** simple-git 的状态字符 → 我们的领域类型。 */
export function mapStatusChar(index: string, workingDir: string): FileChangeStatus | undefined {
    if (index === "?" || workingDir === "?") return "untracked";
    if (index === "U" || workingDir === "U") return "conflicted";
    if (index === "A" || workingDir === "A") return "added";
    if (index === "D" || workingDir === "D") return "deleted";
    if (index === "R") return "renamed";
    if (index === "M" || workingDir === "M") return "modified";
    return undefined;
}
