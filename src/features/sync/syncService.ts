import { normalizePath, TFile, type App, type Vault } from "obsidian";
import { logger } from "../../core/logger";
import type { LocaleStrings } from "../../core/i18n";
import type { Notifier } from "../../core/notice";
import { renderCommitMessage } from "./commitMessage";
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

export class SyncService {
    /** 串行队列：队尾 promise。 */
    private tail: Promise<unknown> = Promise.resolve();
    /** 排队中 + 执行中的任务数。 */
    private pending = 0;
    /** 状态变化订阅者（源码控制视图）。见 `onStatusChange`。 */
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

    /** 动作结束后统一刷新状态栏。 */
    private async refreshStatus(): Promise<void> {
        await this.refresh();
    }

    // ── 状态订阅（源码控制视图） ──────────────────────────────────────────

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
     */
    private async withActivity<T>(
        activity: StatusBarActivity,
        run: () => Promise<T>
    ): Promise<T> {
        this.statusBar.setActivity(activity);
        try {
            return await run();
        } finally {
            this.statusBar.setActivity("idle");
            await this.refreshStatus();
        }
    }

    /** 提交全部更改（暂存所有 + 提交）。没有更改时是静默的空操作。 */
    async commitAll(): Promise<SyncOutcome> {
        return this.enqueue(() => this.withActivity("committing", () => this.doCommitAll()));
    }

    /** 拉取。冲突时写指南文件并把 `ConflictError` 转成用户提示（不抛出）。 */
    async pull(): Promise<SyncOutcome> {
        return this.enqueue(() => this.withActivity("pulling", () => this.doPull()));
    }

    /**
     * 推送。
     *
     * `announceIfUpToDate` 只由**用户主动**的入口传 true（命令面板、视图里的按钮）。
     * 自动推送定时器不传：本地没有新提交是常态，每 N 分钟弹一次
     * 「没有需要推送的内容」纯属噪音。
     *
     * 为什么需要这句话：没有它时，用户点「推送」而本地与远端一致 ——
     * 界面**一点变化都没有**（状态栏还停在「正在推送…」，见 `withActivity`），
     * 他没法区分「没东西可推」和「卡住了」。
     */
    async push(options: { announceIfUpToDate?: boolean } = {}): Promise<SyncOutcome> {
        return this.enqueue(() =>
            this.withActivity("pushing", () =>
                this.doPush(options.announceIfUpToDate === true)
            )
        );
    }

    /**
     * 完整同步：提交 → 拉取 → 推送。
     *
     * 这是自动同步和「立即同步」命令共用的链路。拉取产生冲突时**必须停**：
     * 继续提交会把冲突标记写进历史，继续推送会把它们推上远端。
     */
    async sync(): Promise<SyncOutcome> {
        return this.enqueue(() =>
            this.withActivity("committing", async () => {
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
            })
        );
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

    // ── 源码控制视图里的逐文件操作（2026-09-19） ──────────────────────────

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

    private async doPush(announceIfUpToDate = false): Promise<SyncOutcome> {
        const status = await this.git.status();
        // 没有远端时 push 必然失败 —— 提前给出更有指导性的错误。
        if (!(await this.git.getRemoteUrl())) {
            const t = this.deps.getT();
            this.deps.notifier.warn(t.sync.noRemote);
            return { kind: "up-to-date" };
        }
        if (status.ahead === 0) {
            // 注意「没有远端」那条**不**走这里：它已经给过警告了，
            // 再说一句「没有需要推送的内容」会让人以为远端一切正常。
            if (announceIfUpToDate) {
                this.deps.notifier.info(this.deps.getT().sync.pushUpToDate);
            }
            return { kind: "up-to-date" };
        }
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
