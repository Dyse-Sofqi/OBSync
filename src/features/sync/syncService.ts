import { normalizePath, type App, type Vault } from "obsidian";
import { logger } from "../../core/logger";
import type { LocaleStrings } from "../../core/i18n";
import type { Notifier } from "../../core/notice";
import { renderCommitMessage } from "./commitMessage";
import type { GitManager } from "./gitManager";
import { ConflictError } from "./errors";
import type { RepoStatus, SyncOutcome, SyncStrategy } from "./types";
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
    /** 有同步动作进行中（UI 与自动任务都看这个）。 */
    private running = false;

    constructor(
        readonly git: GitManager,
        readonly deps: SyncHost,
        private readonly statusBar: StatusBar
    ) {}

    /** 是否有动作在进行中。automatics 用它避免无意义排队。 */
    get isBusy(): boolean {
        return this.running;
    }

    /** 串行执行一个动作；错误原样上抛给调用方决定怎么提示。 */
    private enqueue<T>(run: () => Promise<T>): Promise<T> {
        const task = this.tail.then(run, run);
        this.tail = task.catch(() => {});
        this.running = true;
        return task.finally(() => {
            this.running = false;
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
            this.statusBar.setActivity("committing");
            try {
                await this.doCommitAll();
                const pulled = await this.doPull();
                if (pulled.kind === "conflict") return pulled;
                if (pulled.kind === "pulled") {
                    // 拉下来的文件可能又和本地未提交内容合并出新东西 ——
                    // 二次提交后再推送，保证推上去的是完整状态。
                    await this.doCommitAll();
                }
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
            await this.refreshStatus();
        });
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

    // ── 内部（不加锁版本，供已持锁的链路复用） ────────────────────────────

    private async doCommitAll(): Promise<SyncOutcome> {
        const status = await this.git.status();
        const dirty =
            status.staged.length + status.unstaged.length + status.untracked.length;
        if (dirty === 0 && status.conflicted.length === 0) {
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
