import { simpleGit, type SimpleGit, type SimpleGitOptions } from "simple-git";
import { logger } from "../../core/logger";
import type { SecretStore } from "../../core/secretStore";
import { credentialForRemote, withAuth, type RemoteCredential } from "./auth";
import type { GitManager } from "./gitManager";
import {
    ConflictError,
    GitAuthError,
    GitBinaryMissingError,
    GitCredentialUsernameRejectedError,
    GitNotRepoError,
    GitTimeoutError,
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

/**
 * 「一个字节的输出来都没有」多久就认定卡死（毫秒）。
 *
 * simple-git 的 `timeout.block` 是**无输出**超时：只要 git 还在往
 * stdout/stderr 写东西（拉取的进度、推送的对象计数都在 stderr 上），计时就重置。
 * 所以它拦的是「完全僵住」，而不是「大仓库比较慢」。
 *
 * 为什么必须有这条出路：这里是 Obsidian 的界面进程 —— 没有人能回答 git 的提问，
 * 也没有 Ctrl+C。没有超时的话，一次卡住会**永久**占住同步队列
 * （`isBusy` 一直为 true，自动定时器一直跳过），用户只能重载插件。
 *
 * 120 秒的依据是本机实测的网络动作：Gitee `ls-remote` 1.7 秒、
 * GitHub 冷连接 17~25 秒（见第七节第 19 条）。真正毫无输出的两分钟不可能是正常传输。
 */
const GIT_BLOCK_TIMEOUT_MS = 120_000;

/**
 * 绝不让「人机交互」挂住 git。
 *
 * ## 为什么必须禁掉
 *
 * git 拿不到凭据时会**问用户**（终端提问，或 Windows 上 Git Credential Manager
 * 的弹窗 —— 实测环境里 `credential.helper` 就是 PortableGit 带的 GCM）。
 * Obsidian 里没有人能回答它：那个提问读的 stdin 是一根没人写的管子，
 * 命令就这么挂着。症状是状态栏永远停在「正在推送…」，而且**没有任何报错**。
 *
 * - `GIT_TERMINAL_PROMPT=0` —— git 自己的终端提问直接失败，报
 *   `could not read Username ... terminal prompts disabled`，被 `mapError`
 *   归到鉴权失败，于是用户得到「请检查访问令牌」这句有用的话。
 * - `GCM_INTERACTIVE=never` —— GCM 只用已经存好的凭据，不再弹窗。
 *   **注意它禁的是「问人」，不是「用凭据」**：依赖系统凭据助手的那类用户
 *   （自建 GitLab / 内网 git，见设置页的说明）照常能用。
 */
const GIT_NONINTERACTIVE_ENV = {
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
} as const;

/**
 * 构造 simple-git 实例。
 *
 * **所有 spawn 路径都要走这里。** 之前有两处各自 `simpleGit(options)`：
 * `git()`（带鉴权）与 `rawGetRemoteUrl()`（不带）—— 逐处补设置必然漏一处，
 * 而漏掉的那一处照样能挂住整个同步。
 *
 * 导出是为了能单独验「非交互环境变量与超时真的挂上去了」：这两条只能验
 * 「我们交给了库什么」，库内部的行为（超时到点 kill 掉子进程）由它自己的
 * 实现保证，而**要观察它就得真造一个卡死的 git 进程** —— 那正是它要防的事。
 */
export function createGitInstance(options: {
    baseDir: string;
    gitPath?: string;
    /** `-c key=value`，来自 `withAuth()` 的令牌注入。 */
    config?: string[];
}): SimpleGit {
    const instanceOptions: Partial<SimpleGitOptions> = {
        baseDir: options.baseDir,
        timeout: { block: GIT_BLOCK_TIMEOUT_MS },
    };
    if (options.gitPath) instanceOptions.binary = options.gitPath;
    if (options.config && options.config.length > 0) instanceOptions.config = options.config;

    const instance = simpleGit(instanceOptions);
    for (const [name, value] of Object.entries(GIT_NONINTERACTIVE_ENV)) {
        instance.env(name, value);
    }
    return instance;
}

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

        this.git_ = createGitInstance({
            baseDir: this.baseDir,
            gitPath: this.gitPath,
            config: withAuth({}, credential).config,
        });
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

    /**
     * 测试远端可达性与鉴权（只读）。
     *
     * 用 `ls-remote` 而不是 `fetch`：前者不写任何本地状态（不动 refs、不动 index），
     * 纯粹是「能不能连上、凭据认不认」的探测。
     *
     * 这里**不吞异常** —— 让 `mapError` 把 git 的失败翻译成领域错误
     * （鉴权失败 → `GitAuthError`，连不上 → 原始网络错误），
     * 上层就能给出「令牌无效」和「网络不通」这两种完全不同的引导。
     */
    async testRemoteAccess(): Promise<number> {
        const remoteUrl = await this.rawGetRemoteUrl();
        if (!remoteUrl) {
            throw new NoUpstreamError("test remote access: no remote configured");
        }

        const git = await this.git();
        const output = await wrap("testing remote access", () =>
            git.raw(["ls-remote", "--heads", "origin"])
        );

        return output.split("\n").filter((line) => line.trim().length > 0).length;
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

        // `--progress` 是必需的，不是好看：git 在 stderr **不是终端**时默认
        // **不输出传输进度**（我们正是这种情况 —— 子进程的 stderr 是管道）。
        // 而上面那个无输出超时全靠「有没有输出」来判断死活：没有进度输出时，
        // 一次慢但正常的传输会被当成卡死杀掉。带上它，传输中就有输出 → 计时重置。
        await wrap("fetching", () => git.fetch(["--progress"]));

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

        // `--progress` 是必需的，不是好看：git 在 stderr **不是终端**时默认
        // **不输出传输进度**（我们正是这种情况 —— 子进程的 stderr 是管道）。
        // 而无输出超时全靠「有没有输出」判断死活：没有进度输出时，
        // 一次慢但正常的推送会被当成卡死杀掉。带上它，传输中就有输出 → 计时重置。
        await wrap("pushing", () => git.push(["--progress", "-u", "origin", status.current!]));
        return { kind: "pushed" };
    }

    async fetch(): Promise<void> {
        const git = await this.git();
        await wrap("fetching", () => git.fetch(["--progress"]));
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
        // 也走 createGitInstance：这条路径每次 `git()` 都会跑，
        // 而且同样会 spawn 一个 git 子进程（漏掉守卫就漏掉一个能挂住的地方）。
        const git = createGitInstance({
            baseDir: this.baseDir,
            gitPath: this.gitPath,
        });
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
/**
 * 把 git 的失败翻译成领域错误。
 *
 * 导出是为了能单独测这些正则 —— 它们只能靠**真实的 git 输出**校准，
 * 而靠真实仓库去触发每一条代价很高（有些还要私有仓库和令牌）。
 * 用真实输出当 fixture 直接测分类，比等集成测试偶发覆盖可靠得多。
 */
export function mapError(err: unknown, what: string): Error {
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
    // 放在鉴权判断**之前**：simple-git 的超时插件 kill 掉进程后，有些 git 版本
    // 还会补一句「Authentication failed」之类的输出 —— 那只是症状，
    // 真正的结论是「它卡住了」，报成鉴权失败会把用户指去查一个没问题的令牌。
    // 两种措辞都收：`block timeout reached` 是 simple-git 自己的，
    // `timed out` 是 git/curl 的（连接层面超时，对用户是同一件事）。
    if (/block timeout reached|timed out/i.test(message)) {
        return new GitTimeoutError(`git operation timed out (${detail})`, { cause: err });
    }
    // 放在鉴权判断**之前**：某些平台会把「用户名不被支持」和
    // 「Authentication failed」一起打出来，此时更具体的这条应当胜出
    // （用例锁着这个顺序，见 gitErrorMapping.test.ts）。
    // 另外它绝不能落进 GitAuthError —— 那会让用户去反复检查一个没问题的令牌。
    if (/supported as username/i.test(message)) {
        return new GitCredentialUsernameRejectedError(
            `platform rejected the credential username (${detail})`,
            { cause: err }
        );
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
