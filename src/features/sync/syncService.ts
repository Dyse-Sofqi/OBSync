import { normalizePath, TFile, type App, type Vault } from "obsidian";
import { logger } from "../../core/logger";
import type { LocaleStrings } from "../../core/i18n";
import type { Notifier } from "../../core/notice";
import { renderCommitMessage } from "./commitMessage";
import type { GitManager } from "./gitManager";
import { ConflictError, describeSyncError } from "./errors";
import type { SecretStore } from "../../core/secretStore";
import { parseGitRemoteUrl } from "../../host/repoRef";
import type {
    DiagnosticCheck,
    DiagnosticsReport,
    RepoStatus,
    SyncOutcome,
    SyncStrategy,
} from "./types";
import { StatusBar } from "./statusBar";

/**
 * 同步编排：把 GitManager 的原子操作组合成用户语义的动作。
 *
 * ## 并发模型
 *
 * 所有会动仓库的操作都串行执行（一条 promise 链）。理由：
 * 自动提交定时器、手动命令、文件事件可能在同一时刻触发，
 * 而 git 的 index 是共享状态 —— 并发 stage/commit 会互相踩。
 * 参考项目 obsidian-git 的 PromiseQueue 解决的是同一个问题。
 *
 * ## 冲突的处理哲学
 *
 * 检测到冲突时**不自动解决**（自动 rebase --theirs/--ours 都是替用户丢数据），
 * 而是：留下冲突现场 + 在库里写一份「冲突指南」文件 + 明确告知用户。
 * 用户要么手动编辑后提交，要么用「放弃本次合并」回到 pull 之前。
 */

export interface SyncHost {
    app: App;
    notifier: Notifier;
    /** 诊断要判断「该平台的令牌配了没有」。 */
    secretStore: SecretStore;
    getT(): LocaleStrings;
    /** 提交信息模板（settings.sync.commitMessage）。 */
    getCommitTemplate(): string;
    /** 同步策略（settings.sync.syncStrategy）。 */
    getStrategy(): SyncStrategy;
    /** 冲突指南文件名（已本地化），空串表示不写指南。 */
    getConflictGuideName(): string;
}

export class SyncService {
    /** 串行队列：队尾 promise。 */
    private tail: Promise<unknown> = Promise.resolve();
    /** 排队中 + 执行中的任务数。 */
    private pending = 0;

    constructor(
        readonly git: GitManager,
        readonly deps: SyncHost,
        private readonly statusBar: StatusBar
    ) {}

    /**
     * 是否有动作在进行中（含**已排队但还没轮到**的）。
     *
     * 用计数器而不是布尔量：`enqueue` 里若写成「任务 settle 时置 false」，
     * 那么队列里还有第二个任务时它就已经变 false 了 —— 于是 `isBusy` 在
     * 真正有活干的时候报"空闲"。automatics 靠它决定"跳过本轮"，
     * 状态栏与视图也靠它显示忙碌状态，语义错了会连锁出错。
     */
    get isBusy(): boolean {
        return this.pending > 0;
    }

    /** 串行执行一个动作；错误原样上抛给调用方决定怎么提示。 */
    private enqueue<T>(run: () => Promise<T>): Promise<T> {
        this.pending += 1;
        // 前一个任务无论成功失败都要接着跑下一个，所以 onRejected 也传 run。
        const task = this.tail.then(run, run);
        this.tail = task.catch(() => {});
        return task.finally(() => {
            this.pending -= 1;
        });
    }

    /** 动作结束后统一刷新状态栏。 */
    private async refreshStatus(): Promise<void> {
        try {
            this.statusBar.update(await this.git.status());
        } catch (err) {
            // 刷不出状态（比如刚卸载 git）不影响动作本身的结论。
            logger.debug("status refresh failed", err);
            this.statusBar.update(undefined);
        }
    }

    // ── 用户动作 ──────────────────────────────────────────────────────────

    /** 提交全部更改（暂存所有 + 提交）。没有更改时是静默的空操作。 */
    async commitAll(): Promise<SyncOutcome> {
        return this.enqueue(async () => {
            this.statusBar.setActivity("committing");
            try {
                return await this.doCommitAll();
            } finally {
                await this.refreshStatus();
            }
        });
    }

    /** 拉取。冲突时写指南文件并把 `ConflictError` 转成用户提示（不抛出）。 */
    async pull(): Promise<SyncOutcome> {
        return this.enqueue(async () => {
            this.statusBar.setActivity("pulling");
            try {
                return await this.doPull();
            } finally {
                await this.refreshStatus();
            }
        });
    }

    /** 推送。 */
    async push(): Promise<SyncOutcome> {
        return this.enqueue(async () => {
            this.statusBar.setActivity("pushing");
            try {
                return await this.git.push();
            } finally {
                await this.refreshStatus();
            }
        });
    }

    /**
     * 完整同步：提交 → 拉取 → 推送。
     *
     * 这是自动同步和「立即同步」命令共用的链路。拉取产生冲突时**必须停**：
     * 继续提交会把冲突标记写进历史，继续推送会把它们推上远端。
     */
    async sync(): Promise<SyncOutcome> {
        return this.enqueue(async () => {
            try {
                // 每个阶段都更新活动状态 —— 只在开头设一次的话，
                // 整条链路（含拉取、推送）都会显示「正在提交」，与实际不符。
                this.statusBar.setActivity("committing");
                await this.doCommitAll();

                this.statusBar.setActivity("pulling");
                const pulled = await this.doPull();
                if (pulled.kind === "conflict") return pulled;
                if (pulled.kind === "pulled") {
                    // 拉下来的文件可能又和本地未提交内容合并出新东西 ——
                    // 二次提交后再推送，保证推上去的是完整状态。
                    this.statusBar.setActivity("committing");
                    await this.doCommitAll();
                }

                this.statusBar.setActivity("pushing");
                return await this.doPush();
            } finally {
                await this.refreshStatus();
            }
        });
    }

    /** 放弃冲突现场（回到 pull 之前）。 */
    async abortMerge(): Promise<void> {
        await this.enqueue(async () => {
            await this.git.abortMerge();
            // 必须给反馈：这是个"撤销"类动作，做完之后库里的冲突标记消失了，
            // 但用户如果不看文件是不知道发生了什么 —— 静默会让人怀疑到底成没成。
            this.deps.notifier.success(this.deps.getT().sync.mergeAborted);
            await this.refreshStatus();
        });
    }

    /**
     * 初始化仓库，并在**没有** `.gitignore` 时建一个默认的。
     *
     * ## 为什么自动建
     *
     * `.obsidian/workspace.json` 存的是面板与标签布局 —— **每开关一个标签它就变**。
     * 多设备同步它必然冲突，而且冲突内容是整份 JSON，用户根本没法手工合并。
     * 这是 Obsidian 同步最常见的坑，但用户不会预见到 —— 等冲突发生了再处理，
     * 成本高得多。所以初始化时顺手挡掉，并**明确告知建了什么**（不偷偷摸摸）。
     *
     * 已经存在 `.gitignore` 时**绝不覆盖** —— 用户可能有自己的规则，
     * 覆盖掉是数据损失。（实测用户的测试库里就有一份别的同步插件建的。）
     */
    async initRepo(): Promise<{ createdGitignore: boolean }> {
        return this.enqueue(async () => {
            await this.git.init();
            const createdGitignore = await this.ensureGitignore();
            await this.refreshStatus();
            return { createdGitignore };
        });
    }

    private async ensureGitignore(): Promise<boolean> {
        const vault: Vault = this.deps.app.vault;
        const path = normalizePath(".gitignore");

        try {
            if (await vault.adapter.exists(path)) return false;
            await vault.adapter.write(path, this.deps.getT().sync.gitignoreTemplate);
            return true;
        } catch (err) {
            // 建不了 .gitignore 不该让初始化失败 —— 只是少了一层保护。
            logger.warn("could not create .gitignore", err);
            return false;
        }
    }

    /**
     * 打开 `.gitignore` 供用户编辑；不存在就先建一个默认的。
     *
     * 复用初始化时的那份模板，所以用户看到的是一个**有注释解释为什么**的文件，
     * 而不是空文件 —— 空文件没法教人该忽略什么。
     */
    async openGitignore(): Promise<void> {
        const vault: Vault = this.deps.app.vault;
        const path = normalizePath(".gitignore");

        if (!(await vault.adapter.exists(path))) {
            await vault.adapter.write(path, this.deps.getT().sync.gitignoreTemplate);
        }

        const file = vault.getAbstractFileByPath(path);
        if (file instanceof TFile) {
            await this.deps.app.workspace.getLeaf(false).openFile(file);
        }
    }

    /** 只刷新状态（不打扰任何 git 写操作）。 */
    async refresh(): Promise<RepoStatus | undefined> {
        try {
            const status = await this.git.status();
            this.statusBar.update(status);
            return status;
        } catch (err) {
            logger.debug("status refresh failed", err);
            this.statusBar.update(undefined);
            return undefined;
        }
    }

    /**
     * 把错误翻译成用户可读文案。
     *
     * **先用自己的翻译器**，而不是只依赖 `notifier.describeError` ——
     * 后者要靠「`createSyncModule` 已经注册过翻译器」这个隐式前提，
     * 而诊断是个自包含的工具，不该依赖模块的装配顺序。
     * （这个隐式依赖是被测试抓出来的：单独构造 SyncService 时，
     * 鉴权失败只显示英文技术描述。）
     */
    private describe(err: unknown): string {
        return describeSyncError(err, this.deps.getT()) ?? this.deps.notifier.describeError(err);
    }

    /**
     * 诊断同步配置。
     *
     * 存在的理由：**鉴权配得对不对，光看设置项判断不了** —— 令牌填了不代表有效，
     * 仓库是私有的才知道。只有真的去连一次才有答案。所以这里跑一条递进的检查链，
     * 任何一步失败就停（后面的检查依赖前面的前提）。
     *
     * 只读：最后一步用 `ls-remote`，不动 refs、不动 index、不写任何文件。
     *
     * 返回结构化结果（类型码 + 状态），文案由展示层按 `id` 取 locale ——
     * 与错误处理同一套约定，所以这个函数不依赖 i18n，可以单独测。
     */
    async diagnose(): Promise<DiagnosticsReport> {
        const checks: DiagnosticCheck[] = [];
        const add = (
            id: DiagnosticCheck["id"],
            status: DiagnosticCheck["status"],
            detail?: string
        ): void => {
            checks.push(detail === undefined ? { id, status } : { id, status, detail });
        };

        // 1) git 可执行文件。这一步失败的话后面全都做不了，直接停。
        let repoExists = false;
        try {
            repoExists = await this.git.isRepo();
            add("git", "ok");
        } catch (err) {
            add("git", "failed", this.describe(err));
            return { checks, ok: false };
        }

        // 2) 当前库是不是 git 仓库。
        if (!repoExists) {
            add("repo", "failed");
            return { checks, ok: false };
        }
        add("repo", "ok");

        // 3) 有没有配远端。
        const remoteUrl = await this.git.getRemoteUrl();
        if (!remoteUrl) {
            add("remote", "failed");
            return { checks, ok: false };
        }
        add("remote", "ok", remoteUrl);

        // 4) 平台认不认得出 —— 认不出就注入不了令牌（但可以用系统凭据助手，不算失败）。
        const ref = parseGitRemoteUrl(remoteUrl);
        if (!ref) {
            add("platform", "skipped", remoteUrl);
        } else {
            const hasToken = this.deps.secretStore.getToken(ref.host) !== undefined;
            add("platform", hasToken ? "ok" : "skipped", ref.host);
        }

        // 5) 真的连一次 —— **鉴权是否有效看这一条**。
        try {
            const refCount = await this.git.testRemoteAccess();
            add("access", "ok", String(refCount));
        } catch (err) {
            add("access", "failed", this.describe(err));
        }

        return { checks, ok: checks.every((check) => check.status !== "failed") };
    }

    // ── 内部（不加锁版本，供已持锁的链路复用） ────────────────────────────

    private async doCommitAll(): Promise<SyncOutcome> {
        const status = await this.git.status();

        // 冲突未解决时**绝不能提交**。
        //
        // 这里有个不显眼的陷阱：冲突文件在 `git status` 里是 `UU`，
        // 于是它**同时**被归进 `staged`（index 位非空）与 `unstaged`（worktree 位非空），
        // 所以"有没有改动"的判断在有冲突时必然为真 —— 光看 dirty 是拦不住的。
        // 不拦的话 `git add -A` 会把 `<<<<<<<` / `>>>>>>>` 冲突标记当普通内容暂存并提交，
        // 把冲突写进历史。这正是本模块的设计要避免的事。
        //
        // 现实触发路径：上次同步遇到冲突没处理 → 自动提交定时器到点 → sync() 第一步就是这里。
        if (status.conflicted.length > 0) {
            throw new ConflictError(
                `commit: ${status.conflicted.length} unresolved conflict(s)`,
                status.conflicted
            );
        }

        const dirty =
            status.staged.length + status.unstaged.length + status.untracked.length;
        if (dirty === 0) {
            return { kind: "nothing-to-commit" };
        }

        const files = [...status.staged, ...status.unstaged, ...status.untracked].map(
            (change) => change.path
        );

        await this.git.stage([]);
        const message = renderCommitMessage(this.deps.getCommitTemplate(), { files });
        const committed = await this.git.commit(message);
        return { kind: committed ? "committed" : "nothing-to-commit" };
    }

    private async doPull(): Promise<SyncOutcome> {
        const t = this.deps.getT();
        try {
            return await this.git.pull(this.deps.getStrategy());
        } catch (err) {
            if (err instanceof ConflictError) {
                await this.writeConflictGuide(err.files);
                this.deps.notifier.error(t.sync.conflictDetected(err.files.length));
                // 用独立的 kind 让调用方知道链路要停，而不是当一次普通拉取。
                return { kind: "conflict" };
            }
            throw err;
        }
    }

    private async doPush(): Promise<SyncOutcome> {
        const status = await this.git.status();
        // 没有远端时 push 必然失败 —— 提前给出更有指导性的错误。
        if (!(await this.git.getRemoteUrl())) {
            const t = this.deps.getT();
            this.deps.notifier.warn(t.sync.noRemote);
            return { kind: "up-to-date" };
        }
        if (status.ahead === 0) return { kind: "up-to-date" };
        return this.git.push();
    }

    // ── 冲突指南 ──────────────────────────────────────────────────────────

    /** 冲突文件清单 + 处理指引，写在库根目录。 */
    private async writeConflictGuide(files: string[]): Promise<void> {
        const name = this.deps.getConflictGuideName();
        if (!name) return;

        const t = this.deps.getT();
        const vault: Vault = this.deps.app.vault;
        const lines: string[] = [
            `# ${t.sync.conflictGuideTitle}`,
            "",
            t.sync.conflictGuideIntro,
            "",
            t.sync.conflictGuideFiles,
            ...files.map((file) => `- [[${file}]]`),
            "",
            t.sync.conflictGuideResolve,
            "",
            t.sync.conflictGuideAbort,
            "",
            `> ${t.sync.conflictGuideFooter(new Date().toLocaleString())}`,
        ];

        try {
            const path = normalizePath(name);
            if (await vault.adapter.exists(path)) {
                await vault.adapter.remove(path);
            }
            await vault.adapter.write(path, lines.join("\n"));
        } catch (err) {
            // 指南写不进去不该吞掉冲突本身的信息。
            logger.error("failed to write conflict guide", err);
        }
    }
}
