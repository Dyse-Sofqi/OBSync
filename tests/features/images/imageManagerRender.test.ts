import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App, WorkspaceLeaf } from "obsidian";
import { createdSettings, Notice, resetCreatedSettings } from "../../stubs/obsidian";
import { Notifier } from "../../../src/core/notice";
import { zhCN } from "../../../src/core/i18n/locales/zh-cn";
import { normalizeSettings, type ImageSyncSettings } from "../../../src/core/settings";
import { SecretStore } from "../../../src/core/secretStore";
import { createImageSyncModule, type ImageSyncModule } from "../../../src/features/images";
import { IMAGE_VIEW_TYPE, ImageManagerView } from "../../../src/features/images/ui/ImageManagerView";
import { BatchRenameModal } from "../../../src/features/images/ui/BatchRenameModal";
import { ConfirmBatchDeleteModal } from "../../../src/features/images/ui/ConfirmBatchDeleteModal";
import { createFakeImageVault, type FakeImageVault } from "../../helpers/fakeImageVault";
import { createFakeR2, type FakeR2 } from "../../helpers/fakeR2";

/**
 * 图片管理标签页的**渲染冒烟**。
 *
 * ## 为什么值得单独写（这一页没有任何别的测试）
 *
 * 面板是整个图片功能里唯一「代码量最大、又完全不进单测」的部分：它碰 DOM、
 * 依赖 Obsidian 的组件，而测试环境只有一套手写的最小 DOM 垫片
 * （`tests/setup.ts`，`addEventListener` 是空实现 —— 所以这里**测不了点击**，
 * 只能测「画出来什么」）。
 *
 * 但「画出来什么」恰恰是最容易出问题的地方：`pluginBoot.test.ts` 的教训是
 * **渲染路径里的 TypeError 只有真机才会暴露**，而这一页有十几个 `createEl` /
 * 状态徽标分支，光靠类型检查挡不住（`element.ts` 上的属性写错名字，TS 也认）。
 *
 * 所以这里钉住三件事：**异步扫描完成后列表真的被重画了**（不是一直停在
 * 「正在扫描…」）、**三个状态的徽标按组合出现**、**云端出问题时顶部有警告**。
 *
 * 2026-09-23：它从 `Modal` 变成了 `ItemView`（主工作区标签页）。替身的
 * `ItemView` 不会自己调 `onOpen`（真实 Obsidian 会），所以这里手动调一次。
 */

const BASE: Partial<ImageSyncSettings> = {
    folders: ["images"],
    accountId: "abc123",
    bucket: "notes",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    prefix: "",
};

/** 垫片里的元素形状（见 `tests/setup.ts`）。 */
interface ShimElement {
    tagName?: string;
    text?: string;
    cls?: string;
    attrs?: Record<string, string>;
    children?: ShimElement[];
}

const installed: FakeR2[] = [];

interface Harness {
    vault: FakeImageVault;
    r2: FakeR2;
    module: ImageSyncModule;
    /** 打开标签页（`onOpen` 里会异步扫一遍，调用方自己等）。 */
    open(): ImageManagerView;
}

function createHarness(overrides: Partial<ImageSyncSettings> = {}): Harness {
    const vault = createFakeImageVault();
    const r2 = createFakeR2();
    r2.install();
    installed.push(r2);

    const images = { ...BASE, ...overrides };
    const notifier = new Notifier({ getShowNotices: () => true, getT: () => zhCN });

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
        open(): ImageManagerView {
            const view = new ImageManagerView(null as unknown as WorkspaceLeaf, {
                app: vault.app,
                getT: () => zhCN,
                notifier,
                service: module.service,
                deleteImages: (paths, options) => module.deleteImages(paths, options),
            });
            // 替身的 ItemView 不像 Modal 那样 open() 就触发 onOpen ——
            // 真实 Obsidian 在叶子挂上视图时调它，这里手动补上。
            void view.onOpen();
            return view;
        },
    };
}

/** 递归收集一棵垫片子树里的所有文本。 */
function textsOf(element: ShimElement): string[] {
    const out: string[] = [];
    const visit = (node: ShimElement | undefined): void => {
        if (!node) return;
        if (typeof node.text === "string" && node.text) out.push(node.text);
        for (const child of node.children ?? []) visit(child);
    };
    visit(element);
    return out;
}

/** 所有带某个类名的元素（含自身）。 */
function withClass(element: ShimElement, cls: string): ShimElement[] {
    const out: ShimElement[] = [];
    const visit = (node: ShimElement | undefined): void => {
        if (!node) return;
        if ((node.cls ?? "").split(/\s+/).includes(cls)) out.push(node);
        for (const child of node.children ?? []) visit(child);
    };
    visit(element);
    return out;
}

/** 等标签页那一次异步扫描跑完（它内部有一串 await，用轮询最稳）。 */
async function waitForRows(view: ImageManagerView, path: string): Promise<void> {
    await vi.waitFor(() => {
        expect(textsOf(view.contentEl as unknown as ShimElement)).toContain(path);
    });
}

beforeEach(() => {
    resetCreatedSettings();
    Notice.instances.length = 0;
});

afterEach(() => {
    for (const r2 of installed.splice(0)) r2.restore();
});

describe("ImageManagerView 渲染", () => {
    it("扫描完成后把三条轴的状态都画出来", async () => {
        const h = createHarness();
        h.vault.seed("images/used.png", { bytes: 2048 });
        h.vault.seed("images/orphan.png", { bytes: 1024 });
        h.vault.seed("notes/n.md", { text: "![[images/used.png]]" });
        h.r2.objects.set("images/used.png", { size: 2048, etag: "a", lastModified: 1 });
        h.r2.objects.set("images/cloud-only.png", { size: 512, etag: "b", lastModified: 1 });

        const view = h.open();
        await waitForRows(view, "images/orphan.png");

        const all = textsOf(view.contentEl as unknown as ShimElement);

        // 三条轴各有代表的路径都在列表里。
        expect(all).toContain("images/used.png");
        expect(all).toContain("images/cloud-only.png");

        // 统计行：本地 2 / 云端 2 / 已链接 1 / 失联 1 / 合计 3。
        const stats = textsOf(withClass(view.contentEl as unknown as ShimElement, "obsync-image-stats")[0]!);
        expect(stats).toEqual(
            expect.arrayContaining([
                zhCN.images.manager.statLocal,
                zhCN.images.manager.statRemote,
                zhCN.images.manager.statLinked,
                zhCN.images.manager.statOrphan,
                zhCN.images.manager.statTotal,
            ])
        );
        expect(stats).toContain("3"); // 合计
        expect(stats).toContain("1"); // 失联 / 已链接

        // 状态徽标：同一张图会同时带多个（「三条轴」的直接证据）。
        expect(all).toContain(zhCN.images.manager.badgeLocal);
        expect(all).toContain(zhCN.images.manager.badgeRemote);
        expect(all).toContain(zhCN.images.manager.badgeLinked(1));
        expect(all).toContain(zhCN.images.manager.badgeOrphan);
    });

    it("「已链接」徽标的悬停里写着是谁在引用它", async () => {
        const h = createHarness();
        h.vault.seed("images/used.png", { bytes: 100 });
        h.vault.seed("notes/a.md", { text: "![[images/used.png]]" });
        h.vault.seed("notes/b.md", { text: "![[images/used.png]]" });

        const view = h.open();
        await waitForRows(view, "images/used.png");

        const badges = withClass(view.contentEl as unknown as ShimElement, "obsync-image-badge-linked");
        expect(badges).toHaveLength(1);
        // 引用来源是**判断一张图能不能删**的决定性信息，而列表里放不下它 ——
        // 所以它必须挂在 `title` 上（这是这条断言的唯一理由）。
        // 注意读的是**属性**而不是 `setAttribute` 的结果：真实 DOM 里
        // `el.title = x` 就是设置 tooltip 的写法。
        const badge = badges[0] as unknown as { title?: string };
        expect(badge.title).toBe("notes/a.md\nnotes/b.md");
    });

    /**
     * 缩略图必须带 **width / height 属性**。
     *
     * 这条断言挡的是一个只在真机标签页里出现的回归：Obsidian 的 app.css 有
     * `.workspace-leaf-content img:not([width]) { max-width: 100% }` ——
     * 弹窗不在 leaf 里所以从来不中招，标签页在。表格自动布局把缩略图那一格
     * 挤到接近 0 宽时（路径列带 `max-width: 0`），这条 max-width 会让图片
     * 跟着缩到 0，整列消失。有 width 属性就不匹配那条选择器。
     *
     * 读的是 `attrs`（`setAttribute` 的记录）—— 这正是那条选择器看的东西。
     */
    it("缩略图带 width / height 属性（否则标签页里会被 Obsidian 的 max-width 规则缩没）", async () => {
        const h = createHarness();
        h.vault.seed("images/a.png", { bytes: 100 });

        const view = h.open();
        await waitForRows(view, "images/a.png");

        const thumbs = withClass(view.contentEl as unknown as ShimElement, "obsync-image-thumb");
        expect(thumbs).toHaveLength(1);
        const attrs = (thumbs[0] as unknown as { attrs?: Record<string, string> }).attrs ?? {};
        expect(attrs["width"]).toBeTruthy();
        expect(attrs["height"]).toBeTruthy();
        // src 仍然指向库里那一份（getResourcePath），属性只是尺寸兜底
        expect(attrs["src"]).toBeTruthy();
    });

    it("筛选区、选择条与五个批量动作都画出来了", async () => {
        const h = createHarness();
        h.vault.seed("images/a.png", { bytes: 100 });

        const view = h.open();
        await waitForRows(view, "images/a.png");
        const all = textsOf(view.contentEl as unknown as ShimElement);

        const t = zhCN.images.manager;
        expect(all).toEqual(
            expect.arrayContaining([
                t.filterLocal,
                t.filterRemote,
                t.filterLinked,
                t.filterState.any,
                t.filterState.yes,
                t.filterState.no,
                t.presetOrphans,
                t.presetPendingUpload,
                t.presetRemoteOnly,
                t.presetLarge,
                t.presetReset,
                t.selectAll,
                t.actionSync,
                t.actionCompress,
                t.actionRename,
                t.actionDeleteLocal,
                t.actionDeleteBoth,
            ])
        );
        // 压缩参数说明必须写明「保持原格式」—— 用户会以为它按默认输出格式跑。
        // 参数值按设置页的默认值算（面板里的公式与这里一致）。
        const defaults = normalizeSettings({}).images;
        expect(all).toContain(
            t.compressHint(`${defaults.compressQuality} / ${defaults.compressMaxEdge}`)
        );
    });

    it("云端读不到时顶部给出警告，而不是把「云端一张都没有」当真", async () => {
        const h = createHarness();
        h.vault.seed("images/a.png", { bytes: 100 });
        h.r2.override = (request) =>
            "list-type" in request.query ? { status: 403, text: "<Error/>" } : undefined;

        const view = h.open();
        await waitForRows(view, "images/a.png");

        const warnings = withClass(view.contentEl as unknown as ShimElement, "obsync-image-note-warn");
        expect(warnings.length).toBeGreaterThan(0);
        expect(textsOf(warnings[0]!)[0]).toContain(zhCN.images.manager.remoteFailed("").slice(0, 8));
    });

    it("没配 R2 时只说明「看不到云端」，面板本身照常可用", async () => {
        const h = createHarness({ bucket: "" });
        h.vault.seed("images/a.png", { bytes: 100 });

        const view = h.open();
        await waitForRows(view, "images/a.png");

        const all = textsOf(view.contentEl as unknown as ShimElement);
        expect(all).toContain(zhCN.images.manager.notConfigured);
        expect(h.r2.requests).toEqual([]);
    });

    it("一张图都没有时给出空状态，而不是一张空表", async () => {
        const h = createHarness();
        const view = h.open();

        await vi.waitFor(() => {
            const all = textsOf(view.contentEl as unknown as ShimElement);
            expect(all).toContain(zhCN.images.manager.empty);
        });
    });
});

/**
 * 标签页的「身份」。
 *
 * 视图类型**发布后不可改** —— 它持久化在用户的 `workspace.json` 里，改了会让
 * 已经打开的标签页失效。标题与图标决定标签页长什么样，也一并钉住
 * （`getT` 而不是快照，切换语言后标题要跟着变）。
 */
describe("ImageManagerView 的视图身份", () => {
    it("视图类型、标题与图标", () => {
        const h = createHarness();
        const view = new ImageManagerView(null as unknown as WorkspaceLeaf, {
            app: h.vault.app,
            getT: () => zhCN,
            notifier: new Notifier({ getShowNotices: () => false, getT: () => zhCN }),
            service: h.module.service,
            deleteImages: (paths, options) => h.module.deleteImages(paths, options),
        });

        expect(view.getViewType()).toBe(IMAGE_VIEW_TYPE);
        expect(view.getDisplayText()).toBe(zhCN.images.manager.title);
        expect(view.getIcon()).toBe("images");
    });
});

describe("BatchRenameModal 渲染", () => {
    it("实时预览旧名 → 新名，并把不能执行的那几条标出原因", async () => {
        const modal = new BatchRenameModal(
            createHarness().vault.app,
            zhCN,
            ["photos/a.png", "photos/b.png"],
            // 第二条的目标（`b-2.png`）已经存在 —— 用来验「撞车的那条被标出来」。
            { exists: (path) => path === "photos/b-2.png", onConfirm: () => undefined }
        );
        modal.open();

        const t = zhCN.images.manager;

        // 模板 / 起始序号是 `Setting` 行 —— 垫片里的 `Setting` 不往 DOM 里画名字，
        // 所以这一半只能从 `createdSettings` 上断言（见 tests/setup.ts）。
        const names = createdSettings.map((setting) => setting.name);
        expect(names).toContain(t.renameTemplate);
        expect(names).toContain(t.renameStart);

        // 预览区是弹窗自己 `createEl` 出来的，能从 DOM 文本上断言。
        const all = textsOf(modal.contentEl as unknown as ShimElement);
        expect(all).toContain("→");
        // 默认模板 `{name}-{n}` 会补上原扩展名（忘写 {ext} 不该产出没后缀的文件）。
        expect(all).toContain("photos/a-1.png");
        expect(all).toContain("photos/b-2.png");
        // 撞车的那条当场说清原因，不能等执行完才发现。
        expect(all).toContain(t.renameProblem.taken);
        // 说明里要列出可用占位符，否则用户只能猜。
        expect(all.some((text) => text.includes("{name}") && text.includes("{n}"))).toBe(true);

        // 按钮上的计数要跟着可执行条数走（只有第一条能改）。
        const buttons = createdSettings.flatMap((setting) => setting.buttons);
        expect(buttons.some((button) => button.text === t.renameConfirm(1))).toBe(true);
    });

    it("模板改掉扩展名时整条跳过并说明原因", () => {
        const modal = new BatchRenameModal(createHarness().vault.app, zhCN, ["photos/a.png"], {
            exists: () => false,
            onConfirm: () => undefined,
        });
        modal.open();

        // 默认模板先渲染一遍，再改成会换容器的模板。
        const template = createdSettings.find(
            (setting) => setting.name === zhCN.images.manager.renameTemplate
        )!.texts[0]!;
        template.type("{name}.webp");

        const all = textsOf(modal.contentEl as unknown as ShimElement);
        expect(all).toContain(zhCN.images.manager.renameProblem.extChanged);
    });
});

describe("ConfirmBatchDeleteModal 渲染", () => {
    it("「仅删本地」说清墓碑的后果，「都删」才给不可撤销的警告", () => {
        const app = createHarness().vault.app;

        const local = new ConfirmBatchDeleteModal({
            app,
            getT: () => zhCN,
            count: 3,
            remote: false,
            onConfirm: () => undefined,
        });
        local.open();
        const localTexts = textsOf(local.contentEl as unknown as ShimElement);
        expect(localTexts).toContain(zhCN.images.manager.confirmLocalDesc);
        expect(localTexts).not.toContain(zhCN.images.manager.confirmBothWarningHeading);

        const both = new ConfirmBatchDeleteModal({
            app,
            getT: () => zhCN,
            count: 3,
            remote: true,
            onConfirm: () => undefined,
        });
        both.open();
        const bothTexts = textsOf(both.contentEl as unknown as ShimElement);
        // 「云端没有回收站」这句必须出现 —— 用户会按「本地删除」的经验去点。
        expect(bothTexts).toContain(zhCN.images.manager.confirmBothWarningHeading);
        expect(bothTexts).toContain(zhCN.images.manager.confirmBothWarning);
    });
});
