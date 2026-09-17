import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Automatics, type AutomaticsSettings } from "../../src/features/sync/automatics";
import type { SyncService } from "../../src/features/sync/syncService";
import { createFakeApp, type FakeApp } from "../helpers/fakeApp";

/**
 * 自动定时器的行为。
 *
 * 这里踩过两个不显眼但真实的问题，都在本文件里锁住：
 *
 * 1. **时间戳没按库隔离** —— 原本用原生 `globalThis.localStorage`，
 *    那是所有库共用的存储区，于是 A 库的自动提交会影响 B 库的计时。
 *    （参考项目 obsidian-git 专门写过一段迁移来修这个问题。）
 * 2. **`stop()` 挡不住 in-flight 的 `fire()` 重新起表** —— 定时器被覆盖后
 *    再也 clear 不掉，设置变更会让同一动作每个周期跑两次。
 *
 * 计时类代码靠读代码很难确认对错，所以这些用例是必要的。
 */

interface Harness {
    service: SyncService;
    /** 依次记录被触发的动作。 */
    calls: string[];
    fake: FakeApp;
    setBusy(value: boolean): void;
    /** 本库的存储区（对应 Obsidian 的 app.localStorage）。 */
    store: Map<string, unknown>;
}

/** 只实现 Automatics 用到的部分。 */
function harness(options: { onSync?: () => Promise<void> } = {}): Harness {
    const fake = createFakeApp();
    const calls: string[] = [];
    let busy = false;

    const service = {
        deps: { app: fake.app },
        get isBusy(): boolean {
            return busy;
        },
        async sync(): Promise<void> {
            calls.push("sync");
            await options.onSync?.();
        },
        async pull(): Promise<void> {
            calls.push("pull");
        },
        async push(): Promise<void> {
            calls.push("push");
        },
        /**
         * 单独记一笔，用来断言「自动提交」那一档走的**不是**它 ——
         * 见「自动提交触发的是完整同步」那条。
         */
        async commitAll(): Promise<void> {
            calls.push("commitAll");
        },
    };

    return {
        service: service as unknown as SyncService,
        calls,
        fake,
        setBusy: (value: boolean) => {
            busy = value;
        },
        store: (fake.app as unknown as { localStorage: Map<string, unknown> }).localStorage,
    };
}

const EVERY_MINUTE: AutomaticsSettings = {
    enabled: true,
    autoCommitMinutes: 1,
    autoPushMinutes: 0,
    autoPullMinutes: 0,
};

const MINUTE_MS = 60_000;

/** 一个手动控制何时完成的 Promise。 */
function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
        resolve = r;
    });
    return { promise, resolve };
}

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe("起表与周期", () => {
    it("间隔为 0 时不起表", async () => {
        const { service, calls } = harness();
        const automatics = new Automatics(service, () => ({
            enabled: true,
            autoCommitMinutes: 0,
            autoPushMinutes: 0,
            autoPullMinutes: 0,
        }));

        automatics.start();
        await vi.advanceTimersByTimeAsync(MINUTE_MS * 5);

        expect(calls).toEqual([]);
    });

    /**
     * 这条守的是**文案与行为对齐**，不是实现细节。
     *
     * `commit` 这一档触发 `service.sync()`（提交 → 拉取 → 推送），设置页那一项
     * 也因此写成「自动提交**并同步**间隔」。两者的关系是双向的：改实现要改文案，
     * 改文案要改实现。所以这里把「调的是 sync」钉住 ——
     * 若有人只看着名字把它改成 `commitAll()`（让名字相符），这条会失败并把人
     * 引到这里；同时设置页那句「并同步」也得跟着改，否则就变成新的谎。
     */
    it("「自动提交」那一档触发的是完整同步，不是仅提交", async () => {
        const { service, calls } = harness();
        const automatics = new Automatics(service, () => EVERY_MINUTE);

        automatics.start();
        await vi.advanceTimersByTimeAsync(MINUTE_MS);

        expect(calls).toEqual(["sync"]);
        expect(calls).not.toContain("commitAll");
    });

    it("到点触发，并按完整间隔继续（周期运行）", async () => {
        const { service, calls } = harness();
        const automatics = new Automatics(service, () => EVERY_MINUTE);

        automatics.start();
        await vi.advanceTimersByTimeAsync(MINUTE_MS);
        expect(calls).toEqual(["sync"]);

        await vi.advanceTimersByTimeAsync(MINUTE_MS);
        expect(calls).toEqual(["sync", "sync"]);
    });

    it("没到点不触发", async () => {
        const { service, calls } = harness();
        const automatics = new Automatics(service, () => EVERY_MINUTE);

        automatics.start();
        await vi.advanceTimersByTimeAsync(MINUTE_MS - 1000);

        expect(calls).toEqual([]);
    });

    it("同步正在进行时跳过本轮，不排队", async () => {
        const { service, calls, setBusy } = harness();
        const automatics = new Automatics(service, () => EVERY_MINUTE);
        setBusy(true);

        automatics.start();
        await vi.advanceTimersByTimeAsync(MINUTE_MS);

        expect(calls).toEqual([]);

        // 跳过之后仍要按周期继续，不能就此停摆
        setBusy(false);
        await vi.advanceTimersByTimeAsync(MINUTE_MS);
        expect(calls).toEqual(["sync"]);
    });
});

describe("总开关（sync.enabled）", () => {
    /**
     * 这一组守的是一个真出过的问题：这个开关**只被写、从没被读过** ——
     * 设置页有开关、`data.json` 里存着值、README 也列着它，但没有一处代码读它。
     * 后果是「关掉同步」之后定时器照跑：自动提交照样每 N 分钟把笔记**推上远端**。
     * 用户做了 UI 提供给他的那个动作，却没有效果 —— 这比没有那个开关更糟。
     */
    it("关掉时一个定时器都不起", async () => {
        const { service, calls } = harness();
        const automatics = new Automatics(service, () => ({
            ...EVERY_MINUTE,
            enabled: false,
        }));

        automatics.start();
        await vi.advanceTimersByTimeAsync(MINUTE_MS * 5);

        expect(calls).toEqual([]);
    });

    it("运行中关掉：restart() 立即停表（不用重启 Obsidian）", async () => {
        const { service, calls } = harness();
        let settings: AutomaticsSettings = { ...EVERY_MINUTE };
        const automatics = new Automatics(service, () => settings);

        automatics.start();
        await vi.advanceTimersByTimeAsync(MINUTE_MS);
        expect(calls).toEqual(["sync"]);

        // 设置页拨开关 → commit() → applyDerivedSettings() → reload() → restart()
        settings = { ...settings, enabled: false };
        automatics.restart();
        await vi.advanceTimersByTimeAsync(MINUTE_MS * 5);

        expect(calls).toEqual(["sync"]); // 只剩关掉之前那一次
    });

    it("再打开能恢复（不会把定时器永久关死）", async () => {
        const { service, calls } = harness();
        let settings: AutomaticsSettings = { ...EVERY_MINUTE, enabled: false };
        const automatics = new Automatics(service, () => settings);

        automatics.start();
        await vi.advanceTimersByTimeAsync(MINUTE_MS * 2);
        expect(calls).toEqual([]);

        settings = { ...settings, enabled: true };
        automatics.restart();
        await vi.advanceTimersByTimeAsync(MINUTE_MS);

        expect(calls).toEqual(["sync"]);
    });
});

describe("stop() 与 restart() 的竞态", () => {
    it("stop() 之后，in-flight 的动作不会重新起表", async () => {
        const gate = deferred();
        const { service, calls } = harness({ onSync: () => gate.promise });
        const automatics = new Automatics(service, () => EVERY_MINUTE);

        automatics.start();
        await vi.advanceTimersByTimeAsync(MINUTE_MS);
        expect(calls).toHaveLength(1);

        // 动作还在跑时停掉（插件卸载 / 设置变更）
        automatics.stop();
        gate.resolve();
        await vi.advanceTimersByTimeAsync(0);

        // 再推进几个周期：不该有任何新的触发
        await vi.advanceTimersByTimeAsync(MINUTE_MS * 3);
        expect(calls).toHaveLength(1);
    });

    it("动作执行期间发生 restart()，不会留下孤儿定时器", async () => {
        // 这是「定时器再也 clear 不掉」的具体场景：
        // fire() 跑完会重新起表，而 restart() 已经起过一个 ——
        // 新起的会覆盖 Map 里的记录，先前那个就永远留在外面了。
        const gate = deferred();
        const { service, calls } = harness({ onSync: () => gate.promise });
        const automatics = new Automatics(service, () => EVERY_MINUTE);

        automatics.start();
        await vi.advanceTimersByTimeAsync(MINUTE_MS);
        expect(calls).toHaveLength(1);

        automatics.restart();
        gate.resolve();
        await vi.advanceTimersByTimeAsync(0);

        // 修复前这里是 3（孤儿定时器 + 新定时器各触发一次）；修复后是 2。
        await vi.advanceTimersByTimeAsync(MINUTE_MS);
        expect(calls).toHaveLength(2);

        // 再确认后续节奏没有被打乱
        await vi.advanceTimersByTimeAsync(MINUTE_MS);
        expect(calls).toHaveLength(3);
    });
});

describe("时间戳存储", () => {
    it("写进 app.saveLocalStorage（按库隔离），不是原生 localStorage", async () => {
        const { service, store } = harness();
        const automatics = new Automatics(service, () => EVERY_MINUTE);

        automatics.start();
        await vi.advanceTimersByTimeAsync(MINUTE_MS);

        expect(store.has("obsync-last-auto-commit")).toBe(true);
        expect(typeof store.get("obsync-last-auto-commit")).toBe("number");
    });

    it("启动时按「距上次执行的剩余时间」起表，而不是重新计满", async () => {
        const { service, store } = harness();
        const startedAt = Date.now();
        // 假装 40 秒前刚跑过（间隔 1 分钟 → 还剩 20 秒）
        const lastRan = startedAt - 40_000;
        store.set("obsync-last-auto-commit", lastRan);

        const automatics = new Automatics(service, () => EVERY_MINUTE);
        automatics.start();

        // 19 秒后还不该触发（剩 20 秒）—— 时间戳不该被刷新
        await vi.advanceTimersByTimeAsync(19_000);
        expect(store.get("obsync-last-auto-commit")).toBe(lastRan);

        // 再过 2 秒（累计 21 秒）应该已经触发过
        await vi.advanceTimersByTimeAsync(2_000);
        const recorded = store.get("obsync-last-auto-commit") as number;

        // 精确断言：启动时剩 20 秒，所以恰好在启动后 20 秒触发并刷新时间戳。
        // 这条同时证明了「按剩余时间起表」而不是「重新计满 1 分钟」。
        expect(recorded - startedAt).toBe(20_000);
    });
});
