import { normalizePath, TFile, type App, type Vault } from "obsidian";
import { logger } from "../../core/logger";
import type { LocaleStrings } from "../../core/i18n";
import type { Notifier } from "../../core/notice";
import { renderCommitMessage } from "./commitMessage";
import { changeRows } from "./changeRows";
import {
    buildAddedFileDiff,
    MAX_UNTRACKED_DIFF_BYTES,
    parseUnifiedDiff,
    type FileDiff,
} from "./diff";
import { formatBytes, sumFileBytes } from "./repoSize";
import { isFullyInSync } from "./syncState";
import type { GitManager } from "./gitManager";
import { ConflictError, describeSyncError } from "./errors";
import type { SecretStore } from "../../core/secretStore";
import { parseGitRemoteUrl } from "../../host/repoRef";
import { redactUrl } from "../../host/redact";
import type {
    DiagnosticCheck,
    DiagnosticsReport,
    RepoStatus,
    SyncOutcome,
    SyncStrategy,
} from "./types";
import { StatusBar, type StatusBarActivity } from "./statusBar";

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

/**
 * 一个文件的差异，两侧分开。
 *
 * 为什么不合成一份：同一个文件完全可能**既有已暂存又有未暂存的改动**
 * （`git status` 里的 `MM`），而这两份内容回答的是不同的问题 ——
 * 「我接下来要提交什么」与「我还没放进这次提交的是什么」。
 * 合成一份就必须挑一边，那等于把另一半藏起来。
 */
export interface FileDiffSet {
    path: string;
    /** 工作区 ↔ 索引：还没暂存的内容。 */
    unstaged: FileDiff;
    /** 索引 ↔ HEAD：即将被提交的内容。 */
    staged: FileDiff;
}

export class SyncService {
    /** 串行队列：队尾 promise。 */
    private tail: Promise<unknown> = Promise.resolve();
    /** 排队中 + 执行中的任务数。 */
    private pending = 0;
    /** 状态变化订阅者（仓库同步视图）。见 `onStatusChange`。 */
    private readonly statusListeners = new Set<(status: RepoStatus | undefined) => void>();

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

    /** 动作结束后统一刷新状态栏，并把新状态交给需要它的调用方。 */
    private async refreshStatus(): Promise<RepoStatus | undefined> {
        return this.refresh();
    }

    // ── 状态订阅（仓库同步视图） ──────────────────────────────────────────

    /**
     * 状态变化订阅者。
     *
     * 视图是**常驻**的（打开后一直挂在侧边栏），而状态会在它背后变 ——
     * 自动提交定时器到点、库外的编辑器改了文件、键盘上的命令面板触发了一次拉取。
     * 只在 `onOpen` 时渲染一次的话，面板上的内容就停在打开它的那一刻，
     * 用户看着「3 个文件有改动」而实际上已经提交完了。
     *
     * 参考项目 obsidian-git 靠一个固定间隔的定时器轮询状态；这里有真实的
     * 变化点（每次动作结束、每次 `refresh`），所以改成推送式：谁刷新了状态，
     * 谁负责通知订阅者。
     */
    onStatusChange(listener: (status: RepoStatus | undefined) => void): () => void {
        this.statusListeners.add(listener);
        return () => {
            this.statusListeners.delete(listener);
        };
    }

    private publish(status: RepoStatus | undefined): void {
        for (const listener of this.statusListeners) {
            try {
                listener(status);
            } catch (err) {
                // 订阅者（界面）出错绝不能影响同步本身。
                logger.debug("status listener failed", err);
            }
        }
    }

    // ── 用户动作 ──────────────────────────────────────────────────────────

    /**
     * 跑一个动作：期间状态栏显示「正在…」，结束后**无论成败都恢复**成仓库状态。
     *
     * ## 为什么这件事必须收在一处（真 bug 的修复）
     *
     * `activity` 是 `StatusBar` 的实例状态，而它的 `render()` 在
     * `activity !== "idle"` 时**只显示活动文案并直接返回** —— 也就是说
     * 一旦没人把它改回 `idle`，状态栏就永远停在「正在推送…」，
     * 而且**连分支 / ahead / behind / 脏文件数都一起不显示了**，
     * 一直到重载插件为止。在此之前 `setActivity("idle")` 在整个 `src` 里
     * **一次都没出现过**（只有测试里手工调用过，所以没被发现）。
     *
     * 用户报的就是这个症状：「尝试推送后一直看到正在推送」——
     * 推送早就结束（成功或失败）了，界面却还在说它正在进行。
     *
     * 收在 `finally` 里，是因为**出错时更需要恢复**：失败会让用户盯着
     * 「正在推送…」等一个永远不会来的结果。
     *
     * `after` 是**成功之后**的收尾反馈（拿到刚刷新出来的状态）—— 失败时不调，
     * 因为「与远端一致」这种话在出错后说出来只会让人困惑。
     */
    private async withActivity<T>(
        activity: StatusBarActivity,
        run: () => Promise<T>,
        after?: (result: T, status: RepoStatus | undefined) => Promise<void>
    ): Promise<T> {
        this.statusBar.setActivity(activity);
        try {
            const result = await run();
            this.statusBar.setActivity("idle");
            const status = await this.refreshStatus();
            if (after) await after(result, status);
            return result;
        } catch (err) {
            this.statusBar.setActivity("idle");
            await this.refreshStatus();
            throw err;
        }
    }

    /** 提交全部更改（暂存所有 + 提交）。没有更改时是静默的空操作。 */
    async commitAll(options: { announce?: boolean } = {}): Promise<SyncOutcome> {
        return this.enqueue(() =>
            this.withActivity(
                "committing",
                () => this.doCommitAll(),
                options.announce ? (_result, status) => this.announceAfterCommit(status) : undefined
            )
        );
    }

    /** 拉取。冲突时写指南文件并把 `ConflictError` 转成用户提示（不抛出）。 */
    async pull(): Promise<SyncOutcome> {
        return this.enqueue(() => this.withActivity("pulling", () => this.doPull()));
    }

    /**
     * 推送。
     *
     * **只推送已提交的内容** —— 它不会顺手提交（那是「立即同步」和「提交」的事）。
     * 这个区别必须让用户看得见：按钮上只有「推送」两个字，而用户带着一堆未提交的
     * 改动点它，预期多半是「我的改动该上去了」。
     *
     * `announceIfUpToDate` 只由**用户主动**的入口传 true（命令面板、视图里的按钮）。
     * 自动推送定时器不传：本地没有新提交是常态，每 N 分钟弹一次纯属噪音。
     */
    async push(options: { announceIfUpToDate?: boolean } = {}): Promise<SyncOutcome> {
        return this.enqueue(() =>
            this.withActivity(
                "pushing",
                () => this.doPush(),
                options.announceIfUpToDate
                    ? (outcome, status) => this.announceAfterPush(outcome, status)
                    : undefined
            )
        );
    }

    /**
     * 完整同步：提交 → 拉取 → 推送。
     *
     * 这是自动同步和「立即同步」命令共用的链路。拉取产生冲突时**必须停**：
     * 继续提交会把冲突标记写进历史，继续推送会把它们推上远端。
     *
     * 曾经还有一个 `commitAndPush()`（= 这一条去掉拉取），被用户判定为多余：
     * 「立即同步已经是万全之策」，而不想拉取的人用「提交」+「推送」两步即可。
     * 别再把它加回来 —— 除非有人真需要那个单步动作。
     */
    async sync(options: { announceInSync?: boolean } = {}): Promise<SyncOutcome> {
        return this.enqueue(() =>
            this.withActivity(
                "committing",
                async () => {
                    await this.doCommitAll();

                    // 每个阶段都更新活动状态 —— 只在开头设一次的话，
                    // 整条链路（含拉取、推送）都会显示「正在提交」，与实际不符。
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
                },
                options.announceInSync
                    ? async (_outcome, status) => {
                          await this.announceInSync(status);
                      }
                    : undefined
            )
        );
    }

    // ── 结束反馈（只给用户主动发起的动作） ────────────────────────────────

    /**
     * 与远端完全一致时给一条**醒目**的成功提示，并返回是否说了话。
     *
     * 用户的原话：「当提交结束与远端一致时，给出醒目的反馈」。所以这条提示
     * 走 `Notifier.synced`（带绿色对勾、停留更久），而不是一闪而过的普通提示。
     *
     * 判据在 `isFullyInSync` 里（只有一处定义，状态栏与面板共用同一个）。
     */
    private async announceInSync(status: RepoStatus | undefined): Promise<boolean> {
        if (!isFullyInSync(status)) return false;
        this.deps.notifier.synced(
            this.deps.getT().sync.syncedInSync(await this.repoSizeText())
        );
        return true;
    }

    /** 仓库体积文案；读不到时返回 undefined（提示里就不提体积，不编数字）。 */
    private async repoSizeText(): Promise<string | undefined> {
        try {
            return formatBytes((await this.git.repoSize()).bytes);
        } catch (err) {
            logger.debug("repository size unavailable", err);
            return undefined;
        }
    }

    /**
     * 「提交」结束后的反馈。
     *
     * 三种情况各说各的：
     * - **与远端完全一致** → 醒目提示（一切正常）；
     * - **有提交但没推上去** → 明确说出来，否则用户以为提交完就上去了
     *   （他此前的困惑就是这一类：「推送按钮是单纯的推送还是提交加推送」）；
     * - 没有远端 / 没有 upstream → 什么都不说（`ahead` 为 null），
     *   前面的警告或状态栏已经说明了。
     */
    private async announceAfterCommit(status: RepoStatus | undefined): Promise<void> {
        if (await this.announceInSync(status)) return;
        const ahead = status?.ahead;
        if (ahead !== null && ahead !== undefined && ahead > 0) {
            this.deps.notifier.info(this.deps.getT().sync.commitsNotPushed(ahead));
        }
    }

    /**
     * 「推送」结束后的反馈。
     *
     * 顺序有讲究：**先判「完全一致」**——那是最好的一句话，也是用户要的那条
     * （推送成功且工作区干净时，说「已同步」比说「已推送到远端」信息更全：
     * 它同时确认了没有遗留的改动）。
     */
    private async announceAfterPush(
        outcome: SyncOutcome,
        status: RepoStatus | undefined
    ): Promise<void> {
        const t = this.deps.getT();

        // `ahead` 为 null = 没有跟踪的远端分支（可能是「没配远端」）——
        // 那时无从谈「一致」，而 doPush 已经就「没有远端」给过警告了。
        if (!status || status.ahead === null) return;

        if (await this.announceInSync(status)) return;

        const pending = changeRows(status).length;
        if (outcome.kind === "pushed") {
            // 推成功了，但本地还有没提交的东西 —— 不说的话用户会以为
            // 「推送」把工作区一起带上去了。
            this.deps.notifier.info(
                pending > 0 ? t.sync.pushDonePending(pending) : t.sync.pushDone
            );
            return;
        }

        // 没有需要推送的内容：本地没有新提交。若工作区还有改动，说清「推送只发送
        // 已提交的内容」并给出数量（不然听起来像「一切正常」，而真实情况是
        // 「你的改动一个都没上去」）。
        this.deps.notifier.info(
            pending > 0 ? t.sync.pushNeedsCommit(pending) : t.sync.pushUpToDate
        );
    }

    /**
     * 本次待提交改动的体积（字节）。
     *
     * git 不直接给这个数，只能把有改动的文件大小加起来 —— 所以是**近似值**
     * （实际传输量还看压缩率；删除的文件本来没有体积）。取不到大小的文件按 0 计。
     *
     * 公开是因为仓库同步视图也要显示它，而它需要 `app.vault.adapter`（在 service 手上）。
     */
    async pendingChangeBytes(status: RepoStatus): Promise<number> {
        const paths = changeRows(status).map((row) => row.path);
        return sumFileBytes(paths, async (path) => {
            try {
                const stats = await this.deps.app.vault.adapter.stat(path);
                return stats?.size;
            } catch (err) {
                // 文件可能刚被删掉（状态是几秒前的）—— 这只是个参考数字，
                // 不该因为它失败而让面板画不出来。
                logger.debug("could not stat changed file", err);
                return undefined;
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

    // ── 仓库同步视图里的逐文件操作（2026-09-19） ──────────────────────────

    /**
     * 暂存指定文件 / 取消暂存 / 切换分支。
     *
     * 三个都**必须走这条串行队列**，而不是让视图直接调 `git`：
     * 队列的存在意义就是「所有动仓库的操作排成一队」—— 视图里点一下「暂存」
     * 的同时自动提交定时器到点了，两条 git 命令并发写索引是真实会发生的
     * （原本视图里的分支切换就是直接调 `git.checkout`，绕过了队列）。
     *
     * 只做一件事就返回，不额外发提示：逐文件操作的结果**看得见**
     * （文件从「未暂存」挪到「已暂存」），再弹一条提示只是噪音。
     */
    async stageFiles(paths: string[]): Promise<void> {
        if (paths.length === 0) return;
        await this.enqueue(async () => {
            await this.git.stage(paths);
            await this.refreshStatus();
        });
    }

    async unstageFiles(paths: string[]): Promise<void> {
        if (paths.length === 0) return;
        await this.enqueue(async () => {
            await this.git.unstage(paths);
            await this.refreshStatus();
        });
    }

    async checkoutBranch(name: string): Promise<void> {
        await this.enqueue(async () => {
            await this.git.checkout(name);
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

    /**
     * `.gitignore` 模板，已按**本库的配置目录名**展开。
     *
     * 走 `vault.configDir` 而不是写死 `.obsidian`：配置目录可以改名，写死的话
     * 那些排除规则一条都匹配不上 —— 表现是「明明建了 .gitignore，
     * workspace.json 还是被同步出去了」，而用户根本看不出为什么。
     * 审核的 `hardcoded-config-path` 报的也是这件事。
     */
    private gitignoreTemplate(): string {
        return this.deps.getT().sync.gitignoreTemplate(this.deps.app.vault.configDir);
    }

    private async ensureGitignore(): Promise<boolean> {
        const vault: Vault = this.deps.app.vault;
        const path = normalizePath(".gitignore");

        try {
            if (await vault.adapter.exists(path)) return false;
            await vault.adapter.write(path, this.gitignoreTemplate());
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
     *
     * @returns 是否真的在编辑器里打开了。
     *
     * ## 为什么要返回这个布尔量（而不是默默返回 void）
     *
     * `getAbstractFileByPath` 查的是 **Obsidian 的库索引**，而以点开头的文件
     * 不一定在索引里 —— 那时 `openFile` 根本不会被调用，界面上的表现是
     * **点了一个按钮什么也没发生**（这是最容易被当成「插件坏了」的一种失败）。
     * 调用方据此给一句说明，并指向设置页里那个能直接改的代码框。
     *
     * 注意它仍然会**先建文件**：建了没打开，用户拿系统编辑器也能立刻改到。
     */
    async openGitignore(): Promise<boolean> {
        const vault: Vault = this.deps.app.vault;
        const path = normalizePath(".gitignore");

        if (!(await vault.adapter.exists(path))) {
            await vault.adapter.write(path, this.gitignoreTemplate());
        }

        const file = vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) return false;

        await this.deps.app.workspace.getLeaf(false).openFile(file);
        return true;
    }

    /**
     * 读 `.gitignore` 的原文；**不存在时返回 undefined**。
     *
     * 刻意不在这里自动创建（`openGitignore` 会）：设置页只是被打开一下，
     * 不该因此往用户的库里多出一个文件。「还没建」是设置页要显示的状态之一，
     * 不是需要被悄悄修掉的问题。
     */
    async readGitignore(): Promise<string | undefined> {
        const path = normalizePath(".gitignore");
        const adapter = this.deps.app.vault.adapter;
        if (!(await adapter.exists(path))) return undefined;
        return await adapter.read(path);
    }

    /**
     * 写 `.gitignore`（不存在则创建）。
     *
     * 走同步队列：`commitAll` 的 `git add -A` 与这里同时发生的话，
     * 用户正在敲的那份半成品会被卷进一次提交（内容不完整，但记录是完整的）。
     * 排队几百毫秒换掉这个可能性，值得。
     *
     * 写完刷新状态 —— `.gitignore` 本身就是「哪些文件该出现在改动列表里」的
     * 依据，改完之后面板上的列表**应该**跟着变（否则用户会以为没生效）。
     */
    async writeGitignore(content: string): Promise<void> {
        await this.enqueue(async () => {
            await this.deps.app.vault.adapter.write(normalizePath(".gitignore"), content);
            await this.refresh();
        });
    }

    // ── 差异（仓库同步面板 / 命令面板） ──────────────────────────────────

    /**
     * 一个文件的差异：工作区与已暂存两侧各一份。
     *
     * ## 未跟踪文件为什么要兜底
     *
     * `git diff` 对**未跟踪**文件什么都不输出 —— 而库里新增的笔记恰恰是最想看
     * 一眼的那一类。所以两侧都为空、且这个路径确实在未跟踪列表里时，把文件内容
     * 读出来当成「全部新增」。
     *
     * 「确实在未跟踪列表里」这一步不能省：一个**干净**的已跟踪文件两侧也全为空，
     * 把它读出来当成「全部新增」就是在编造一个不存在的改动。
     */
    async fileDiff(path: string): Promise<FileDiffSet> {
        return this.enqueue(async () => {
            const [unstagedRaw, stagedRaw] = await Promise.all([
                this.git.diffFile(path),
                this.git.diffFile(path, { staged: true }),
            ]);

            let unstaged = firstFileDiff(parseUnifiedDiff(unstagedRaw), path);
            const staged = firstFileDiff(parseUnifiedDiff(stagedRaw), path);

            if (unstaged.kind === "empty" && staged.kind === "empty") {
                const added = await this.addedFileDiff(path);
                if (added) unstaged = added;
            }

            return { path, unstaged, staged };
        });
    }

    /**
     * 某条提交引入的改动（可能跨多个文件）。
     *
     * 合并提交也能给出内容 —— 实现里带了 `--first-parent`（见
     * `SimpleGitManager.commitPatch` 的说明）。
     */
    async commitDiff(hash: string): Promise<FileDiff[]> {
        return this.enqueue(async () =>
            parseUnifiedDiff(await this.git.commitPatch(hash))
        );
    }

    /** 未跟踪文件 → 「全部新增」；读不到、太大、或它其实是已跟踪的 → undefined。 */
    private async addedFileDiff(path: string): Promise<FileDiff | undefined> {
        try {
            const status = await this.git.status();
            if (!status.untracked.some((change) => change.path === path)) return undefined;
        } catch (err) {
            // 不是仓库时连「未跟踪」都无从谈起。
            logger.debug("could not read status for diff", err);
            return undefined;
        }

        const normalized = normalizePath(path);
        try {
            const stats = await this.deps.app.vault.adapter.stat(normalized);
            if (!stats || stats.type !== "file") return undefined;

            // 库里放一个几十 MB 的日志是常事 —— 读进来会把界面卡住。
            if (stats.size > MAX_UNTRACKED_DIFF_BYTES) {
                return {
                    path,
                    kind: "too-large",
                    hunks: [],
                    additions: 0,
                    deletions: 0,
                    truncated: false,
                };
            }

            return buildAddedFileDiff(path, await this.deps.app.vault.adapter.read(normalized));
        } catch (err) {
            // 读不到就当没有差异 —— 差异视图读不出内容不该是个错误弹窗。
            logger.debug("could not read untracked file for diff", err);
            return undefined;
        }
    }

    /** 只刷新状态（不打扰任何 git 写操作）。 */
    async refresh(): Promise<RepoStatus | undefined> {
        let status: RepoStatus | undefined;

        try {
            status = await this.git.status();
        } catch (err) {
            // 刷不出状态（比如刚卸载 git）不影响动作本身的结论。
            logger.debug("status refresh failed", err);
            status = undefined;
        }
        this.statusBar.update(status);
        this.publish(status);
        return status;
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
        /**
         * `detail` 会被设置页**渲染出来**，所以在这里统一脱敏 ——
         * 这是「原始数据」变成「给人看的报告」的唯一收口点。
         *
         * 为什么不能只在 `remote` 那条上做：这个报告里凡是带 `detail` 的条目
         * 都可能夹带地址（git 的报错、平台的失败原因），逐条去记该脱哪些必然漏。
         * 在收口点做一次，将来新加的检查也自动受保护。
         *
         * 现实触发路径：库的远端本来就写着带令牌的地址
         * （用户以前用别的方式配的，或在「编辑远端地址」里粘的），
         * 那这条检查就会把令牌显示在设置页上。
         */
        const add = (
            id: DiagnosticCheck["id"],
            status: DiagnosticCheck["status"],
            detail?: string
        ): void => {
            const safe = detail === undefined ? undefined : redactUrl(detail);
            checks.push(safe === undefined ? { id, status } : { id, status, detail: safe });
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

        /**
         * 本次提交涉及的文件（去重）。
         *
         * **必须去重**：同一个文件可能既在 `staged` 又在 `unstaged` 里 ——
         * `mapStatus` 是按 `git status` 的两位状态位分别归类的，
         * 而「改了又暂存」（`AM` / `MM`）的文件两个位都非空，于是被放进两个数组。
         * 不去重的话 `{{numFiles}}` 会多算、`{{files}}` 会把同一个文件列两遍。
         */
        const files = [
            ...new Set(
                [...status.staged, ...status.unstaged, ...status.untracked].map(
                    (change) => change.path
                )
            ),
        ];

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

    /**
     * 推送的**唯一**实现：`git push -u origin <当前分支>`。
     *
     * 里面**没有提交** —— 这个函数只把已经存在的提交送上去。用户带着未提交的改动
     * 点「推送」时会得到一句说明（见 `announceAfterPush`），而不是让他以为改动
     * 已经在远端了。
     */
    private async doPush(): Promise<SyncOutcome> {
        const status = await this.git.status();
        // 没有远端时 push 必然失败 —— 提前给出更有指导性的错误。
        if (!(await this.git.getRemoteUrl())) {
            this.deps.notifier.warn(this.deps.getT().sync.noRemote);
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

/**
 * 取单文件差异里的那一段；git 什么都没给时返回一份「没有差异」。
 *
 * `git diff -- <path>` 通常只回一段，但传进来的是目录时会有多段 ——
 * 那时取第一段，不假装它代表了全部（面板与命令永远只传文件路径，
 * 这一条是防御）。
 */
function firstFileDiff(files: FileDiff[], path: string): FileDiff {
    return (
        files[0] ?? {
            path,
            kind: "empty",
            hunks: [],
            additions: 0,
            deletions: 0,
            truncated: false,
        }
    );
}
