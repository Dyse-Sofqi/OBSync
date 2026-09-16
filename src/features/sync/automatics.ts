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
            this.schedule("commit", remaining("commit", current.autoCommitMinutes));
        }
        if (current.autoPushMinutes > 0) {
            this.schedule("push", remaining("push", current.autoPushMinutes));
        }
        if (current.autoPullMinutes > 0) {
            this.schedule("pull", remaining("pull", current.autoPullMinutes));
        }
    }

    /** 设置变化后调用：按完整间隔重新起表。 */
    restart(): void {
        this.start();
    }

    stop(): void {
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
        // 正在跑（比如用户手动同步）就放弃这一轮，等下一个整周期。
        // 排队会造成「队列里积了三个同步」，全部执行完已经过了很久。
        if (this.service.isBusy) {
            logger.debug(`auto ${kind} skipped: sync already running`);
            this.schedule(kind, this.intervalOf(kind));
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
            markRan(kind);
            const interval = this.intervalOf(kind);
            if (interval > 0) this.schedule(kind, interval);
        }
    }

    private intervalOf(kind: AutoKind): number {
        const current = this.settings();
        if (kind === "commit") return current.autoCommitMinutes;
        if (kind === "push") return current.autoPushMinutes;
        return current.autoPullMinutes;
    }
}

// ── 时间戳存取 ──────────────────────────────────────────────────────────────

function storageKey(kind: AutoKind): string {
    return `${STORAGE_KEY_PREFIX}${kind}`;
}

function markRan(kind: AutoKind): void {
    saveTimestamp(storageKey(kind), Date.now());
}

function saveTimestamp(key: string, value: number): void {
    try {
        (globalThis as { localStorage?: Storage }).localStorage?.setItem(
            key,
            String(value)
        );
    } catch {
        // 存不进去只是丢掉「续表」能力，下一轮从完整间隔开始，无伤大雅。
    }
}

function loadTimestamp(key: string): number | undefined {
    try {
        const raw = (globalThis as { localStorage?: Storage }).localStorage?.getItem(key);
        const value = raw ? Number.parseInt(raw, 10) : NaN;
        return Number.isFinite(value) ? value : undefined;
    } catch {
        return undefined;
    }
}

/** 距下次执行的分钟数：间隔减去已流逝时间，至少 0。 */
function remaining(kind: AutoKind, intervalMinutes: number): number {
    const last = loadTimestamp(storageKey(kind));
    if (last === undefined) return intervalMinutes;

    const elapsedMinutes = (Date.now() - last) / 60_000;
    return Math.max(0, intervalMinutes - elapsedMinutes);
}
