import { simpleGit, type SimpleGit, type SimpleGitOptions } from "simple-git";
import { logger } from "../../core/logger";
import type { SecretStore } from "../../core/secretStore";
import { credentialForRemote, withAuth, type RemoteCredential } from "./auth";
import type { GitManager } from "./gitManager";
import {
    ConflictError,
    GitAuthError,
    GitBinaryMissingError,
    GitNotRepoError,
    NoUpstreamError,
    DetachedHeadError,
    PushRejectedError,
} from "./errors";
import type {
    CommitInfo,
    FileChange,
    RepoStatus,
    SyncOutcome,
    SyncStrategy,
} from "./types";
import { mapStatusChar } from "./gitManager";
import type { FileStatusResult, StatusResult } from "simple-git";

/**
 * 桌面端 GitManager：基于系统 git（simple-git 封装）。
 *
 * ## 与参考项目 obsidian-git 的实现差异
 *
 * - **鉴权**：它用 SSH_ASKPASS 脚本 + 文件监听 + 弹窗收集输入（交互式）；
 *   我们的令牌已在 secretStore 里，直接 `http.extraheader` 注入（见 `auth.ts`），
 *   不需要脚本和监听。
 * - **pull 的实现**：同它一样「先 fetch 再比较引用再整合」而不是裸 `git pull` ——
 *   这样能区分「远端没有新东西」和「整合失败」，也能在整合前拿到双方的提交号。
 * - **子模块**：v1 不做（PLAN.md 范围外），相关分支全部省略。
 * - **错误分派**：它把错误转成少数几类后多数原样上抛、靠字符串猜；
 *   这里统一在 `mapError` 一处收口成领域错误。
 */

/**
 * 识别「HEAD 还没有出生」（仓库建好但一次都没提交过）。
 *
 * 注意 git 的输出里 HEAD 是**带引号**的：`fatal: could not resolve 'HEAD'`。
 * 第一版正则写的是不带引号的 `could not resolve HEAD`，于是永远匹配不上，
 * 回退分支形同虚设 —— 表现为「全新仓库里取消暂存直接报错」。
 * 这里用 `['"\`]?` 容忍引号，同时保留其他措辞以覆盖不同 git 版本。
 */
const HEAD_UNBORN_RE =
    /could not resolve ['"`]?HEAD|unborn|unknown revision|ambiguous argument ['"`]?HEAD/i;

export interface SimpleGitManagerOptions {
    /** vault（git 仓库）的绝对路径。 */
    baseDir: string;
    /** git 可执行文件路径；空用 PATH 里的 git。 */
    gitPath?: string;
    /** 令牌存储。远端是 GitHub/Gitee 且有令牌时自动注入鉴权。 */
    secretStore?: SecretStore;
}

export class SimpleGitManager implements GitManager {
    private baseDir: string;
    private gitPath?: string;
    private readonly secretStore?: SecretStore;

    /** 实例缓存：远端 URL 变化时（setRemoteUrl）要重建以刷新鉴权。 */
    private git_: SimpleGit | undefined;
    private authedForRemote: string | undefined;

    constructor(options: SimpleGitManagerOptions) {
        this.baseDir = options.baseDir;
        this.gitPath = options.gitPath;
        this.secretStore = options.secretStore;
    }

    /** 设置变化后更新 gitPath（下次调用会重建 SimpleGit 实例）。 */
    applySettings(options: { gitPath?: string }): void {
        if (options.gitPath === this.gitPath) return;
        this.gitPath = options.gitPath;
        this.git_ = undefined;
        this.authedForRemote = undefined;
    }

    /** 按当前远端构造带鉴权的 SimpleGit 实例。 */
    private async git(): Promise<SimpleGit> {
        let remoteUrl: string | undefined;
        try {
            // 远端可能还不存在（刚 init）—— 取不到就当无鉴权实例。
            remoteUrl = await this.rawGetRemoteUrl();
        } catch {
            remoteUrl = undefined;
        }

        if (this.git_ && this.authedForRemote === remoteUrl) return this.git_;

        const credential = remoteUrl
            ? credentialForRemote(remoteUrl, this.secretStore!)
            : undefined;

        const options: Partial<SimpleGitOptions> = { baseDir: this.baseDir };
        if (this.gitPath) options.binary = this.gitPath;

        this.git_ = simpleGit(withAuth(options, credential));
        this.authedForRemote = remoteUrl;
        return this.git_;
    }

    private async revalidateAuth(): Promise<void> {
        this.git_ = undefined;
        this.authedForRemote = undefined;
        await this.git();
    }

    // ── 仓库 ──────────────────────────────────────────────────────────────

    async isRepo(): Promise<boolean> {
        try {
            const git = await this.git();
            return await git.checkIsRepo();
        } catch (err) {
            // 只有「git 都跑不起来」才算失败；目录不是仓库时 checkIsRepo 返回 false。
            throw mapError(err, "checking repository state");
        }
    }

    async init(): Promise<void> {
        const git = await this.git();
        await git.init();
    }

    // ── 状态 ──────────────────────────────────────────────────────────────

    async status(): Promise<RepoStatus> {
        const git = await this.git();
        if (!(await git.checkIsRepo())) {
            // 技术性描述，用户文案由 describeSyncError 拼（见 mapError 的说明）。
            throw new GitNotRepoError("status: not a git repository");
        }
        const raw = await wrap("reading status", () => git.status());
        return mapStatus(raw);
    }

    async fileChanges(): Promise<FileChange[]> {
        const status = await this.status();
        return [...status.staged, ...status.unstaged, ...status.untracked];
    }

    // ── 暂存与提交 ────────────────────────────────────────────────────────

    async stage(paths: string[]): Promise<void> {
        const git = await this.git();
        await wrap("staging files", () =>
            paths.length > 0 ? git.add(paths) : git.add("-A")
        );
    }

    async unstage(paths: string[]): Promise<void> {
        const git = await this.git();
        try {
            // restore --staged 对已跟踪与新增文件都成立，但要求 HEAD 存在。
            await wrap("unstaging files", () =>
                git.raw(["restore", "--staged", "--", ...paths])
            );
        } catch (err) {
            // 全新仓库还没有任何提交（HEAD 未出生），restore 拿不到基准；
            // 等价做法是把文件从 index 里摘掉、保留工作区内容。
            const message = err instanceof Error ? err.message : String(err);
            if (!HEAD_UNBORN_RE.test(message)) {
                throw mapError(err, "unstaging files");
            }
            await wrap("unstaging files (no HEAD)", () =>
                git.raw(["rm", "--cached", "--", ...paths])
            );
        }
    }

    async commit(message: string): Promise<boolean> {
        const git = await this.git();
        try {
            const result = await git.commit(message);
            // simple-git 对「nothing to commit」不抛错，返回 changes=0 的摘要。
            const summary = Array.isArray(result) ? result[0]!.summary : result.summary;
            return summary.changes > 0;
        } catch (err) {
            if (isNothingToCommit(err)) return false;
            throw mapError(err, "committing");
        }
    }

    // ── 远端操作 ──────────────────────────────────────────────────────────

    /**
     * 拉取并整合。
     *
     * 流程照搬 obsidian-git 验证过的形态：
     * `fetch` → 比较本地/远端引用 → 没有新东西直接返回 →
     * 按策略整合 → 用两次引用的 diff 统计受影响文件。
     *
     * merge/rebase 失败时检查冲突文件：有冲突就抛 `ConflictError`
     * （仓库留在冲突状态，等用户处理或 abortMerge）；否则抛原始错误。
     */
    async pull(strategy: SyncStrategy): Promise<SyncOutcome> {
        const git = await this.git();

        const status = await wrap("reading status before pull", () => git.status());
        if (!status.current || !status.tracking) {
            // 技术性描述；用户文案由 describeSyncError 按类型拼。
            throw new NoUpstreamError("pull: current branch has no tracking remote branch");
        }

        const localCommit = await wrap("resolving local head", () =>
            git.revparse([status.current!])
        );

        await wrap("fetching", () => git.fetch());

        const upstreamCommit = await wrap("resolving remote head", () =>
            git.revparse([status.tracking!])
        );

        if (localCommit === upstreamCommit) {
            return { kind: "up-to-date" };
        }

        try {
            if (strategy === "merge") {
                await git.merge([status.tracking]);
            } else if (strategy === "rebase") {
                await git.rebase([status.tracking]);
            } else {
                await this.resetToRemote(git, upstreamCommit);
            }
        } catch (err) {
            const conflicted = await this.conflictedFiles(git);
            if (conflicted.length > 0) {
                // 消息是技术性描述；`files` 才是给用户看的（数量与清单）。
                throw new ConflictError(
                    `pull (${strategy}): ${conflicted.length} conflicted file(s)`,
                    conflicted,
                    { cause: err }
                );
            }
            throw mapError(err, `pulling (${strategy})`);
        }

        const afterCommit = await wrap("resolving head after pull", () =>
            git.revparse([status.current!])
        );
        const diff = await wrap("diffing pulled changes", () =>
            git.raw(["diff", "--name-only", `${localCommit}..${afterCommit}`])
        );
        const files = diff.split(/\r\n|\r|\n/).filter((line) => line.length > 0);

        return { kind: "pulled", files: files.length };
    }

    /**
     * reset 策略的实现：「以远端为准」。
     *
     * 参考项目 obsidian-git 用 update-ref + 普通_reset_，那会让工作区停在
     * 旧内容、与移动后的 HEAD 脱节 —— 下一次自动提交会把远端的修改倒推回去。
     * 这里用 `reset --hard` 真正对齐；为避免不可恢复的丢失，先把未提交改动
     * （含未跟踪文件）stash 起来，用户仍可从 stash 里找回。
     */
    private async resetToRemote(git: SimpleGit, upstreamCommit: string): Promise<void> {
        // 冲突现场先放弃（merge/rebase --abort），reset 的语义就是放弃本地整合。
        try {
            const pre = await git.status();
            if (pre.conflicted.length > 0) {
                await this.abortMerge();
            }
            const mid = await git.status();
            if (mid.files.length > 0) {
                await git.stash([
                    "push",
                    "--include-untracked",
                    "--message",
                    "OBSync: auto-stash before reset pull",
                ]);
            }
        } catch (err) {
            logger.debug("pre-reset stash skipped", err);
        }
        await git.raw(["reset", "--hard", upstreamCommit]);
    }

    async abortMerge(): Promise<void> {
        const git = await this.git();
        // merge --abort 对「不在合并中」的仓库会报错，这里吞掉 ——
        // 调用方是「有冲突就放弃」的恢复路径，多余调用不是错误。
        try {
            await git.raw(["merge", "--abort"]);
        } catch (err) {
            logger.debug("merge --abort failed (probably not merging)", err);
        }
        try {
            await git.raw(["rebase", "--abort"]);
        } catch (err) {
            logger.debug("rebase --abort failed (probably not rebasing)", err);
        }
    }

    async push(): Promise<SyncOutcome> {
        const git = await this.git();

        const status = await wrap("reading status before push", () => git.status());
        if (!status.current) {
            throw new DetachedHeadError("push: HEAD is detached");
        }

        await wrap("pushing", () => git.push(["-u", "origin", status.current!]));
        return { kind: "pushed" };
    }

    async fetch(): Promise<void> {
        const git = await this.git();
        await wrap("fetching", () => git.fetch());
    }

    // ── 分支 ──────────────────────────────────────────────────────────────

    async listBranches(): Promise<Array<{ name: string; current: boolean }>> {
        const git = await this.git();
        const summary = await wrap("listing branches", () => git.branchLocal());
        return Object.values(summary.branches).map((branch) => ({
            name: branch.name,
            current: branch.current,
        }));
    }

    async checkout(branch: string): Promise<void> {
        const git = await this.git();
        await wrap(`checking out ${branch}`, () => git.checkout(branch));
    }

    async createBranch(name: string): Promise<void> {
        const git = await this.git();
        await wrap(`creating branch ${name}`, () =>
            git.raw(["checkout", "-b", name])
        );
    }

    async deleteBranch(name: string): Promise<void> {
        const git = await this.git();
        await wrap(`deleting branch ${name}`, () => git.deleteLocalBranch(name));
    }

    async log(limit: number): Promise<CommitInfo[]> {
        const git = await this.git();
        // 注意选项键：simple-git 把对象键转成 --max-count=N；写成 max 会原样传给 git 报错。
        const result = await wrap("reading log", () => git.log({ maxCount: limit }));
        return result.all.map((entry) => ({
            hash: entry.hash,
            shortHash: entry.hash.slice(0, 7),
            message: entry.message,
            author: entry.author_name,
            // simple-git 默认的 date 就是 ISO 字符串，直接透传。
            date: new Date(entry.date).toISOString(),
        }));
    }

    // ── 远端地址 ──────────────────────────────────────────────────────────

    async getRemoteUrl(): Promise<string | undefined> {
        return this.rawGetRemoteUrl();
    }

    private async rawGetRemoteUrl(): Promise<string | undefined> {
        const options: Partial<SimpleGitOptions> = { baseDir: this.baseDir };
        if (this.gitPath) options.binary = this.gitPath;
        const git = simpleGit(options);
        const remotes = await git.getRemotes(true);
        const origin = remotes.find((remote) => remote.name === "origin");
        return origin?.refs.push ?? origin?.refs.fetch;
    }

    async setRemoteUrl(url: string): Promise<void> {
        const git = await this.git();
        const remotes = await wrap("listing remotes", () => git.getRemotes());
        const exists = remotes.some((remote) => remote.name === "origin");
        if (exists) {
            await wrap("setting remote url", () =>
                git.remote(["set-url", "origin", url])
            );
        } else {
            await wrap("adding remote", () => git.addRemote("origin", url));
        }
        // 远端变了鉴权对象可能也变了（GitHub → Gitee）。
        await this.revalidateAuth();
    }

    // ── 内部 ──────────────────────────────────────────────────────────────

    private async conflictedFiles(git: SimpleGit): Promise<string[]> {
        try {
            const status = await git.status();
            return status.conflicted;
        } catch {
            return [];
        }
    }
}

// ── 状态映射 ────────────────────────────────────────────────────────────────

function mapStatus(raw: StatusResult): RepoStatus {
    const staged: FileChange[] = [];
    const unstaged: FileChange[] = [];
    const untracked: FileChange[] = [];

    for (const file of raw.files as FileStatusResult[]) {
        const change = toFileChange(file);
        if (!change) continue;

        if (change.status === "untracked") {
            untracked.push(change);
            continue;
        }

        // 同一个文件可能既有暂存部分又有未暂存部分（改了又改），
        // simple-git 会把它拆成两条 —— 按各自的状态位归类。
        if (file.index !== " " && file.index !== "?") staged.push(change);
        if (file.working_dir !== " " && file.working_dir !== "?") {
            unstaged.push(change);
        }
    }

    return {
        branch: raw.current ?? null,
        staged,
        unstaged,
        untracked,
        conflicted: raw.conflicted,
        // simple-git 在没有 upstream 时 ahead/behind 均为 0，无法与「真 0」区分，
        // 所以用 tracking 的有无来表达 null 语义。
        ahead: raw.tracking ? raw.ahead : null,
        behind: raw.tracking ? raw.behind : null,
    };
}

function toFileChange(file: FileStatusResult): FileChange | undefined {
    const status = mapStatusChar(file.index, file.working_dir);
    if (!status) {
        logger.debug(`unrecognized git status chars: ${file.index}/${file.working_dir} for ${file.path}`);
        return undefined;
    }
    return {
        path: file.path,
        status,
        previousPath: file.from,
    };
}

// ── 错误映射 ────────────────────────────────────────────────────────────────

/**
 * 把 simple-git 的错误翻译成领域错误。
 *
 * 只依赖错误文本做分类是无奈之举（git 的退出码不区分鉴权与网络），
 * 所以匹配词表尽量取自 git 各版本的稳定输出，宁漏勿错 ——
 * 认不出来的原样上抛，调用方还能看到原始信息。
 *
 * **这里抛的 message 是技术性描述，不是给用户看的话。**
 * 本层拿不到 `t`（纯逻辑不该依赖 i18n），所以只写清「在做什么时失败了 + git 的原话」，
 * 面向用户的文案由 `describeSyncError` 在展示层按类型拼。
 * 早期版本把中文文案直接写在这里，结果英文界面下会冒出中文 —— 别再走回头路。
 */
function mapError(err: unknown, what: string): Error {
    const message = err instanceof Error ? err.message : String(err);
    const detail = `${what}: ${message}`;

    if (/spawn .* ENOENT|command not found|not recognized as/i.test(message)) {
        return new GitBinaryMissingError(`git executable not found (${detail})`, {
            cause: err,
        });
    }
    if (/not a git repository/i.test(message)) {
        return new GitNotRepoError(`not a git repository (${detail})`, { cause: err });
    }
    if (
        /authentication failed|could not read username|invalid username or password|access denied|http basic/i.test(
            message
        )
    ) {
        return new GitAuthError(`remote authentication failed (${detail})`, {
            cause: err,
        });
    }
    if (/non-fast-forward|fetch first|updates were rejected|failed to push/i.test(message)) {
        return new PushRejectedError(`push rejected by remote (${detail})`, {
            cause: err,
        });
    }
    return err instanceof Error ? err : new Error(message);
}

function isNothingToCommit(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err);
    return /nothing to commit|nothing added to commit/i.test(message);
}

/** 统一给 git 调用包一层错误映射。 */
async function wrap<T>(what: string, run: () => Promise<T>): Promise<T> {
    try {
        return await run();
    } catch (err) {
        throw mapError(err, what);
    }
}

/** 重新导出，避免上层直接 import auth.ts 的内部细节。 */
export type { RemoteCredential };
