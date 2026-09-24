import { describe, expect, it } from "vitest";
import { loadImageLibrary } from "../../../src/features/images/imageLibrary";
import type { ImageSyncService } from "../../../src/features/images/imageSyncService";
import type { RemoteObject } from "../../../src/features/images/types";
import { createFakeImageVault } from "../../helpers/fakeImageVault";

/**
 * 三方状态（本地 / 云端 / 引用）的汇总。
 *
 * 这一层的价值是**把三条互相独立的事实拼成一张表**，所以用例都在验
 * 「组合」：同一条记录上哪几个状态为真、计数对不对、以及**云端出问题时
 * 剩下那两维还能不能用**（那是面板在没配置 R2 时唯一的可用形态）。
 */

/** 只实现汇总需要的那几个方法 —— 其余用不到，硬造一个真服务没有意义。 */
function fakeService(options: {
    folders: string[];
    configured?: boolean;
    remote?: Record<string, { size: number; etag: string }>;
    listError?: unknown;
}): ImageSyncService {
    const inFolders = (path: string): boolean =>
        options.folders.some(
            (folder) => folder === "" || path === folder || path.startsWith(`${folder}/`)
        );

    // 替身照做**真实服务的那一层过滤**（`listRemoteImages` 会按受管文件夹筛）。
    // 少了它，这个替身会比真货宽松，于是「越界对象进了列表」这类问题在测试里
    // 永远看不出来 —— 而面板显示的正是这份列表。
    const remote = new Map<string, RemoteObject>(
        Object.entries(options.remote ?? {})
            .filter(([path]) => inFolders(path))
            .map(([key, value]) => [
                key,
                { key, size: value.size, etag: value.etag, lastModified: 1 },
            ])
    );

    return {
        getImageSettings: () => ({ folders: options.folders }),
        isConfigured: () => options.configured ?? true,
        async listRemoteImages() {
            if (options.listError) throw options.listError;
            return { remote, truncated: false };
        },
    } as unknown as ImageSyncService;
}

describe("loadImageLibrary", () => {
    it("三条轴各自为真，计数按轴统计（不是互斥分类）", async () => {
        const vault = createFakeImageVault();
        vault.seed("images/used.png", { bytes: 100 });
        vault.seed("images/orphan.png", { bytes: 200 });
        vault.seed("notes/n.md", { text: "![[images/used.png]]" });

        const library = await loadImageLibrary(
            vault.app,
            fakeService({
                folders: ["images"],
                remote: { "images/used.png": { size: 100, etag: "a" } },
            })
        );

        expect(library.records.map((record) => record.path)).toEqual([
            "images/orphan.png",
            "images/used.png",
        ]);

        const used = library.records.find((record) => record.path === "images/used.png")!;
        expect(used.local).toBeDefined();
        expect(used.remote).toBeDefined();
        expect(used.refs).toEqual(["notes/n.md"]);

        const orphan = library.records.find((record) => record.path === "images/orphan.png")!;
        expect(orphan.local).toBeDefined();
        expect(orphan.remote).toBeUndefined();
        expect(orphan.refs).toEqual([]);

        // used.png 同时计入 本地 / 云端 / 已链接 三个数 —— 这正是「三条轴」的意思。
        expect(library.counts).toEqual({
            local: 2,
            remote: 1,
            linked: 1,
            orphans: 1,
            total: 2,
            localBytes: 300,
        });
    });

    it("云端独有（本地已删）的图片也进列表", async () => {
        const vault = createFakeImageVault();
        vault.seed("images/keep.png", { bytes: 10 });

        const library = await loadImageLibrary(
            vault.app,
            fakeService({
                folders: ["images"],
                remote: { "images/cloud-only.png": { size: 50, etag: "b" } },
            })
        );

        const only = library.records.find((record) => record.path === "images/cloud-only.png")!;
        expect(only.local).toBeUndefined();
        expect(only.remote?.size).toBe(50);
        expect(library.counts.local).toBe(1);
        expect(library.counts.remote).toBe(1);
        expect(library.counts.total).toBe(2);
    });

    it("受管文件夹之外的图片不进列表（本地与云端都按同一个边界筛）", async () => {
        const vault = createFakeImageVault();
        vault.seed("templates/a.png", { bytes: 10 });
        vault.seed("images/b.png", { bytes: 10 });

        const library = await loadImageLibrary(
            vault.app,
            fakeService({
                folders: ["images"],
                remote: {
                    "templates/c.png": { size: 10, etag: "c" },
                    "images/b.png": { size: 10, etag: "d" },
                },
            })
        );

        expect(library.records.map((record) => record.path)).toEqual(["images/b.png"]);
    });

    it("非图片对象不进列表（同一个前缀下可能混着别的文件）", async () => {
        const vault = createFakeImageVault();
        vault.seed("images/a.png", { bytes: 10 });

        const library = await loadImageLibrary(
            vault.app,
            fakeService({
                folders: ["images"],
                remote: { "images/notes.pdf": { size: 10, etag: "e" } },
            })
        );

        expect(library.records.map((record) => record.path)).toEqual(["images/a.png"]);
    });

    /**
     * **云端失败不能让整页失败。**
     *
     * 「本地有哪些图」「哪些图没人引用」与 R2 完全无关，而它们正是清理失联
     * 图片与批量压缩要用的部分。把整页变成一句错误，等于把能用的功能一起关掉。
     */
    it("云端列举失败时仍然给出本地与引用两维，并记下错误", async () => {
        const vault = createFakeImageVault();
        vault.seed("images/a.png", { bytes: 10 });
        vault.seed("notes/n.md", { text: "![[images/a.png]]" });

        const failure = new Error("boom");
        const library = await loadImageLibrary(
            vault.app,
            fakeService({ folders: ["images"], listError: failure })
        );

        expect(library.remoteError).toBe(failure);
        expect(library.counts.local).toBe(1);
        expect(library.counts.linked).toBe(1);
        expect(library.counts.remote).toBe(0);
        expect(library.records[0]!.local).toBeDefined();
    });

    it("没配置 R2 时不去列举（也就不会有「云端失败」）", async () => {
        const vault = createFakeImageVault();
        vault.seed("images/a.png", { bytes: 10 });

        let listed = false;
        const service = {
            getImageSettings: () => ({ folders: ["images"] }),
            isConfigured: () => false,
            async listRemoteImages() {
                listed = true;
                return { remote: new Map(), truncated: false };
            },
        } as unknown as ImageSyncService;

        const library = await loadImageLibrary(vault.app, service);

        expect(listed).toBe(false);
        expect(library.remoteError).toBeUndefined();
        expect(library.counts.local).toBe(1);
    });

    it("一个受管文件夹都没配时列表为空（不报错）", async () => {
        const vault = createFakeImageVault();
        vault.seed("images/a.png", { bytes: 10 });

        const library = await loadImageLibrary(vault.app, fakeService({ folders: [] }));

        expect(library.records).toEqual([]);
        expect(library.counts.total).toBe(0);
    });
});
