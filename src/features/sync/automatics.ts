import { logger } from "../../core/logger";
import type { SyncService } from "./syncService";

/**
 * 自动提交 / 推送 / 拉取的定时器。
 *
 * ## 为什么持久化「上次执行时间」
 *
 * Obsidian 重启会把定时器清零。如果每次启动都重新计满一个间隔，
 * 用户「每 5 分钟备份」的实际周期会被拉长到「5 分钟 + 使用时长」。
 * 所以把每次执行的时间戳存进 localStorage，启动时按剩余时间起表 ——
 * 这是参考项目 obsidian-git 验证过的模型（automaticsManager.ts）。
 *
 * ## 间隔为 0 的语义
 *
 * 关闭该自动动作。不排队、不补跑 —— 错过的窗口不追，
 * 追赶会把用户刚打开的库立刻推走一次，体验很差。
 */

const STORAGE_KEY_PREFIX = "obsync-last-auto-";
/** setTimeout 的参数是 32 位有符号整数，超时会立即触发。 */
const MAX_TIMEOUT_MS = 2_147_483_647;

type AutoKind = "commit" | "push" | "pull";

export interface AutomaticsSettings {
    /**
     * 总开关（设置页的「启用笔记同步」）。**关掉时一个定时器都不起。**
     *
     * 这个字段必须在这里也有一份，而不是只在设置页判一下：定时器是插件
     * **自己**发起的后台动作，会提交、拉取、**推送到远端**。用户关掉总开关，
     * 意思就是「别在背后动我的仓库」—— 而在这个字段出现之前，那个开关写了
     * 从来没人读，于是关掉之后「自动提交」照样每 N 分钟把笔记推上远端：
     * 用户做了 UI 提供给他的那个动作，却没有效果。
     *
     * 边界（照 `installer.enabled` 的先例）：它**只管后台自动动作**。
     * 命令面板里的同步命令仍然可用 —— 那是用户当下主动发起的意图，
     * 与「插件自己到点就跑」不是一回事，拦下来只会让人以为插件坏了。
     */
    enabled: boolean;
    autoCommitMinutes: number;
    autoPushMinutes: number;
    autoPullMinutes: number;
}

export class Automatics {
    private timers = new Map<AutoKind, number>();

    /**
     * 「世代」计数器，每次 `stop()` 自增。
     *
     * 用来解决一个不显眼但真实的问题：`fire()` 是异步的，它跑完会重新起表。
     * 如果这期间 `stop()` 被调用过（插件卸载、设置变更触发的 `restart()`），
     * 那个 in-flight 的 `fire()` 回来照样起表 —— 于是
     * ① `stop()` 之后仍有定时器在跑；② 更糟的是 `restart()` 已经起过一个，
     * 新起的那个会把 Map 里的记录覆盖掉，**先前那个再也 clear 不掉**，
     * 结果是同一个动作每个周期跑两次。
     *
     * 做法：`fire()` 开始时捕获世代号，回来时若已变化就放弃重新起表。
     */
    private generation = 0;

    /** 定时器触发时真正要做的事 —— 从 SyncService 拿，保持单一编排入口。 */
    constructor(
        private readonly service: SyncService,
        private readonly settings: () => AutomaticsSettings
    ) {}

    /** 启动时调用：按「距上次执行的剩余时间」起表。 */
    start(): void {
        this.stop();

        const current = this.settings();

        // 总开关关掉：`stop()` 已经清完表，到此为止。
        //
        // 不需要在 `fire()` 里再判一次：`stop()` 同时把世代号自增了，所以
        // 那一刻正在跑的 `fire()` 回来时不会重新起表（见 `generation` 的说明）。
        // 而设置页每次改动都会走 `commit()` → `applyDerivedSettings()` →
        // `sync.reload()` → 这里，所以用户拨开关是**立刻**生效的，不用重启。
        if (!current.enabled) {
            logger.debug("automatics disabled: no timers scheduled");
            return;
        }

        if (current.autoCommitMinutes > 0) {
            this.schedule("commit", remaining(this.lastRan("commit"), current.autoCommitMinutes));
        }
        if (current.autoPushMinutes > 0) {
            this.schedule("push", remaining(this.lastRan("push"), current.autoPushMinutes));
        }
        if (current.autoPullMinutes > 0) {
            this.schedule("pull", remaining(this.lastRan("pull"), current.autoPullMinutes));
        }
    }

    /** 设置变化后调用：按完整间隔重新起表。 */
    restart(): void {
        this.start();
    }

    stop(): void {
        this.generation += 1;
        for (const timer of this.timers.values()) {
            window.clearTimeout(timer);
        }
        this.timers.clear();
    }

    private schedule(kind: AutoKind, delayMinutes: number): void {
        const delayMs = Math.min(delayMinutes * 60_000, MAX_TIMEOUT_MS);
        const timer = window.setTimeout(() => void this.fire(kind), delayMs);
        this.timers.set(kind, timer);
    }

    private async fire(kind: AutoKind): Promise<void> {
        const generation = this.generation;

        // 正在跑（比如用户手动同步）就放弃这一轮，等下一个整周期。
        // 排队会造成「队列里积了三个同步」，全部执行完已经过了很久。
        if (this.service.isBusy) {
            logger.debug(`auto ${kind} skipped: sync already running`);
            this.rescheduleIfCurrent(kind, generation);
            return;
        }

        try {
            // `commit` 这一档走的是**完整同步**（提交 → 拉取 → 推送），
            // 不是 `commitAll()`。
            //
            // 这是刻意的，与参考项目一致（obsidian-git 的定时器叫
            // `autoSaveInterval`，做的事情是 `commitAndSync`，界面上也写明
            // 叫 "Auto commit-and-sync interval"）。所以设置页那一项必须
            // 写成「自动提交**并同步**」：只写「自动提交」会让人以为
            // 「自动推送 / 自动拉取设为 0」就能拦住网络动作 —— 拦不住，
            // 推送与拉取会随这条链路一起发生。
            //
            // 反过来也别把它改成 `commitAll()`「让名字相符」：那样「只发预发布
            // 版」「只在本地备份」这类用户就再也得不到推送了，且改的人多半
            // 不会同时改文案。
            const outcome =
                kind === "pull"
                    ? await this.service.pull()
                    : kind === "push"
                      ? await this.service.push()
                      : await this.service.sync();
            void outcome;
        } catch (err) {
            // 自动动作的失败只进日志 —— 弹窗会在用户没操作时突然出现，
            // 而且网络抖动导致的失败下一轮自然恢复。
            logger.warn(`auto ${kind} failed`, err);
        } finally {
            this.markRan(kind);
            this.rescheduleIfCurrent(kind, generation);
        }
    }

    /** 只在「本世代仍然有效」时重新起表 —— 见 `generation` 的说明。 */
    private rescheduleIfCurrent(kind: AutoKind, generation: number): void {
        if (generation !== this.generation) {
            logger.debug(`auto ${kind} not rescheduled: automatics was restarted`);
            return;
        }
        const interval = this.intervalOf(kind);
        if (interval > 0) this.schedule(kind, interval);
    }

    private intervalOf(kind: AutoKind): number {
        const current = this.settings();
        if (kind === "commit") return current.autoCommitMinutes;
        if (kind === "push") return current.autoPushMinutes;
        return current.autoPullMinutes;
    }

    // ── 时间戳 ────────────────────────────────────────────────────────────

    private lastRan(kind: AutoKind): number | undefined {
        try {
            const raw = this.service.deps.app.loadLocalStorage(storageKey(kind));
            const value = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
            return Number.isFinite(value) ? value : undefined;
        } catch {
            return undefined;
        }
    }

    private markRan(kind: AutoKind): void {
        try {
            this.service.deps.app.saveLocalStorage(storageKey(kind), Date.now());
        } catch {
            // 存不进去只是丢掉「续表」能力，下一轮从完整间隔开始，无伤大雅。
        }
    }
}

// ── 时间戳存取 ──────────────────────────────────────────────────────────────

/**
 * 时间戳**按库隔离**存储。
 *
 * 用 `app.saveLocalStorage`（Obsidian ≥1.8.7 的按库 API）而不是原生
 * `globalThis.localStorage`：后者是所有库共用的一个存储区，
 * 于是「A 库刚自动提交过」会让「B 库刚打开就立刻提交一次」，
 * 两个库的自动周期互相干扰。
 *
 * 参考项目 obsidian-git 也是用 `app.saveLocalStorage`，
 * 而且专门写了一段迁移把老数据从原生 localStorage 搬过来 —— 说明这是个已修过的问题。
 */

function storageKey(kind: AutoKind): string {
    return `${STORAGE_KEY_PREFIX}${kind}`;
}

/** 距下次执行的分钟数：间隔减去已流逝时间，至少 0。 */
function remaining(last: number | undefined, intervalMinutes: number): number {
    if (last === undefined) return intervalMinutes;

    const elapsedMinutes = (Date.now() - last) / 60_000;
    return Math.max(0, intervalMinutes - elapsedMinutes);
}
