import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App, TAbstractFile } from "obsidian";
import { createdSettings, Notice, resetCreatedSettings, TFile } from "../../stubs/obsidian";
import { Notifier } from "../../../src/core/notice";
import { zhCN } from "../../../src/core/i18n/locales/zh-cn";
import { normalizeSettings, type ImageSyncSettings } from "../../../src/core/settings";
import { SecretStore } from "../../../src/core/secretStore";
import { createImageSyncModule, type ImageSyncModule } from "../../../src/features/images";
import { createFakeImageVault, type FakeImageVault } from "../../helpers/fakeImageVault";
import { createFakeR2, type FakeR2 } from "../../helpers/fakeR2";

/**
 * 图片管理面板的批量删除（`ImageSyncModule.deleteImages`）。
 *
 * ## 这条路径与「删本地文件时的询问」是两条不同的路
 *
 * - `noteDeleted`：用户**在文件管理器里**删掉一张图 → 攒批 → 问一句「云端也删吗」。
 * - `deleteImages`：用户在**面板上**勾选、点按钮 → 云端处置**在点之前**就选好了
 *   （「仅删本地」/「本地云端都删」）→ 所以删完绝不能再问一遍。
 *
 * 第二条路上的坑都是「问重复了」或「墓碑没记」这一类：前者只是烦，
 * 后者会让用户刚删掉的图在下一轮同步里自己回来 —— 看起来像删除没生效。
 */

const STATE_KEY = "obsync-image-state";
const DEBOUNCE_MS = 1_000;

const BASE: Partial<ImageSyncSettings> = {
    folders: ["images"],
    accountId: "abc123",
    bucket: "notes",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    prefix: "",
};

interface Harness {
    vault: FakeImageVault;
    r2: FakeR2;
    module: ImageSyncModule;
    configure(next: Partial<ImageSyncSettings>): void;
    /** 记一条「上次同步时两边一致」。 */
    track(path: string): void;
    /** 模拟 Obsidian 在文件消失之后发出的那个事件。 */
    fireDeleted(path: string): void;
    /** 推过攒批窗口。 */
    flush(): Promise<void>;
    /** 已经弹过几次「云端也删吗」。 */
    promptCount(): number;
    /** 清单里某个路径的记录。 */
    entry(path: string): Record<string, unknown> | undefined;
    /** 所有提示的文案。 */
    messages(): string[];
}

const installed: FakeR2[] = [];

function createHarness(overrides: Partial<ImageSyncSettings> = {}): Harness {
    const vault = createFakeImageVault();
    const r2 = createFakeR2();
    r2.install();
    installed.push(r2);

    let images: Partial<ImageSyncSettings> = { ...BASE, ...overrides };

    const notifier = new Notifier({
        getShowNotices: () => true,
        getT: () => zhCN,
    });

    const module = createImageSyncModule({
        app: vault.app,
        notifier,
        getSettings: () => normalizeSettings({ images }),
        getT: () => zhCN,
        secretStore: new SecretStore({
            loadLocalStorage: (key: string) => (key === "obsync-token-r2" ? "secret-key" : null),
        } as unknown as App),
    });

    return {
        vault,
        r2,
        module,

        configure(next): void {
            images = { ...images, ...next };
        },

        track(path): void {
            const raw = (vault.localStorage.get(STATE_KEY) ?? { version: 1, entries: {} }) as {
                version: number;
                entries: Record<string, unknown>;
            };
            raw.entries[path] = { size: 10, mtime: 5, etag: "etag", syncedAt: 1 };
            vault.localStorage.set(STATE_KEY, raw);
        },

        fireDeleted(path): void {
            // 替身的 `TFile` 缺 `vault` 字段（真实 `TAbstractFile` 有它）——
            // 断言一次即可，别给替身加一个行为不对的 `vault`（见 MEMORY.md）。
            module.noteDeleted(new TFile(path) as unknown as TAbstractFile);
        },

        async flush(): Promise<void> {
            await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
        },

        promptCount(): number {
            // 图片模块本身不创建任何 `Setting`，所以「有几个 Setting」就等于
            // 「弹了几次询问窗」。
            return createdSettings.length;
        },

        entry(path) {
            const raw = vault.localStorage.get(STATE_KEY) as
                | { entries: Record<string, Record<string, unknown>> }
                | undefined;
            return raw?.entries[path];
        },

        messages(): string[] {
            return Notice.instances.map((notice) => String(notice.message));
        },
    };
}

beforeEach(() => {
    vi.useFakeTimers();
    resetCreatedSettings();
    Notice.instances.length = 0;
});

afterEach(() => {
    for (const r2 of installed.splice(0)) r2.restore();
    vi.useRealTimers();
});

describe("deleteImages：仅删本地", () => {
    it("本地进回收站、云端不动，并给每一张记墓碑", async () => {
        const h = createHarness();
        h.vault.seed("images/a.png", { bytes: 100 });
        h.vault.seed("images/b.png", { bytes: 100 });
        h.r2.objects.set("images/a.png", { size: 100, etag: "etag-a", lastModified: 1 });
        h.r2.objects.set("images/b.png", { size: 100, etag: "etag-b", lastModified: 1 });

        const result = await h.module.deleteImages(["images/a.png", "images/b.png"], {
            remote: false,
        });

        expect(result).toMatchObject({ localDeleted: 2, remoteDeleted: 0, errors: [] });
        expect(h.vault.trashed).toEqual(["images/a.png", "images/b.png"]);
        // 云端一份都没删。
        expect(h.r2.objects.size).toBe(2);
        expect(h.r2.requests.every((request) => request.method !== "DELETE")).toBe(true);

        // 墓碑：**清单里本来没有这两条**（换设备 / 清过浏览器存储的情形），
        // 所以它必须能凭空建一条 —— 否则下一轮同步会把图下载回来。
        expect(h.entry("images/a.png")).toMatchObject({
            remoteOnly: true,
            size: 100,
            etag: "etag-a",
        });
    });

    it("下一轮同步不会把删掉的图下载回来", async () => {
        const h = createHarness();
        h.vault.seed("images/a.png", { bytes: 100 });
        h.r2.objects.set("images/a.png", { size: 100, etag: "etag-a", lastModified: 1 });

        await h.module.deleteImages(["images/a.png"], { remote: false });

        const summary = await h.module.service.run();
        expect(summary.downloaded).toBe(0);
        expect(h.vault.has("images/a.png")).toBe(false);
        // 云端那一份留着。
        expect(h.r2.objects.has("images/a.png")).toBe(true);
    });

    it("只列举一次云端（不是每个路径一次）", async () => {
        const h = createHarness();
        for (const name of ["a", "b", "c"]) {
            h.vault.seed(`images/${name}.png`, { bytes: 10 });
            h.r2.objects.set(`images/${name}.png`, { size: 10, etag: "e", lastModified: 1 });
        }

        await h.module.deleteImages(["images/a.png", "images/b.png", "images/c.png"], {
            remote: false,
        });

        const lists = h.r2.requests.filter((request) => "list-type" in request.query);
        expect(lists).toHaveLength(1);
    });
});

describe("deleteImages：本地 + 云端都删", () => {
    it("云端对象真的被删掉，清单记录也清掉", async () => {
        const h = createHarness();
        h.vault.seed("images/a.png", { bytes: 100 });
        h.track("images/a.png");
        h.r2.objects.set("images/a.png", { size: 100, etag: "etag-a", lastModified: 1 });

        const result = await h.module.deleteImages(["images/a.png"], { remote: true });

        expect(result).toMatchObject({ localDeleted: 1, remoteDeleted: 1, errors: [] });
        expect(h.r2.objects.has("images/a.png")).toBe(false);
        expect(h.vault.has("images/a.png")).toBe(false);
        // 云端已经没有了，记录留着只会让下次删同名文件时白问一次。
        expect(h.entry("images/a.png")).toBeUndefined();
    });

    it("云端删除失败时**仍然删本地**，但留下墓碑并逐条报错", async () => {
        const h = createHarness();
        h.vault.seed("images/a.png", { bytes: 100 });
        h.r2.objects.set("images/a.png", { size: 100, etag: "etag-a", lastModified: 1 });
        // 删除一律 403（PUT / GET 不受影响）。
        h.r2.override = (request) => (request.method === "DELETE" ? { status: 403 } : undefined);

        const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
        let result;
        try {
            result = await h.module.deleteImages(["images/a.png"], { remote: true });
        } finally {
            logged.mockRestore();
        }

        expect(result!.localDeleted).toBe(1);
        expect(result!.remoteDeleted).toBe(0);
        expect(result!.errors).toHaveLength(1);
        expect(result!.errors[0]!.path).toBe("images/a.png");
        expect(h.vault.has("images/a.png")).toBe(false);
        // 云端那份还在，墓碑必须留着 —— 否则下一轮同步把它下载回来，
        // 用户看到的又是「删除没生效」。
        expect(h.r2.objects.has("images/a.png")).toBe(true);
        expect(h.entry("images/a.png")!.remoteOnly).toBe(true);
    });
});

describe("deleteImages：边界与容错", () => {
    it("受管文件夹之外一律不动，并逐条报出原因", async () => {
        const h = createHarness({ folders: ["images"] });
        h.vault.seed("templates/a.png", { bytes: 10 });

        const result = await h.module.deleteImages(["templates/a.png"], { remote: true });

        expect(result.localDeleted).toBe(0);
        expect(result.errors).toHaveLength(1);
        expect(h.vault.has("templates/a.png")).toBe(true);
        expect(h.r2.requests).toEqual([]);
    });

    it("本地已经没有了（只留在云端）时不算失败", async () => {
        const h = createHarness();
        h.r2.objects.set("images/gone.png", { size: 10, etag: "e", lastModified: 1 });

        const result = await h.module.deleteImages(["images/gone.png"], { remote: true });

        expect(result).toMatchObject({ localDeleted: 0, remoteDeleted: 1, errors: [] });
        expect(h.r2.objects.has("images/gone.png")).toBe(false);
    });

    it("没配置云端时「仅删本地」照常工作（不需要列举）", async () => {
        const h = createHarness({ bucket: "" });
        h.vault.seed("images/a.png", { bytes: 10 });

        const result = await h.module.deleteImages(["images/a.png"], { remote: false });

        expect(result).toMatchObject({ localDeleted: 1, errors: [] });
        expect(h.r2.requests).toEqual([]);
    });
});

describe("面板删除之后不再重复询问「云端也删吗」", () => {
    it("面板删过的路径不会触发询问（用户已经在面板上选过了）", async () => {
        const h = createHarness();
        h.vault.seed("images/a.png", { bytes: 100 });
        h.track("images/a.png");
        h.r2.objects.set("images/a.png", { size: 100, etag: "etag-a", lastModified: 1 });

        await h.module.deleteImages(["images/a.png"], { remote: false });

        // Obsidian 会在文件真的消失之后发出这个事件。
        h.fireDeleted("images/a.png");
        await h.flush();

        expect(h.promptCount()).toBe(0);
    });

    it("对照组：手动删掉同一个库里的另一张图**照常询问**", async () => {
        const h = createHarness();
        h.vault.seed("images/a.png", { bytes: 100 });
        h.vault.seed("images/manual.png", { bytes: 100 });
        h.track("images/manual.png");
        h.r2.objects.set("images/manual.png", { size: 100, etag: "e", lastModified: 1 });

        await h.module.deleteImages(["images/a.png"], { remote: false });

        h.vault.remove("images/manual.png");
        h.fireDeleted("images/manual.png");
        await h.flush();

        expect(h.promptCount()).toBe(1);
    });

    it("下一批面板删除会清掉上一批的残留标记", async () => {
        const h = createHarness();
        h.vault.seed("images/a.png", { bytes: 100 });
        h.vault.seed("images/b.png", { bytes: 100 });
        h.track("images/a.png");
        h.track("images/b.png");
        h.r2.objects.set("images/a.png", { size: 100, etag: "e", lastModified: 1 });
        h.r2.objects.set("images/b.png", { size: 100, etag: "e", lastModified: 1 });

        // 第一批：只删 a，且**不**触发删除事件（模拟事件没到 / 被别处吞掉）。
        await h.module.deleteImages(["images/a.png"], { remote: false });

        // 第二批：删 b。
        await h.module.deleteImages(["images/b.png"], { remote: false });

        // 残留的 a 标记必须被清掉 —— 否则用户后来手动删同名文件时
        // 会**悄悄跳过询问**，而「该问不问」比「多问一次」糟得多。
        h.fireDeleted("images/a.png");
        await h.flush();
        expect(h.promptCount()).toBe(1);
    });
});
