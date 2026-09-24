import { describe, expect, it } from "vitest";
import type { App } from "obsidian";
import {
    emptyState,
    forget,
    loadState,
    pruneState,
    recordSynced,
    sanitizeState,
    saveState,
    type ImageSyncState,
} from "../../../src/features/images/syncState";
import { createFakeImageVault } from "../../helpers/fakeImageVault";

/**
 * 状态清单。
 *
 * 这份数据是「双向删除」唯一的安全边界：**只有清单里记过的路径才允许被删**。
 * 所以这里要钉住的不是「读写对不对」，而是两条：
 *
 * 1. 坏值只丢它自己 —— 一条残缺记录的最坏后果是「这个文件按新增处理」，
 *    而整份丢弃会让所有文件都按新增处理；
 * 2. 读不出来时退回空清单 —— 那是最保守的一档（只复制、不删除）。
 */

const KEY = "obsync-image-state";

describe("emptyState", () => {
    it("空清单带版本号", () => {
        expect(emptyState()).toEqual({ version: 1, entries: {} });
    });

    it("每次返回新对象（不是共享的同一个引用）", () => {
        const first = emptyState();
        first.entries["a.png"] = { size: 1, mtime: 1, etag: "x", syncedAt: 0 };
        expect(emptyState().entries).toEqual({});
    });
});

describe("sanitizeState", () => {
    it("非对象 / 缺 entries 时退回空清单", () => {
        expect(sanitizeState(null)).toEqual(emptyState());
        expect(sanitizeState("garbage")).toEqual(emptyState());
        expect(sanitizeState([])).toEqual(emptyState());
        expect(sanitizeState({})).toEqual(emptyState());
        expect(sanitizeState({ entries: "nope" })).toEqual(emptyState());
        expect(sanitizeState({ entries: [] })).toEqual(emptyState());
    });

    it("保留形状正确的条目", () => {
        const state = sanitizeState({
            entries: { "a.png": { size: 10, mtime: 20, etag: '"abc"', syncedAt: 30 } },
        });

        expect(state.entries["a.png"]).toEqual({
            size: 10,
            mtime: 20,
            etag: '"abc"',
            syncedAt: 30,
        });
    });

    it("缺失的 syncedAt 补成 0（它只是展示用的时间）", () => {
        const state = sanitizeState({
            entries: { "a.png": { size: 1, mtime: 2, etag: "x" } },
        });
        expect(state.entries["a.png"]!.syncedAt).toBe(0);
    });

    /**
     * **坏值只丢它自己。**
     *
     * 这条是这份数据最重要的取舍：整份丢弃的后果是「所有文件都按新增处理」——
     * 于是本该传播到另一边的删除不会发生（偏保守，不算灾难），但下一轮
     * 两边会互相「补齐」，用户删掉的文件会**重新出现**。逐条丢弃把这个
     * 影响面限制在一个文件上。
     */
    it("逐条丢弃坏值，不牵连其他条目", () => {
        const state = sanitizeState({
            entries: {
                good: { size: 1, mtime: 1, etag: "e", syncedAt: 1 },
                "size-not-number": { size: "10", mtime: 1, etag: "e" },
                "size-nan": { size: Number.NaN, mtime: 1, etag: "e" },
                "mtime-not-number": { size: 1, mtime: null, etag: "e" },
                "mtime-infinite": { size: 1, mtime: Number.POSITIVE_INFINITY, etag: "e" },
                "etag-not-string": { size: 1, mtime: 1, etag: 5 },
                "not-object": "garbage",
                "null-entry": null,
            },
        });

        expect(Object.keys(state.entries)).toEqual(["good"]);
    });

    it("空路径的条目被丢弃", () => {
        const state = sanitizeState({ entries: { "": { size: 1, mtime: 1, etag: "e" } } });
        expect(state.entries).toEqual({});
    });

    it("版本号被改写成当前值（旧版本的数据不该让下游按老形状解释）", () => {
        expect(sanitizeState({ version: 99, entries: {} }).version).toBe(1);
    });
});

describe("loadState", () => {
    it("存储里没有值时给出空清单", () => {
        const vault = createFakeImageVault();
        expect(loadState(vault.app)).toEqual(emptyState());
    });

    it("读得回存进去的对象形态", () => {
        const vault = createFakeImageVault();
        const state = emptyState();
        recordSynced(state, "a.png", { size: 1, mtime: 2 }, "etag-1", 123);
        saveState(vault.app, state);

        expect(loadState(vault.app)).toEqual(state);
    });

    /**
     * `loadLocalStorage` 声明的返回类型是 `any`，而且**存的是对象还是字符串
     * 取决于 Obsidian 版本**（它内部会做一次 JSON 往返）—— 所以两种都要能读。
     */
    it("读得回字符串形态（Obsidian 某些版本会做 JSON 往返）", () => {
        const vault = createFakeImageVault();
        vault.localStorage.set(
            KEY,
            JSON.stringify({ entries: { "a.png": { size: 1, mtime: 2, etag: "e", syncedAt: 3 } } })
        );

        expect(loadState(vault.app).entries["a.png"]!.etag).toBe("e");
    });

    it("JSON 坏了时退回空清单（而不是抛错中断整轮同步）", () => {
        const vault = createFakeImageVault();
        vault.localStorage.set(KEY, "{ not json");

        expect(loadState(vault.app)).toEqual(emptyState());
    });

    it("存储本身不可用时退回空清单 —— 这是最保守的一档：只复制、不删除", () => {
        const app = {
            loadLocalStorage() {
                throw new Error("storage disabled");
            },
        } as unknown as App;

        expect(loadState(app)).toEqual(emptyState());
    });
});

describe("saveState", () => {
    it("写不进去也不抛错（这一轮的动作已经做完了）", () => {
        // 为了一个副作用失败去打断整个同步是得不偿失的 —— 后果只是
        // 「下次认不出删除」，而那是偏保守的一侧。
        const app = {
            saveLocalStorage() {
                throw new Error("quota exceeded");
            },
        } as unknown as App;

        expect(() => saveState(app, emptyState())).not.toThrow();
    });
});

describe("recordSynced / forget", () => {
    it("记下大小、mtime、etag 与时间", () => {
        const state: ImageSyncState = emptyState();
        recordSynced(state, "a.png", { size: 42, mtime: 7 }, "etag-7", 1000);

        expect(state.entries["a.png"]).toEqual({
            size: 42,
            mtime: 7,
            etag: "etag-7",
            syncedAt: 1000,
        });
    });

    it("重复记同一个路径是覆盖（不是累加）", () => {
        const state = emptyState();
        recordSynced(state, "a.png", { size: 1, mtime: 1 }, "e1", 1);
        recordSynced(state, "a.png", { size: 2, mtime: 2 }, "e2", 2);

        expect(Object.keys(state.entries)).toEqual(["a.png"]);
        expect(state.entries["a.png"]!.etag).toBe("e2");
    });

    it("forget 删掉一条", () => {
        const state = emptyState();
        recordSynced(state, "a.png", { size: 1, mtime: 1 }, "e", 1);
        forget(state, "a.png");

        expect(state.entries).toEqual({});
    });

    it("forget 一个不存在的路径不报错", () => {
        const state = emptyState();
        expect(() => forget(state, "nope.png")).not.toThrow();
    });
});

describe("pruneState", () => {
    /**
     * 不剪的话清单会随「历史上传过的每一个文件」无限增长，而 `localStorage`
     * 有容量上限 —— 满了之后 `saveState` 静默失败，于是**删除检测悄悄失效**。
     * 这正是那种「不出声就坏掉」的路径。
     */
    it("剪掉两边都已不存在的记录", () => {
        const state = emptyState();
        recordSynced(state, "alive.png", { size: 1, mtime: 1 }, "e", 1);
        recordSynced(state, "gone.png", { size: 1, mtime: 1 }, "e", 1);

        const removed = pruneState(state, new Set(["alive.png"]));

        expect(removed).toBe(1);
        expect(Object.keys(state.entries)).toEqual(["alive.png"]);
    });

    it("返回剪掉的条数（调用方据此判断清单有没有变小）", () => {
        const state = emptyState();
        recordSynced(state, "a.png", { size: 1, mtime: 1 }, "e", 1);
        recordSynced(state, "b.png", { size: 1, mtime: 1 }, "e", 1);

        expect(pruneState(state, new Set())).toBe(2);
        expect(pruneState(state, new Set())).toBe(0);
    });

    it("一个都不剪时不动任何记录", () => {
        const state = emptyState();
        recordSynced(state, "a.png", { size: 1, mtime: 1 }, "e", 1);

        expect(pruneState(state, new Set(["a.png"]))).toBe(0);
        expect(state.entries["a.png"]).toBeDefined();
    });
});
