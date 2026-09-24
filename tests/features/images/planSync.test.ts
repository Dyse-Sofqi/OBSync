import { afterEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { Notifier } from "../../../src/core/notice";
import { zhCN } from "../../../src/core/i18n/locales/zh-cn";
import {
    normalizeSettings,
    type ImageSyncSettings,
    type ObsyncSettings,
} from "../../../src/core/settings";
import { SecretStore } from "../../../src/core/secretStore";
import {
    ImageSyncService,
    contentTypeFor,
    normalizePrefix,
    pathFromKey,
} from "../../../src/features/images/imageSyncService";
import type { SyncPlan, SyncSummary } from "../../../src/features/images/types";
import { createFakeImageVault, type FakeImageVault } from "../../helpers/fakeImageVault";
import { createFakeR2, type FakeR2 } from "../../helpers/fakeR2";

/**
 * 同步引擎的判定与执行。
 *
 * ## 这个文件里最重要的是「安全不变量」那一组
 *
 * > 只有**状态清单里记过的路径**才允许产生删除动作。
 *
 * 这条不变量把「清单丢失」（换设备、清了浏览器存储、手改坏了 data.json）
 * 的后果限制成「两边补齐」，而**不会**变成「把云端清空」。它的实现就是
 * `decide()` 里那两个 `if (tracked)` 分支 —— 少一个 `tracked &&`，
 * 一次清单丢失就会删掉用户的整个图片文件夹。
 *
 * ## 第二重要的是「截断」那一组
 *
 * 云端列举不完整时，「云端没有这个对象」这个前提不成立，于是删除必须停下。
 * 这两组都是**只错一次就够**的路径，所以每条都单独钉住。
 */

const STATE_KEY = "obsync-image-state";

/**
 * 默认配置。
 *
 * `prefix` 取**桶根**（空串），于是对象键与 vault 路径一一对应 ——
 * 用例里的 `remote("images/a.png")` 就是「vault 里的 `images/a.png` 在云端的
 * 那一份」，读起来不用做心算。
 *
 * 前缀是「放在桶的哪儿」，与 vault 路径无关：配成 `"images/"` 时
 * `images/a.png` 的对象键会是 `images/images/a.png`。那不是 bug，
 * 但会把每一条用例的键都绕一层，所以单独用一条用例钉住它。
 */
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
    service: ImageSyncService;
    /** 改设置（下一次调用 plan/run 时生效）。 */
    configure(next: Partial<ImageSyncSettings>): void;
    /** 当前设置（断言设置归一化结果用）。 */
    settings(): ObsyncSettings;
    /** 记一条「上次同步时两边一致」。 */
    track(path: string, entry: { size: number; mtime: number; etag: string }): void;
    /** 云端放一个对象。key 需要自己带前缀。 */
    remote(key: string, size: number, etag: string, lastModified?: number): void;
    /** 状态清单里存着什么（断言「记下来了 / 剪掉了 / 立了墓碑」用）。 */
    saved(): Record<string, { size: number; mtime: number; etag: string; remoteOnly?: boolean }>;
}

const installed: FakeR2[] = [];

function createHarness(overrides: Partial<ImageSyncSettings> = {}): Harness {
    const vault = createFakeImageVault();
    const r2 = createFakeR2();
    r2.install();
    installed.push(r2);

    let images: Partial<ImageSyncSettings> = { ...BASE, ...overrides };

    const secretStore = new SecretStore({
        // `requireApiVersion("1.11.4")` 为真，但 `secretStorage` 不在场 →
        // 回落到 localStorage（与真机上老版本 Obsidian 的行为一致）。
        loadLocalStorage: (key: string) => (key === "obsync-token-r2" ? "secret-key" : null),
    } as unknown as App);

    const notifier = new Notifier({
        // 静音提示：这些用例断言的是行为，不是弹窗。
        getShowNotices: () => false,
        getT: () => zhCN,
    });

    const service = new ImageSyncService({
        app: vault.app,
        notifier,
        getT: () => zhCN,
        getSettings: () => normalizeSettings({ images }),
        secretStore,
    });

    return {
        vault,
        r2,
        service,

        configure(next): void {
            images = { ...images, ...next };
        },

        settings(): ObsyncSettings {
            return normalizeSettings({ images });
        },

        track(path, entry): void {
            const raw = (vault.localStorage.get(STATE_KEY) ?? { version: 1, entries: {} }) as {
                version: number;
                entries: Record<string, unknown>;
            };
            raw.entries[path] = { ...entry, syncedAt: 1 };
            vault.localStorage.set(STATE_KEY, raw);
        },

        remote(key, size, etag, lastModified = 1_000): void {
            r2.objects.set(key, { size, etag, lastModified });
        },

        saved(): Record<string, { size: number; mtime: number; etag: string; remoteOnly?: boolean }> {
            const raw = vault.localStorage.get(STATE_KEY) as
                | {
                      entries?: Record<
                          string,
                          { size: number; mtime: number; etag: string; remoteOnly?: boolean }
                      >;
                  }
                | undefined;
            return raw?.entries ?? {};
        },
    };
}

afterEach(() => {
    for (const r2 of installed.splice(0)) r2.restore();
});

/** 只看某一个路径的判定结果。 */
function entryFor(plan: SyncPlan, path: string) {
    const entry = plan.entries.find((item) => item.path === path);
    if (!entry) throw new Error(`计划里没有 ${path}：${JSON.stringify(plan.entries)}`);
    return entry;
}

// ─────────────────────────────────────────────────────────────────────────────
// 一、清单丢失或损坏时：只补齐，不删除、也不盲目覆盖
// ─────────────────────────────────────────────────────────────────────────────

describe("清单丢失或损坏时", () => {
    /**
     * 「本地有、云端没有」**只有一种**处理方式：传上去。
     *
     * 这里曾经是本文件最要紧的一条用例，守的是「清单里没有记录时不许删本地」。
     * 双向删除去掉之后，删除已经不在计划里了 —— 这条用例仍然留着，因为它
     * 钉住的是**镜像的本意**：少了哪一边就补哪一边。
     */
    it("本地有、云端没有 → 上传", async () => {
        const h = createHarness();
        h.vault.seed("images/a.png", { bytes: 100 });

        const plan = await h.service.plan();

        expect(plan.entries).toEqual([
            { path: "images/a.png", action: "upload", reason: "local-new", size: 100 },
        ]);
    });

    it("云端有、本地没有 → 下载", async () => {
        const h = createHarness();
        h.remote("images/a.png", 100, "etag-a");

        const plan = await h.service.plan();

        expect(plan.entries).toEqual([
            { path: "images/a.png", action: "download", reason: "remote-new", size: 100 },
        ]);
    });

    /**
     * 清单**整个丢失**（换设备、清了存储）时，一轮跑完的后果只能是「两边补齐」。
     *
     * 这条是上一条的规模化版本：把两边的差异铺开成「本地独有 + 云端独有」，
     * 断言结果是上传 + 下载，**一个删除都没有**。
     */
    it("清单整个丢失时：只补齐，不删除任何一边", async () => {
        const h = createHarness();
        h.vault.seed("images/local-only.png", { bytes: 10 });
        h.vault.seed("images/both.png", { bytes: 20 });
        h.remote("images/remote-only.png", 30, "etag-r");
        h.remote("images/both.png", 20, "etag-b");
        // 清单里什么都没有

        const plan = await h.service.plan();

        expect(plan.entries.map((entry) => [entry.path, entry.action])).toEqual([
            ["images/both.png", "skip"],
            ["images/local-only.png", "upload"],
            ["images/remote-only.png", "download"],
        ]);
        expect(plan.entries.some((entry) => entry.action.startsWith("delete"))).toBe(false);
    });

    it("清单损坏（不是合法 JSON）时同样只补齐", async () => {
        const h = createHarness();
        h.vault.seed("images/a.png", { bytes: 10 });
        h.vault.localStorage.set(STATE_KEY, "{ 坏掉的 json");

        const plan = await h.service.plan();

        expect(plan.entries[0]!.action).toBe("upload");
    });

    it("清单里的条目形状不对时，只丢它自己（其他路径照常按记录判定）", async () => {
        const h = createHarness();
        // a 的记录坏了（size 不是数字）→ 等于没记录 → 两边都有且大小不同
        //   只能按「冲突」处理（猜不出是谁改的，于是交给策略，而不是盲目覆盖）
        h.vault.seed("images/a.png", { bytes: 10, mtime: 5 });
        h.remote("images/a.png", 999, "etag-a");
        // b 的记录完好 → 正确判成「一致」
        h.vault.seed("images/b.png", { bytes: 10, mtime: 5 });
        h.remote("images/b.png", 10, "etag-b");
        h.vault.localStorage.set(STATE_KEY, {
            version: 1,
            entries: {
                "images/a.png": { size: "十", mtime: 1, etag: "e" },
                "images/b.png": { size: 10, mtime: 5, etag: "etag-b" },
            },
        });

        const plan = await h.service.plan();

        expect(entryFor(plan, "images/a.png").reason).toBe("conflict");
        expect(entryFor(plan, "images/b.png").reason).toBe("in-sync");
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 二、镜像：只补齐，从不删除
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 「双向删除同步」在 2026-09-23 被去掉了，原因是那个判断本质上做不准
 * （同一个「本地有、云端没有」既可能是用户删了云端那份，也可能是本地新增；
 * 清单丢失或两台设备各删一边时就会错）。这一组钉住**取而代之的行为**。
 */
describe("镜像：只补齐，从不删除", () => {
    it("云端那份不见了（清单里记过）→ 重新上传，**不删本地**", async () => {
        const h = createHarness();
        h.vault.seed("images/a.png", { bytes: 100, mtime: 5 });
        h.track("images/a.png", { size: 100, mtime: 5, etag: "etag-a" });

        const plan = await h.service.plan();

        expect(plan.entries).toEqual([
            { path: "images/a.png", action: "upload", reason: "local-new", size: 100 },
        ]);
        expect(plan.entries.some((entry) => entry.action.startsWith("delete"))).toBe(false);
    });

    it("本地那份不见了（清单里记过）→ 下载回来", async () => {
        const h = createHarness();
        h.remote("images/a.png", 100, "etag-a");
        h.track("images/a.png", { size: 100, mtime: 5, etag: "etag-a" });

        const plan = await h.service.plan();

        expect(plan.entries).toEqual([
            { path: "images/a.png", action: "download", reason: "remote-new", size: 100 },
        ]);
    });

    /**
     * 整个计划里**不可能出现任何删除动作**。
     *
     * 这条是上面两条的规模化版本：把各种「少了一边」的情况铺开，
     * 断言结果里一个删除都没有 —— 那正是这套改动的全部意义。
     */
    it("任何输入组合都产不出删除动作", async () => {
        const h = createHarness();
        h.vault.seed("images/local-only.png", { bytes: 10 });
        h.vault.seed("images/both.png", { bytes: 20, mtime: 9_000 });
        h.remote("images/remote-only.png", 30, "etag-r");
        h.remote("images/both.png", 999, "etag-changed", 1_000);
        h.track("images/local-only.png", { size: 10, mtime: 1, etag: "e" });
        h.track("images/remote-only.png", { size: 30, mtime: 1, etag: "e" });
        h.track("images/both.png", { size: 20, mtime: 1, etag: "e" });

        const plan = await h.service.plan();

        expect(plan.entries.some((entry) => entry.action.startsWith("delete"))).toBe(false);
        // 三种情况都落在「复制」或「冲突」上
        expect(plan.entries.map((entry) => entry.action).sort()).toEqual([
            "conflict",
            "download",
            "upload",
        ]);
    });

    it("默认就会问「云端那份也删吗」", () => {
        expect(createHarness().settings().images.deleteRemotePolicy).toBe("ask");
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 三、两边都有
// ─────────────────────────────────────────────────────────────────────────────

describe("两边都有", () => {
    it("清单里一致 → 跳过", async () => {
        const h = createHarness();
        h.vault.seed("images/a.png", { bytes: 100, mtime: 5 });
        h.remote("images/a.png", 100, "etag-a");
        h.track("images/a.png", { size: 100, mtime: 5, etag: "etag-a" });

        const plan = await h.service.plan();

        expect(plan.entries).toEqual([
            { path: "images/a.png", action: "skip", reason: "in-sync", size: 100 },
        ]);
    });

    it("本地变了（大小不同）→ 上传", async () => {
        const h = createHarness();
        h.vault.seed("images/a.png", { bytes: 200, mtime: 5 });
        h.remote("images/a.png", 100, "etag-a");
        h.track("images/a.png", { size: 100, mtime: 5, etag: "etag-a" });

        const plan = await h.service.plan();

        expect(entryFor(plan, "images/a.png").reason).toBe("local-changed");
        expect(entryFor(plan, "images/a.png").action).toBe("upload");
    });

    it("本地变了（mtime 更新，大小相同）→ 上传", async () => {
        const h = createHarness();
        h.vault.seed("images/a.png", { bytes: 100, mtime: 99 });
        h.remote("images/a.png", 100, "etag-a");
        h.track("images/a.png", { size: 100, mtime: 5, etag: "etag-a" });

        expect(entryFor(await h.service.plan(), "images/a.png").reason).toBe("local-changed");
    });

    it("远端变了（etag 不同）→ 下载", async () => {
        const h = createHarness();
        h.vault.seed("images/a.png", { bytes: 100, mtime: 5 });
        h.remote("images/a.png", 100, "etag-new");
        h.track("images/a.png", { size: 100, mtime: 5, etag: "etag-old" });

        const plan = await h.service.plan();

        expect(entryFor(plan, "images/a.png").reason).toBe("remote-changed");
        expect(entryFor(plan, "images/a.png").action).toBe("download");
    });

    it("两边都变了 → 冲突（**不能**当成新增，那会无条件覆盖一边）", async () => {
        const h = createHarness();
        h.vault.seed("images/a.png", { bytes: 200, mtime: 5 });
        h.remote("images/a.png", 300, "etag-new");
        h.track("images/a.png", { size: 100, mtime: 1, etag: "etag-old" });

        const plan = await h.service.plan();

        expect(entryFor(plan, "images/a.png").reason).toBe("conflict");
    });

    /**
     * 冲突在**预览里**要显示成 `conflict`，不能显示成 `upload` / `download`。
     *
     * 这一页存在的意义是「执行前看清有哪些东西会被覆盖」，而冲突正是那种
     * 有一边改动要消失的情况。写成 upload 会让它混进普通上传里、
     * 还带上「安全」的绿色 —— 设置页里那段 `action === "conflict"` 的
     * 警示配色会变成永远走不到的死代码。
     */
    it("冲突在计划里显示成 conflict（不是 upload/download）", async () => {
        const h = createHarness();
        h.vault.seed("images/a.png", { bytes: 200, mtime: 5 });
        h.remote("images/a.png", 300, "etag-new");
        h.track("images/a.png", { size: 100, mtime: 1, etag: "etag-old" });

        expect(entryFor(await h.service.plan(), "images/a.png").action).toBe("conflict");
    });

    it("冲突策略 newer：本地更新时上传", async () => {
        const h = createHarness({ conflictPolicy: "newer" });
        h.vault.seed("images/a.png", { bytes: 200, mtime: 5_000 });
        h.remote("images/a.png", 300, "etag-new", 4_000);
        h.track("images/a.png", { size: 100, mtime: 1, etag: "etag-old" });

        // 计划里是 conflict，执行时按策略走 —— 从摘要看方向。
        expect(entryFor(await h.service.plan(), "images/a.png").action).toBe("conflict");
    });

    it("冲突策略 newer：远端更新时下载", async () => {
        const h = createHarness({ conflictPolicy: "newer" });
        h.vault.seed("images/a.png", { bytes: 200, mtime: 1_000 });
        h.remote("images/a.png", 300, "etag-new", 9_000);
        h.track("images/a.png", { size: 100, mtime: 1, etag: "etag-old" });

        const summary = await h.service.run();

        expect(summary.downloaded).toBe(1);
        expect(summary.uploaded).toBe(0);
    });

    it("冲突策略 local：一律上传（不看时间戳）", async () => {
        const h = createHarness({ conflictPolicy: "local" });
        h.vault.seed("images/a.png", { bytes: 200, mtime: 1_000 });
        h.remote("images/a.png", 300, "etag-new", 9_000);
        h.track("images/a.png", { size: 100, mtime: 1, etag: "etag-old" });

        const summary = await h.service.run();

        expect(summary.uploaded).toBe(1);
        expect(summary.downloaded).toBe(0);
    });

    it("冲突策略 remote：一律下载（不看时间戳）", async () => {
        const h = createHarness({ conflictPolicy: "remote" });
        h.vault.seed("images/a.png", { bytes: 200, mtime: 9_000 });
        h.remote("images/a.png", 300, "etag-new", 1_000);
        h.track("images/a.png", { size: 100, mtime: 1, etag: "etag-old" });

        const summary = await h.service.run();

        expect(summary.downloaded).toBe(1);
        expect(summary.uploaded).toBe(0);
    });

    it("清单里没记过且两边大小相同 → 当作一致（并借这一轮记下来）", async () => {
        const h = createHarness();
        h.vault.seed("images/a.png", { bytes: 100, mtime: 5 });
        h.remote("images/a.png", 100, "etag-a");

        const summary = await h.service.run();

        expect(summary.skipped).toBe(1);
        expect(summary.uploaded + summary.downloaded).toBe(0);
        // 记下来了 —— 下次它被删时才能认出来
        expect(h.saved()["images/a.png"]).toMatchObject({ size: 100, etag: "etag-a" });
    });

    it("清单里没记过且两边大小不同 → 冲突（不是新增）", async () => {
        const h = createHarness();
        h.vault.seed("images/a.png", { bytes: 100, mtime: 5 });
        h.remote("images/a.png", 999, "etag-a");

        expect(entryFor(await h.service.plan(), "images/a.png").reason).toBe("conflict");
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 四、边界：前缀与受管文件夹
// ─────────────────────────────────────────────────────────────────────────────

describe("边界（前缀 + 受管文件夹）", () => {
    it("前缀之外的对象**完全不管**（同一个桶里可能放着别的应用的数据）", async () => {
        const h = createHarness();
        h.remote("other/a.png", 10, "etag");

        const plan = await h.service.plan();

        expect(plan.entries).toEqual([]);
        expect(plan.remoteCount).toBe(0);
    });

    /**
     * 前缀之下但不在受管文件夹里的对象也要跳过。
     *
     * 前缀回答的是「放在桶的哪儿」，文件夹回答的是「管哪些」——
     * 两者都成立才归我们处理。少了后一条，用户把前缀设成桶根
     * （或者把前缀改小）就会把别人的对象当成自己的，
     * 于是「云端新增 → 下载到库里」。
     */
    it("前缀之下但不在受管文件夹里的对象**不下载**", async () => {
        const h = createHarness({ prefix: "", folders: ["images"] });
        h.remote("images/a.png", 10, "etag");
        h.remote("templates/diagram.svg", 10, "etag");
        h.remote("other/b.png", 10, "etag");

        const plan = await h.service.plan();

        expect(plan.entries.map((entry) => entry.path)).toEqual(["images/a.png"]);
    });

    it("受管文件夹之外的本地图片不入计划", async () => {
        const h = createHarness();
        h.vault.seed("templates/diagram.svg", { bytes: 10 });
        h.vault.seed("images/a.png", { bytes: 10 });

        expect((await h.service.plan()).entries.map((entry) => entry.path)).toEqual([
            "images/a.png",
        ]);
    });

    it("多个受管文件夹取并集", async () => {
        const h = createHarness({ folders: ["images", "assets"] });
        h.vault.seed("images/a.png", { bytes: 1 });
        h.vault.seed("assets/b.png", { bytes: 1 });
        h.vault.seed("other/c.png", { bytes: 1 });

        expect((await h.service.plan()).entries.map((entry) => entry.path)).toEqual([
            "assets/b.png",
            "images/a.png",
        ]);
    });

    it("计划条目按路径排序（界面上的顺序要稳定）", async () => {
        const h = createHarness();
        h.vault.seed("images/c.png", { bytes: 1 });
        h.vault.seed("images/a.png", { bytes: 1 });
        h.remote("images/b.png", 1, "e");

        expect((await h.service.plan()).entries.map((entry) => entry.path)).toEqual([
            "images/a.png",
            "images/b.png",
            "images/c.png",
        ]);
    });

    it("没有受管文件夹时什么都不做（**不碰任何文件**）", async () => {
        const h = createHarness({ folders: [] });
        h.vault.seed("images/a.png", { bytes: 10 });

        await expect(h.service.plan()).rejects.toMatchObject({ kind: "noFolders" });
    });

    /**
     * 前缀是「放在桶的哪儿」，与 vault 路径无关 —— 两者**各管一件事**。
     *
     * 配了前缀时：上传的键带上它、列举只问这个前缀、拿回来的键剥掉它。
     * 这条用例同时钉住三处，少任何一处都会让「配了前缀就全都对不上」。
     */
    it("配了前缀时：键带上前缀，列举只问前缀，回来时剥掉", async () => {
        const h = createHarness({ prefix: "sync/" });
        h.vault.seed("images/a.png", { bytes: 10 });
        h.remote("sync/images/b.png", 20, "etag-b");

        const plan = await h.service.plan();

        // 云端那条被正确还原成 vault 路径（剥掉了前缀），所以是「下载」而不是「忽略」
        expect(plan.entries.map((entry) => [entry.path, entry.action])).toEqual([
            ["images/a.png", "upload"],
            ["images/b.png", "download"],
        ]);

        await h.service.run();

        const put = h.r2.requests.find((request) => request.method === "PUT")!;
        expect(put.key).toBe("sync/images/a.png");
        expect(h.r2.requests[0]!.query.prefix).toBe("sync/");
    });

    /**
     * 设置里存的是**用户写的原文**，归一发生在使用它的那一刻
     * （`buildR2Config` → `normalizePrefix`）。
     *
     * 这个分工是有意的：用户回头打开设置页，看到的是自己写的那一行，
     * 而不是被悄悄改写过的形态。而所有真正拼键、拼查询串的地方都走
     * `createClient()`，所以「归一」不会漏。
     */
    it("前缀两端的斜杠在**使用时**归一，设置里保留原文", () => {
        expect(createHarness({ prefix: "/sync/" }).settings().images.prefix).toBe("/sync/");

        expect(normalizePrefix("/sync/")).toBe("sync/");
        expect(normalizePrefix("sync")).toBe("sync/");
        expect(normalizePrefix("//sync//")).toBe("sync/");
        expect(normalizePrefix("  sync  ")).toBe("sync/");
    });

    it("空前缀（或只有一个斜杠）归一成空串 = 桶根", () => {
        expect(normalizePrefix("")).toBe("");
        expect(normalizePrefix("/")).toBe("");
        expect(normalizePrefix("   ")).toBe("");
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 五、截断
// ─────────────────────────────────────────────────────────────────────────────

describe("云端列举被截断", () => {
    /**
     * 截断现在**只是提示**，不再影响任何动作 —— 删除已经不在计划里了，
     * 所以「没列到的对象被误判成已删除」这条风险随之消失。
     *
     * 剩下的后果是「云端有、但没被列到」会被当成缺一份而重传。重传是安全的
     * （内容一样），只是白传 —— 界面上要说出来，否则看起来像重复上传的 bug。
     */
    it("计划里标记截断，但动作照常（只是可能多传几份）", async () => {
        const h = createHarness();
        h.r2.endlessPagination = true;
        h.vault.seed("images/a.png", { bytes: 100, mtime: 5 });

        const plan = await h.service.plan();
        expect(plan.truncated).toBe(true);
        expect(entryFor(plan, "images/a.png").action).toBe("upload");

        const summary = await h.service.run();

        expect(summary.uploaded).toBe(1);
        expect(summary.truncated).toBe(true);
    });

    it("截断时下载照常进行", async () => {
        const h = createHarness();
        h.r2.endlessPagination = true;
        h.remote("images/a.png", 10, "etag-a");

        const summary = await h.service.run();

        expect(summary.downloaded).toBe(1);
        expect(summary.truncated).toBe(true);
    });

    it("截断时**仍然不会删除任何东西**", async () => {
        const h = createHarness();
        h.r2.endlessPagination = true;
        h.vault.seed("images/a.png", { bytes: 100, mtime: 5 });
        h.track("images/a.png", { size: 100, mtime: 5, etag: "etag-a" });

        await h.service.run();

        // 云端那份「看不见」了，但本地文件必须还在
        expect(h.vault.has("images/a.png")).toBe(true);
        expect(h.vault.trashed).toEqual([]);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 六、执行
// ─────────────────────────────────────────────────────────────────────────────

describe("执行", () => {
    it("上传：内容真的写上去，并记进清单", async () => {
        const h = createHarness();
        h.vault.seed("images/a.png", { bytes: 100, mtime: 7 });

        const summary = await h.service.run();

        expect(summary.uploaded).toBe(1);
        expect(h.r2.objects.get("images/a.png")!.size).toBe(100);
        expect(h.saved()["images/a.png"]).toMatchObject({ size: 100, mtime: 7 });
        // 记下的 etag 是服务端返回的那个（已去引号）
        expect(h.saved()["images/a.png"]!.etag).toBe(h.r2.objects.get("images/a.png")!.etag);
    });

    it("上传时按扩展名给 Content-Type", async () => {
        const h = createHarness();
        h.vault.seed("images/a.webp", { bytes: 10 });

        await h.service.run();

        const put = h.r2.requests.find((request) => request.method === "PUT")!;
        expect(put.headers["Content-Type"]).toBe("image/webp");
    });

    it("下载：写进 vault，并记进清单", async () => {
        const h = createHarness();
        h.remote("images/a.png", 3, "etag-a");
        h.r2.objects.get("images/a.png")!.body = new Uint8Array([1, 2, 3]).buffer;

        const summary = await h.service.run();

        expect(summary.downloaded).toBe(1);
        expect(h.vault.has("images/a.png")).toBe(true);
        expect(h.saved()["images/a.png"]!.etag).toBe("etag-a");
    });

    /**
     * 中间目录要显式建：`createBinary` 不会替你造父目录，而「云端有、本地没有」
     * 的路径完全可能落在一个本地还不存在的文件夹里（新设备上刚同步过来的
     * `images/2026/`）—— 那时它会以一个看不懂的 ENOENT 失败。
     */
    it("下载到本地不存在的目录时会建出中间目录", async () => {
        const h = createHarness();
        h.remote("images/2026/a.png", 3, "etag-a");

        const summary = await h.service.run();

        expect(summary.downloaded).toBe(1);
        expect(h.vault.has("images/2026/a.png")).toBe(true);
        expect(h.vault.folders.has("images/2026")).toBe(true);
    });

    it("下载覆盖已有文件（走 modifyBinary，不是新建）", async () => {
        const h = createHarness();
        h.vault.seed("images/a.png", { bytes: 100, mtime: 5 });
        h.remote("images/a.png", 3, "etag-new", 9_000);
        h.track("images/a.png", { size: 100, mtime: 5, etag: "etag-old" });

        await h.service.run();

        expect(h.vault.writes).toEqual(["images/a.png"]);
    });

    /**
     * **一轮同步不删任何东西。**
     *
     * 这是 2026-09-23 那次改动的核心承诺：删除退回到「用户明确要求」。
     * 本地文件、云端对象都得原封不动 —— 哪怕两边都有记录、看起来像「少了一边」。
     */
    it("**一轮同步不删本地、也不删云端**", async () => {
        const h = createHarness();
        // 这两条都「少了一边」且都有记录，在旧实现里会被删掉
        h.vault.seed("images/local-only.png", { bytes: 100, mtime: 5 });
        h.track("images/local-only.png", { size: 100, mtime: 5, etag: "etag-a" });
        h.remote("images/remote-only.png", 100, "etag-b");
        h.track("images/remote-only.png", { size: 100, mtime: 5, etag: "etag-b" });

        const summary = await h.service.run();

        expect(summary.uploaded).toBe(1);
        expect(summary.downloaded).toBe(1);
        // 本地那份还在（没被 trash）
        expect(h.vault.has("images/local-only.png")).toBe(true);
        expect(h.vault.trashed).toEqual([]);
        // 云端那份也还在（没被 DELETE）
        expect(h.r2.objects.has("images/remote-only.png")).toBe(true);
        expect(h.r2.requests.some((request) => request.method === "DELETE")).toBe(false);
    });

    it("dryRun：只计数，一个动作都不做", async () => {
        const h = createHarness();
        h.vault.seed("images/a.png", { bytes: 100, mtime: 5 });
        h.remote("images/b.png", 50, "etag-b");
        h.track("images/b.png", { size: 50, mtime: 5, etag: "etag-b" });
        // b 在本地被删了 → 计划里是「下载回来」

        const summary = await h.service.run({ dryRun: true });

        expect(summary.uploaded).toBe(1);
        expect(summary.downloaded).toBe(1);
        // 什么都没做
        expect(h.vault.writes).toEqual([]);
        expect(h.vault.has("images/b.png")).toBe(false);
        expect(h.r2.requests.every((request) => request.method === "GET")).toBe(true);
    });

    it("dryRun 不写清单（没有动作发生过）", async () => {
        const h = createHarness();
        h.vault.seed("images/a.png", { bytes: 100, mtime: 5 });

        await h.service.run({ dryRun: true });

        expect(h.saved()).toEqual({});
    });

    it("单个文件失败不中断其他动作，并逐条记进 errors", async () => {
        const h = createHarness();
        h.vault.seed("images/bad.png", { bytes: 10 });
        h.vault.seed("images/good.png", { bytes: 10 });
        h.r2.override = (request) =>
            request.method === "PUT" && request.key === "images/bad.png"
                ? { status: 400, text: '{"message":"拒绝"}' }
                : undefined;

        const summary = await h.service.run();

        expect(summary.uploaded).toBe(1);
        expect(summary.failed).toBe(1);
        expect(summary.errors).toHaveLength(1);
        expect(summary.errors[0]!.path).toBe("images/bad.png");
        // 文案由展示层按类型码拼出来（不是原始的技术描述）
        expect(summary.errors[0]!.message).toContain("images/bad.png");
        expect(h.r2.objects.has("images/good.png")).toBe(true);
    });

    it("跑完之后剪掉两边都不存在的记录（清单不能无限长）", async () => {
        const h = createHarness();
        h.vault.seed("images/a.png", { bytes: 10 });
        h.track("images/ghost.png", { size: 10, mtime: 5, etag: "e" });

        await h.service.run();

        expect(h.saved()["images/ghost.png"]).toBeUndefined();
        expect(h.saved()["images/a.png"]).toBeDefined();
    });

    it("同一时刻只能跑一轮", async () => {
        const h = createHarness();
        h.vault.seed("images/a.png", { bytes: 10 });

        const first = h.service.run();
        await expect(h.service.run()).rejects.toMatchObject({ kind: "listFailed" });
        await first;

        // 跑完之后可以再跑
        await expect(h.service.run()).resolves.toBeDefined();
    });

    it("配置不全时 run 直接抛（不发出任何请求）", async () => {
        const h = createHarness({ bucket: "" });

        await expect(h.service.run()).rejects.toMatchObject({ kind: "notConfigured" });
        expect(h.r2.requests).toEqual([]);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 七、本地删除后的云端处置（用户拍板）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 双向删除去掉之后，删除只剩这一条路：用户删掉本地一张图 → 问他一句
 * 「云端那份也删吗」→ 按他的回答调这两个方法之一。
 *
 * 这三个方法里 `hasRemoteBackup` 决定**要不要问**，另两个是**回答**。
 * 分开测是因为它们各自都会错，而错的后果完全不同：前者错是「多问/少问」，
 * 后者错是「删了不该删的」或「删了又自己回来」。
 */
describe("本地删除后的云端处置", () => {
    describe("hasRemoteBackup（决定要不要问一句）", () => {
        it("清单里记过 → true", () => {
            const h = createHarness();
            h.track("images/a.png", { size: 100, mtime: 5, etag: "etag-a" });

            expect(h.service.hasRemoteBackup("images/a.png")).toBe(true);
        });

        it("清单里没记过 → false（云端本来就没有这一份）", () => {
            expect(createHarness().service.hasRemoteBackup("images/a.png")).toBe(false);
        });

        it("**不发网络请求** —— 删一张图要立刻决定问不问", () => {
            const h = createHarness();
            h.track("images/a.png", { size: 100, mtime: 5, etag: "etag-a" });

            h.service.hasRemoteBackup("images/a.png");

            expect(h.r2.requests).toEqual([]);
        });

        it("墓碑也算「有备份」（那一份确实还在云端）", () => {
            const h = createHarness();
            h.track("images/a.png", { size: 100, mtime: 5, etag: "etag-a" });
            h.service.markLocalDeleted("images/a.png");

            expect(h.service.hasRemoteBackup("images/a.png")).toBe(true);
        });
    });

    describe("deleteRemoteBackup（用户选了「也删云端」）", () => {
        it("真的发出 DELETE，并忘掉那条记录", async () => {
            const h = createHarness();
            h.remote("images/a.png", 100, "etag-a");
            h.track("images/a.png", { size: 100, mtime: 5, etag: "etag-a" });

            await expect(h.service.deleteRemoteBackup("images/a.png")).resolves.toBe(true);

            expect(h.r2.objects.has("images/a.png")).toBe(false);
            expect(h.saved()["images/a.png"]).toBeUndefined();
            // 忘掉记录之后就不会再为同一个路径白问一次
            expect(h.service.hasRemoteBackup("images/a.png")).toBe(false);
        });

        it("对象本来就不在（404）也算成功 —— S3 的 DELETE 不保证幂等可见", async () => {
            const h = createHarness();
            h.track("images/a.png", { size: 100, mtime: 5, etag: "etag-a" });
            // 云端没有这个对象 → 假服务端回 404

            await expect(h.service.deleteRemoteBackup("images/a.png")).resolves.toBe(true);
        });

        /**
         * **越界保护。**
         *
         * 用户可能手改 data.json 把文件夹改小，而待确认的那批路径是删除发生时
         * 攒下的。没有这一条，一次「改设置 + 删文件」的时序就能删到范围外的对象。
         */
        it("受管文件夹之外一律不发（越界保护）", async () => {
            const h = createHarness({ folders: ["images"] });

            await expect(h.service.deleteRemoteBackup("templates/a.png")).resolves.toBe(false);
            expect(h.r2.requests).toEqual([]);
        });

        it("配置不全时返回 false，且不发请求", async () => {
            const h = createHarness({ bucket: "" });

            await expect(h.service.deleteRemoteBackup("images/a.png")).resolves.toBe(false);
            expect(h.r2.requests).toEqual([]);
        });

        it("失败时报一次错并返回 false（**不抛** —— 它挂在一次用户交互后面）", async () => {
            const h = createHarness();
            h.track("images/a.png", { size: 100, mtime: 5, etag: "etag-a" });
            h.r2.override = () => ({ status: 403 });

            const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
            try {
                await expect(h.service.deleteRemoteBackup("images/a.png")).resolves.toBe(false);
                expect(logged).toHaveBeenCalled();
            } finally {
                logged.mockRestore();
            }

            // 失败时**不能**忘掉记录 —— 云端那一份还在
            expect(h.service.hasRemoteBackup("images/a.png")).toBe(true);
        });
    });

    describe("markLocalDeleted（本地已删除、云端保留的墓碑）", () => {
        it("记一条墓碑", () => {
            const h = createHarness();
            h.track("images/a.png", { size: 100, mtime: 5, etag: "etag-a" });

            h.service.markLocalDeleted("images/a.png");

            expect(h.saved()["images/a.png"]).toMatchObject({ remoteOnly: true });
        });

        /**
         * **这是墓碑存在的全部理由。**
         *
         * 没有它，「云端有、本地没有」只剩一种解释 —— 补齐到本地，于是用户
         * 删掉的图下一轮就自己回来了，看起来像「删除没生效」。
         */
        it("下一轮同步**不会**把它下载回来", async () => {
            const h = createHarness();
            h.remote("images/a.png", 100, "etag-a");
            h.track("images/a.png", { size: 100, mtime: 5, etag: "etag-a" });
            h.service.markLocalDeleted("images/a.png");

            const plan = await h.service.plan();
            expect(plan.entries).toEqual([
                { path: "images/a.png", action: "skip", reason: "local-deleted", size: 100 },
            ]);

            const summary = await h.service.run();
            expect(summary.downloaded).toBe(0);
            expect(h.vault.has("images/a.png")).toBe(false);
            // 云端那一份留着
            expect(h.r2.objects.has("images/a.png")).toBe(true);
        });

        it("墓碑不是一次性的：反复跑都不会把它拿回来", async () => {
            const h = createHarness();
            h.remote("images/a.png", 100, "etag-a");
            h.track("images/a.png", { size: 100, mtime: 5, etag: "etag-a" });
            h.service.markLocalDeleted("images/a.png");

            await h.service.run();
            await h.service.run();
            await h.service.run();

            expect(h.vault.has("images/a.png")).toBe(false);
            expect(h.saved()["images/a.png"]!.remoteOnly).toBe(true);
        });

        it("清单里本来就没有这条时什么都不做（云端本来就没有备份）", () => {
            const h = createHarness();

            h.service.markLocalDeleted("images/a.png");

            // 凭空造一条记录只会让清单里多出无意义的一行
            expect(h.saved()["images/a.png"]).toBeUndefined();
        });

        it("云端那份后来也没了 → 整条记录被剪掉（墓碑一起消失）", async () => {
            const h = createHarness();
            h.remote("images/a.png", 100, "etag-a");
            h.track("images/a.png", { size: 100, mtime: 5, etag: "etag-a" });
            h.service.markLocalDeleted("images/a.png");

            // 别处把云端那份删了
            h.r2.objects.clear();
            await h.service.run();

            expect(h.saved()["images/a.png"]).toBeUndefined();
        });

        /**
         * 文件重新出现在本地时墓碑要清掉。
         *
         * 场景：用户从回收站恢复了那张图（或者别的设备同步过来一份）。
         * 墓碑留着不会让 `decide` 出错（两边都在时它根本不看墓碑），
         * 但清单里的状态会与事实不符，下一个读它的人得重新推一遍。
         */
        it("文件重新出现在本地时，墓碑被清掉", async () => {
            const h = createHarness();
            h.remote("images/a.png", 100, "etag-a");
            h.track("images/a.png", { size: 100, mtime: 5, etag: "etag-a" });
            h.service.markLocalDeleted("images/a.png");

            // 用户从回收站恢复了（大小 / mtime 与上次一致）
            h.vault.seed("images/a.png", { bytes: 100, mtime: 5 });
            await h.service.run();

            expect(h.saved()["images/a.png"]!.remoteOnly).toBeUndefined();
        });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 八、配置校验
// ─────────────────────────────────────────────────────────────────────────────

describe("configProblem", () => {
    it("齐全时没有问题", () => {
        expect(createHarness().service.configProblem()).toBeUndefined();
        expect(createHarness().service.isConfigured()).toBe(true);
    });

    it("缺项时把**缺了什么**说出来", () => {
        const problem = createHarness({ bucket: "", accessKeyId: "" }).service.configProblem();

        expect(problem).toMatchObject({ kind: "notConfigured" });
        expect((problem as { params: { missing: string } }).params.missing).toContain("bucket");
        expect((problem as { params: { missing: string } }).params.missing).toContain(
            "accessKeyId"
        );
    });

    it("只有空白字符的配置算没填", () => {
        expect(createHarness({ accountId: "   " }).service.configProblem()).toMatchObject({
            kind: "notConfigured",
        });
    });

    it("密钥为空时算没填（它存在 SecretStore 里，不在设置里）", () => {
        const vault = createFakeImageVault();
        const service = new ImageSyncService({
            app: vault.app,
            notifier: new Notifier({ getShowNotices: () => false, getT: () => zhCN }),
            getT: () => zhCN,
            getSettings: () => normalizeSettings({ images: BASE }),
            // 存储里没有 r2 的密钥
            secretStore: new SecretStore({
                loadLocalStorage: () => null,
            } as unknown as App),
        });

        expect(service.configProblem()).toMatchObject({ kind: "notConfigured" });
    });

    it("没有图片文件夹时报 noFolders（与「配置不全」分开，用户要做的事不同）", () => {
        expect(createHarness({ folders: [] }).service.configProblem()).toMatchObject({
            kind: "noFolders",
        });
    });
});

describe("publicUrlFor", () => {
    it("没配公网地址时返回 undefined（**不猜**，猜出来的只会 403）", () => {
        expect(createHarness().service.publicUrlFor("images/a.png")).toBeUndefined();
    });

    it("配了就拼出可外链的地址", () => {
        const h = createHarness({ publicBaseUrl: "https://img.example.com" });

        expect(h.service.publicUrlFor("images/a.png")).toBe(
            "https://img.example.com/images/a.png"
        );
    });

    it("末尾斜杠不会造出双斜杠", () => {
        const h = createHarness({ publicBaseUrl: "https://img.example.com/" });

        expect(h.service.publicUrlFor("images/a.png")).toBe(
            "https://img.example.com/images/a.png"
        );
    });

    it("路径里的空格与中文被编码（粘进笔记里要能直接点开）", () => {
        const h = createHarness({ publicBaseUrl: "https://img.example.com" });

        expect(h.service.publicUrlFor("images/我的 图.png")).toBe(
            "https://img.example.com/images/%E6%88%91%E7%9A%84%20%E5%9B%BE.png"
        );
    });

    it("配置不全时返回 undefined（拿不到 key 的前缀）", () => {
        const h = createHarness({ publicBaseUrl: "https://img.example.com", bucket: "" });

        expect(h.service.publicUrlFor("images/a.png")).toBeUndefined();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 八、syncPath（裁剪 / 压缩保存之后的单文件上传）
// ─────────────────────────────────────────────────────────────────────────────

describe("syncPath", () => {
    it("上传单个文件并记进清单", async () => {
        const h = createHarness();
        h.vault.seed("images/a.png", { bytes: 100, mtime: 7 });

        await expect(h.service.syncPath("images/a.png")).resolves.toBe(true);
        expect(h.r2.objects.get("images/a.png")!.size).toBe(100);
        expect(h.saved()["images/a.png"]).toMatchObject({ size: 100, mtime: 7 });
    });

    /**
     * **失败不抛错。**
     *
     * 它挂在「保存图片」这个动作后面，是一个附带的优化 —— 因为云端不可达
     * 而让用户存不下图，是本末倒置。失败只记日志，下一轮完整同步会补上。
     */
    it("上传失败时返回 false 而不抛错，并且**留下日志**（不能安静地失败）", async () => {
        const h = createHarness();
        h.vault.seed("images/a.png", { bytes: 100 });
        h.r2.override = () => ({ status: 400, text: "nope" });

        const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
        try {
            await expect(h.service.syncPath("images/a.png")).resolves.toBe(false);
            // 「返回 false」只有调用方知道；日志是排查时唯一留下的痕迹。
            expect(logged).toHaveBeenCalled();
        } finally {
            logged.mockRestore();
        }
    });

    it("配置不全时返回 false（不发请求）", async () => {
        const h = createHarness({ bucket: "" });
        h.vault.seed("images/a.png", { bytes: 100 });

        await expect(h.service.syncPath("images/a.png")).resolves.toBe(false);
        expect(h.r2.requests).toEqual([]);
    });

    it("路径不在受管文件夹里时返回 false（**不能把范围外的文件传上去**）", async () => {
        const h = createHarness();
        h.vault.seed("templates/a.png", { bytes: 100 });

        await expect(h.service.syncPath("templates/a.png")).resolves.toBe(false);
        expect(h.r2.requests).toEqual([]);
    });

    it("文件不存在时返回 false", async () => {
        const h = createHarness();

        await expect(h.service.syncPath("images/ghost.png")).resolves.toBe(false);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 九、纯函数
// ─────────────────────────────────────────────────────────────────────────────

describe("contentTypeFor", () => {
    it("按扩展名给 MIME（云端取回来时浏览器才知道怎么显示）", () => {
        expect(contentTypeFor("images/a.png")).toBe("image/png");
        expect(contentTypeFor("images/a.jpg")).toBe("image/jpeg");
        expect(contentTypeFor("images/a.JPEG")).toBe("image/jpeg");
        expect(contentTypeFor("images/a.webp")).toBe("image/webp");
        expect(contentTypeFor("images/a.avif")).toBe("image/avif");
        expect(contentTypeFor("images/a.svg")).toBe("image/svg+xml");
        expect(contentTypeFor("images/a.gif")).toBe("image/gif");
        expect(contentTypeFor("images/a.heic")).toBe("image/heic");
        expect(contentTypeFor("images/a.tiff")).toBe("image/tiff");
    });

    it("认不出时给 application/octet-stream（而不是猜一个 image/*）", () => {
        expect(contentTypeFor("images/a.bin")).toBe("application/octet-stream");
        expect(contentTypeFor("images/README")).toBe("application/octet-stream");
    });
});

describe("pathFromKey", () => {
    it("剥掉前缀", () => {
        expect(pathFromKey("images/a.png", "images/")).toBe("a.png");
    });

    it("前缀为空时原样返回", () => {
        expect(pathFromKey("a.png", "")).toBe("a.png");
    });

    /**
     * 前缀之外的对象返回 undefined —— 那些是**别人的东西**。
     * 当成自己的会导致「云端新增 → 下载到库里」这种莫名其妙的副作用。
     */
    it("前缀之外返回 undefined", () => {
        expect(pathFromKey("other/a.png", "images/")).toBeUndefined();
    });

    it("键就是前缀本身时返回 undefined（它不是一个文件）", () => {
        expect(pathFromKey("images/", "images/")).toBeUndefined();
    });

    it("前缀是别的键的一段时也算不上（要整段匹配）", () => {
        // `images/` 不该匹配 `images-old/a.png`
        expect(pathFromKey("images-old/a.png", "images/")).toBeUndefined();
    });
});

describe("onFinished", () => {
    it("跑完一轮后回调（状态栏 / 设置页据此重绘）", async () => {
        const vault = createFakeImageVault();
        const r2 = createFakeR2();
        r2.install();
        installed.push(r2);

        const summaries: SyncSummary[] = [];
        const service = new ImageSyncService({
            app: vault.app,
            notifier: new Notifier({ getShowNotices: () => false, getT: () => zhCN }),
            getT: () => zhCN,
            getSettings: () => normalizeSettings({ images: BASE }),
            secretStore: new SecretStore({
                loadLocalStorage: () => "secret-key",
            } as unknown as App),
            onFinished: (summary) => summaries.push(summary),
        });

        vault.seed("images/a.png", { bytes: 10 });
        await service.run();

        expect(summaries).toHaveLength(1);
        expect(summaries[0]!.uploaded).toBe(1);
    });

    it("dryRun 时不回调（没有一轮跑完）", async () => {
        const vault = createFakeImageVault();
        const r2 = createFakeR2();
        r2.install();
        installed.push(r2);

        let calls = 0;
        const service = new ImageSyncService({
            app: vault.app,
            notifier: new Notifier({ getShowNotices: () => false, getT: () => zhCN }),
            getT: () => zhCN,
            getSettings: () => normalizeSettings({ images: BASE }),
            secretStore: new SecretStore({
                loadLocalStorage: () => "secret-key",
            } as unknown as App),
            onFinished: () => {
                calls += 1;
            },
        });

        vault.seed("images/a.png", { bytes: 10 });
        await service.run({ dryRun: true });

        expect(calls).toBe(0);
    });
});
