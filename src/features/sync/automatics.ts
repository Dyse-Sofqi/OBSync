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
