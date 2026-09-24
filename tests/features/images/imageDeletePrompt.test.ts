import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App, TAbstractFile } from "obsidian";
import { createdSettings, Notice, resetCreatedSettings, TFolder } from "../../stubs/obsidian";
import { Notifier } from "../../../src/core/notice";
import { zhCN } from "../../../src/core/i18n/locales/zh-cn";
import { normalizeSettings, type ImageSyncSettings } from "../../../src/core/settings";
import { SecretStore } from "../../../src/core/secretStore";
import { createImageSyncModule, type ImageSyncModule } from "../../../src/features/images";
import { createFakeImageVault, type FakeImageVault } from "../../helpers/fakeImageVault";
import { createFakeR2, type FakeR2 } from "../../helpers/fakeR2";

/**
 * 「删掉一张本地图片 → 问一句要不要连云端一起删」这条链路。
 *
 * ## 这个文件守的是什么
 *
 * 删除退回到「用户拍板」之后，`noteDeleted` 成了**删除的唯一入口** ——
 * 它身上挂着一串守卫（是文件吗 / 是图片吗 / 在受管文件夹里吗 / 云端有备份吗 /
 * 总开关开着吗 / 删除策略不是「永不同步云端」吗），每一个都对应一类**不该弹的窗**：
 *
 * - 少一个 `instanceof TFile`：删文件夹也会弹，而一个叫 `images.png` 的文件夹
 *   会被扩展名判断认成图片；
 * - 少一个 `hasRemoteBackup`：删掉一张从没同步过的截图也会弹 —— 而那是绝大多数；
 * - 少一个 `isInsideFolders`：范围外的文件也会被问「云端那份也删吗」。
 *
 * 另一条主线是**攒批**：一次删十张图弹十次是灾难。
 *
 * 第三条主线是删除策略的三档（`deleteRemotePolicy`）：`ask` 弹窗、
 * `always` 直接删、`never` 装没看见 —— 三档各自的行为都要钉住。
 */

const STATE_KEY = "obsync-image-state";

const BASE: Partial<ImageSyncSettings> = {
    folders: ["images"],
    accountId: "abc123",
    bucket: "notes",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    prefix: "",
};

/** 攒批窗口是 400ms（见 features/images/index.ts）。推得远一点无所谓。 */
const DEBOUNCE_MS = 1_000;

interface Harness {
    vault: FakeImageVault;
    r2: FakeR2;
    module: ImageSyncModule;
    /** 改设置（下一次 noteDeleted 生效）。 */
    configure(next: Partial<ImageSyncSettings>): void;
    /** 记一条「上次同步时两边一致」。 */
    track(path: string): void;
    /** 触发攒批窗口，让询问弹出来。 */
    flush(): Promise<void>;
    /** 弹窗里的两个按钮（没弹窗时抛错 —— 那说明测试的假设不成立）。 */
    buttons(): Array<{ text: string; click: () => unknown }>;
    /**
     * 已经弹过几次窗。
     *
     * 数的是 `Setting` 的个数：图片模块本身不创建任何 `Setting`，
     * 所以「有几个 Setting」就等于「弹了几次窗」。
     */
    promptCount(): number;
}

const installed: FakeR2[] = [];

function createHarness(overrides: Partial<ImageSyncSettings> = {}): Harness {
    const vault = createFakeImageVault();
    const r2 = createFakeR2();
    r2.install();
    installed.push(r2);

    let images: Partial<ImageSyncSettings> = { ...BASE, ...overrides };

    const notifier = new Notifier({
        // 开着提示：这些用例要断言「用户看到了什么」。
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

        async flush(): Promise<void> {
            await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
        },

        buttons() {
            const setting = createdSettings[createdSettings.length - 1];
            if (!setting) throw new Error("没有弹出确认窗");
            return setting.buttons as never;
        },

        promptCount(): number {
            return createdSettings.length;
        },
    };
}

/**
 * 一个**已经被删掉**的文件。
 *
 * `seed` 只是为了拿到一个有真实 `stat` 的 `TFile`（事件参数需要它），
 * 而 `remove` 才是关键：Obsidian 的 `vault.on("delete")` 是在文件**已经消失
 * 之后**才触发的。忘了这一步，被测代码看到的就还是「文件还在」——
 * 于是「删掉本地图 → 问要不要删云端」这条路径根本走不到。
 *
 * 返回类型写成 `TAbstractFile`：`noteDeleted` 的签名是真的 Obsidian 类型，
 * 而它要求一个替身没有的 `vault` 字段（真实 API 上那个字段指向所属的 Vault，
 * 我们从不读它）。这里补一个类型断言，而不是去改替身 —— 替身不该声称
 * 自己有一个行为不对的 `vault`。
 */
function deletedFile(vault: FakeImageVault, path: string): TAbstractFile {
    const file = vault.seed(path, { bytes: 10, mtime: 5 });
    vault.remove(path);
    return file as unknown as TAbstractFile;
}

/** 同上：文件夹的替身也缺 `vault` 字段。 */
function asAbstractFile(file: TFolder): TAbstractFile {
    return file as unknown as TAbstractFile;
}

beforeEach(() => {
    vi.useFakeTimers();
    resetCreatedSettings();
    Notice.instances.length = 0;
});

afterEach(() => {
    vi.useRealTimers();
    for (const r2 of installed.splice(0)) r2.restore();
});

describe("noteDeleted：什么时候该问", () => {
    it("受管文件夹里的图片、云端有备份 → 问一句", async () => {
        const h = createHarness();
        h.track("images/a.png");
        h.r2.objects.set("images/a.png", { size: 10, etag: "e", lastModified: 1 });

        h.module.noteDeleted(deletedFile(h.vault, "images/a.png"));
        await h.flush();

        expect(h.promptCount()).toBe(1);
        expect(h.buttons().map((button) => button.text)).toEqual([
            zhCN.images.deleteRemote.keep,
            zhCN.images.deleteRemote.delete,
        ]);
    });

    it("**云端没有备份** → 不问（绝大多数删除都是这一种）", async () => {
        const h = createHarness();
        // 清单里没有 → 说明这张图从没同步过（截图、临时图）
        h.module.noteDeleted(deletedFile(h.vault, "images/a.png"));
        await h.flush();

        expect(h.promptCount()).toBe(0);
    });

    it("不在受管文件夹里 → 不问", async () => {
        const h = createHarness();
        h.track("templates/a.png");

        h.module.noteDeleted(deletedFile(h.vault, "templates/a.png"));
        await h.flush();

        expect(h.promptCount()).toBe(0);
    });

    it("不是图片（.md）→ 不问", async () => {
        const h = createHarness();
        h.track("images/note.md");

        h.module.noteDeleted(deletedFile(h.vault, "images/note.md"));
        await h.flush();

        expect(h.promptCount()).toBe(0);
    });

    /**
     * 删文件夹也会触发 `vault.on("delete")`，而 `isImagePath` 只看扩展名 ——
     * 一个叫 `images.png` 的**文件夹**会被它认成图片。少了 `instanceof TFile`
     * 这一条，删一个这种名字的文件夹就会问「云端那份也删吗」。
     */
    it("文件夹 → 不问（哪怕它的名字像个图片）", async () => {
        const h = createHarness();
        h.track("images.png");

        h.module.noteDeleted(asAbstractFile(new TFolder("images.png")));
        await h.flush();

        expect(h.promptCount()).toBe(0);
    });

    it("删除策略是「永不同步云端」→ 不问", async () => {
        const h = createHarness({ deleteRemotePolicy: "never" });
        h.track("images/a.png");
        h.r2.objects.set("images/a.png", { size: 10, etag: "e", lastModified: 1 });

        h.module.noteDeleted(deletedFile(h.vault, "images/a.png"));
        await h.flush();

        expect(h.promptCount()).toBe(0);
        // 云端那份原地不动 —— 选这一档的人要的就是这个
        expect(h.r2.objects.size).toBe(1);
    });

    it("总开关关掉 → 连问都不问（用户说了「别在背后动我的图片」）", async () => {
        const h = createHarness({ enabled: false });
        h.track("images/a.png");

        h.module.noteDeleted(deletedFile(h.vault, "images/a.png"));
        await h.flush();

        expect(h.promptCount()).toBe(0);
    });

    it("配置不全 → 不问（删不掉，问了也白问）", async () => {
        const h = createHarness({ bucket: "" });
        h.track("images/a.png");

        h.module.noteDeleted(deletedFile(h.vault, "images/a.png"));
        await h.flush();

        expect(h.promptCount()).toBe(0);
    });

    it("一个图片文件夹都没配 → 不问（边界是空的，什么都不管）", async () => {
        const h = createHarness({ folders: [] });
        h.track("images/a.png");

        h.module.noteDeleted(deletedFile(h.vault, "images/a.png"));
        await h.flush();

        expect(h.promptCount()).toBe(0);
    });
});

/**
 * 删除策略的第二档：`always`（「永远同步云端」）。
 *
 * 用户已经表过态了（在设置页选了这一档），所以**一次都不该问** —— 但行为要与
 * 弹窗里选「删除云端」完全一致：墓碑先记（挡住竞态）、再发 DELETE、失败要出声。
 */
describe("删除策略是「永远同步云端」", () => {
    it("不问，直接删掉云端那一份", async () => {
        const h = createHarness({ deleteRemotePolicy: "always" });
        h.track("images/a.png");
        h.r2.objects.set("images/a.png", { size: 10, etag: "e", lastModified: 1 });

        h.module.noteDeleted(deletedFile(h.vault, "images/a.png"));
        // 删除是异步的（fire-and-forget），推一轮微任务让它跑完
        await vi.advanceTimersByTimeAsync(0);

        expect(h.promptCount()).toBe(0);
        expect(h.r2.objects.size).toBe(0);
        // 记录也清掉了 —— 否则下次删同名文件时 `hasRemoteBackup` 还说「有备份」
        expect(h.module.service.hasRemoteBackup("images/a.png")).toBe(false);
    });

    it("删完之后再跑一轮同步，不会把它传回云端", async () => {
        const h = createHarness({ deleteRemotePolicy: "always" });
        h.track("images/a.png");
        h.r2.objects.set("images/a.png", { size: 10, etag: "e", lastModified: 1 });

        h.module.noteDeleted(deletedFile(h.vault, "images/a.png"));
        await vi.advanceTimersByTimeAsync(0);

        // 本地没有、云端也没有 → 两边都不存在，什么都不做
        const summary = await h.module.service.run();
        expect(summary.uploaded).toBe(0);
        expect(summary.downloaded).toBe(0);
        expect(h.r2.objects.size).toBe(0);
    });

    /**
     * 失败时**必须出声**，且墓碑要留着。
     *
     * 墓碑先记再删（见 `noteDeleted`）：DELETE 失败时云端那一份还在，而本地已经
     * 没有了 —— 正是墓碑描述的处境。清掉它反而会让下一轮同步把图下载回来，
     * 而用户明明选了「连云端一起删」。
     */
    it("云端删除失败时出声，且下一轮不会把它下载回来", async () => {
        const h = createHarness({ deleteRemotePolicy: "always" });
        h.track("images/a.png");
        h.r2.objects.set("images/a.png", { size: 10, etag: "e", lastModified: 1 });
        // 删除是 fire-and-forget，override 要在事件之前就位。
        // 400 而不是 403：403 在 `deleteObject` 里被归成「凭据不对」（authFailed），
        // 走不到 deleteFailed 那条翻译。
        h.r2.override = () => ({ status: 400 });

        const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
        try {
            h.module.noteDeleted(deletedFile(h.vault, "images/a.png"));
            await vi.advanceTimersByTimeAsync(0);
        } finally {
            logged.mockRestore();
        }

        // 用户看得到失败（错误提示**不受**「显示提示」设置控制）
        const messages = Notice.instances
            .map((notice) => notice.message)
            .filter((message): message is string => typeof message === "string");
        expect(
            messages.some((message) => message.startsWith(`删除云端的 images/a.png 失败（HTTP 400）`))
        ).toBe(true);

        // 云端那份还在，且墓碑拦着，下一轮同步不会把它拿回本地
        expect(h.r2.objects.size).toBe(1);
        // 撤掉 override：下一轮同步自己要发 LIST，别让它也跟着 400
        h.r2.override = undefined;
        const summary = await h.module.service.run();
        expect(summary.downloaded).toBe(0);
        expect(h.vault.has("images/a.png")).toBe(false);
    });
});

describe("noteDeleted：攒批", () => {
    /**
     * 一次选中三张图删掉时，Obsidian 会为每一张各发一个 `delete` 事件 ——
     * 逐个弹窗是灾难（要连点三次，而它们问的是同一件事）。
     */
    it("连着删三张只弹**一个**窗，三张都在列表里", async () => {
        const h = createHarness();
        for (const name of ["a", "b", "c"]) {
            h.track(`images/${name}.png`);
            h.module.noteDeleted(deletedFile(h.vault, `images/${name}.png`));
        }
        await h.flush();

        expect(h.promptCount()).toBe(1);

        // 三条路径都在弹窗里（按路径排序，界面上的顺序才稳定）
        const content = (createdSettings[0] as unknown as { containerEl: unknown }).containerEl;
        const texts: string[] = [];
        const walk = (node: unknown): void => {
            const el = node as { text?: string; children?: unknown[] };
            if (el.text) texts.push(el.text);
            for (const child of el.children ?? []) walk(child);
        };
        walk(content);
        expect(texts).toContain("images/a.png");
        expect(texts).toContain("images/b.png");
        expect(texts).toContain("images/c.png");
    });

    it("同一张图被报两次只问一次（用 Set 去重）", async () => {
        const h = createHarness();
        h.track("images/a.png");

        h.module.noteDeleted(deletedFile(h.vault, "images/a.png"));
        h.module.noteDeleted(deletedFile(h.vault, "images/a.png"));
        await h.flush();

        expect(h.promptCount()).toBe(1);
    });

    it("只把有云端备份的那几张攒进来", async () => {
        const h = createHarness();
        h.track("images/has-backup.png");
        // 这一张没有记录
        h.module.noteDeleted(deletedFile(h.vault, "images/has-backup.png"));
        h.module.noteDeleted(deletedFile(h.vault, "images/no-backup.png"));
        await h.flush();

        expect(h.promptCount()).toBe(1);
    });

    it("卸载（stop）之后待问的那批被丢掉 —— 插件都没了，不该再弹窗", async () => {
        const h = createHarness();
        h.track("images/a.png");

        h.module.noteDeleted(deletedFile(h.vault, "images/a.png"));
        h.module.stop();
        await h.flush();

        expect(h.promptCount()).toBe(0);
    });
});

describe("回答「保留云端备份」", () => {
    it("三条都立墓碑，且**下一轮同步不会把它们下载回来**", async () => {
        const h = createHarness();
        for (const name of ["a", "b"]) {
            h.track(`images/${name}.png`);
            h.r2.objects.set(`images/${name}.png`, { size: 10, etag: "e", lastModified: 1 });
            h.module.noteDeleted(deletedFile(h.vault, `images/${name}.png`));
        }
        await h.flush();

        h.buttons()[0]!.click();
        await vi.advanceTimersByTimeAsync(0);

        // 云端两份都还在
        expect(h.r2.objects.size).toBe(2);

        // 再跑一轮同步：一张都不该被下载回来
        const summary = await h.module.service.run();
        expect(summary.downloaded).toBe(0);
        expect(h.vault.has("images/a.png")).toBe(false);
        expect(h.vault.has("images/b.png")).toBe(false);

        // 用户看得到「已经保留了」
        expect(Notice.instances.map((notice) => notice.message)).toContain(
            zhCN.images.notice.remoteKept(2)
        );
    });

    it("没点按钮直接关窗也走这一条路（不留「删了又回来」的坑）", async () => {
        const h = createHarness();
        h.track("images/a.png");
        h.r2.objects.set("images/a.png", { size: 10, etag: "e", lastModified: 1 });

        h.module.noteDeleted(deletedFile(h.vault, "images/a.png"));
        await h.flush();
        expect(h.promptCount()).toBe(1);

        // 「不表态也有墓碑」这条语义由弹窗自己的用例钉着
        // （`confirmDeleteRemote.test.ts` 里「没点按钮就关掉」那条）——
        // 这里验的是模块侧接上它之后的结果：下一轮不会把文件拿回来。
        h.module.service.markLocalDeleted("images/a.png");
        await vi.advanceTimersByTimeAsync(0);

        const summary = await h.module.service.run();
        expect(summary.downloaded).toBe(0);
        expect(h.vault.has("images/a.png")).toBe(false);
    });
});

describe("回答「同时删除云端备份」", () => {
    it("云端对象真的被删掉，清单里的记录也清掉", async () => {
        const h = createHarness();
        for (const name of ["a", "b"]) {
            h.track(`images/${name}.png`);
            h.r2.objects.set(`images/${name}.png`, { size: 10, etag: "e", lastModified: 1 });
            h.module.noteDeleted(deletedFile(h.vault, `images/${name}.png`));
        }
        await h.flush();

        h.buttons()[1]!.click();
        // 删除是异步的（逐个 await），推一轮微任务让它跑完
        await vi.advanceTimersByTimeAsync(0);

        expect(h.r2.objects.size).toBe(0);
        expect(h.module.service.hasRemoteBackup("images/a.png")).toBe(false);
        expect(h.module.service.hasRemoteBackup("images/b.png")).toBe(false);

        expect(Notice.instances.map((notice) => notice.message)).toContain(
            zhCN.images.notice.remoteDeleted(2)
        );
    });

    it("删完之后再跑一轮同步，不会把它们重新传上去", async () => {
        const h = createHarness();
        h.track("images/a.png");
        h.r2.objects.set("images/a.png", { size: 10, etag: "e", lastModified: 1 });

        h.module.noteDeleted(deletedFile(h.vault, "images/a.png"));
        await h.flush();
        h.buttons()[1]!.click();
        await vi.advanceTimersByTimeAsync(0);

        // 本地没有、云端也没有 → 两边都不存在，什么都不做
        const summary = await h.module.service.run();
        expect(summary.uploaded).toBe(0);
        expect(summary.downloaded).toBe(0);
        expect(h.r2.objects.size).toBe(0);
    });

    /**
     * 失败时**必须出声**。
     *
     * 逐条失败会各自报一次错（原因不同），但「配置在弹窗期间被改掉」这类
     * 没走报错分支的失败会一声不响 —— 用户以为删完了，而云端那一份还在。
     */
    it("失败时给出总数提示，且云端那份确实还在", async () => {
        const h = createHarness();
        h.track("images/a.png");
        h.r2.objects.set("images/a.png", { size: 10, etag: "e", lastModified: 1 });

        h.module.noteDeleted(deletedFile(h.vault, "images/a.png"));
        await h.flush();

        h.r2.override = () => ({ status: 403 });
        const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
        try {
            h.buttons()[1]!.click();
            await vi.advanceTimersByTimeAsync(0);
        } finally {
            logged.mockRestore();
        }

        const messages = Notice.instances.map((notice) => notice.message);
        expect(messages).toContain(zhCN.images.notice.deleteBackupFailedMany(1));
        expect(messages).not.toContain(zhCN.images.notice.remoteDeleted(1));
        // 云端那份还在（失败时不能忘掉记录，也不能假装删掉了）
        expect(h.r2.objects.size).toBe(1);
        expect(h.module.service.hasRemoteBackup("images/a.png")).toBe(true);
    });
});
