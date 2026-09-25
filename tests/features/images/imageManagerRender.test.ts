import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App, WorkspaceLeaf } from "obsidian";
import {
    createdSettings,
    Notice,
    openedModals,
    resetCreatedSettings,
    resetOpenedModals,
    // 组件类型取自**替身**而不是真实 typings：驱动弹窗要用替身才有的
    // `type()` / `click()`，而真实 `TextComponent` 连 `value` 都不声明。
    type ButtonComponent,
    type TextComponent,
} from "../../stubs/obsidian";
import { Notifier } from "../../../src/core/notice";
import { zhCN } from "../../../src/core/i18n/locales/zh-cn";
import { normalizeSettings, type ImageSyncSettings } from "../../../src/core/settings";
import { SecretStore } from "../../../src/core/secretStore";
import type { RenamePlanEntry } from "../../../src/features/images/batchRename";
import { createImageSyncModule, type ImageSyncModule } from "../../../src/features/images";
import type { ImageRecord } from "../../../src/features/images/imageLibrary";
import { IMAGE_VIEW_TYPE, ImageManagerView } from "../../../src/features/images/ui/ImageManagerView";
import { BatchRenameModal } from "../../../src/features/images/ui/BatchRenameModal";
import { ConfirmBatchDeleteModal } from "../../../src/features/images/ui/ConfirmBatchDeleteModal";
import { ImagePreviewModal } from "../../../src/features/images/ui/ImagePreviewModal";
import { RenameFileModal } from "../../../src/features/images/ui/RenameFileModal";
import { formatBytes } from "../../../src/features/sync/repoSize";
import { createFakeImageVault, type FakeImageVault } from "../../helpers/fakeImageVault";
import { createFakeR2, type FakeR2 } from "../../helpers/fakeR2";

/**
 * 图片管理标签页的**渲染冒烟**。
 *
 * ## 为什么值得单独写（这一页没有任何别的测试）
 *
 * 面板是整个图片功能里唯一「代码量最大、又完全不进单测」的部分：它碰 DOM、
 * 依赖 Obsidian 的组件，而测试环境只有一套手写的最小 DOM 垫片
 * （`tests/setup.ts`）。**垫片会把 `addEventListener` 记下来并给出
 * `trigger(name)`**，所以「点这个按钮会弹出什么」也验得了（读 `openedModals`）——
 * 但它**不冒泡**，所以「点行内按钮会不会顺带勾中那一行」这类跨元素行为
 * 仍然只能靠真机（生产代码里靠 `closest("input, button")` 挡）。
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
    resetOpenedModals();
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

/**
 * 单文件重命名的入口在**每一行**上。
 *
 * 它与「勾选若干 → 点底部那颗重命名」是两个不同的动作：后者处理一批，
 * 前者处理「就这一张」。混成一个是错的 —— 用户为了改一张图的名字得先勾上
 * 它，而那一勾会让底下一排批量按钮亮起来，界面在暗示一个他没打算做的
 * 批量操作。
 */
describe("行内的单文件重命名入口", () => {
    it("每一行都有一颗带标签的铅笔按钮", async () => {
        const h = createHarness();
        h.vault.seed("images/a.png", { bytes: 100 });
        h.vault.seed("images/b.png", { bytes: 100 });

        const view = h.open();
        await waitForRows(view, "images/a.png");

        const buttons = withClass(
            view.contentEl as unknown as ShimElement,
            "obsync-image-row-action"
        );
        // 一张图一颗 —— 它不依赖勾选，所以不能只在「选中了什么」时才出现。
        expect(buttons).toHaveLength(2);

        // 按钮里只有图标，含义全靠 `aria-label`（悬停看得到，读屏也读得到）。
        const attrs = (buttons[0] as unknown as { attrs?: Record<string, string> }).attrs ?? {};
        expect(attrs["data-icon"]).toBe("pencil");
        expect(attrs["aria-label"]).toBe(zhCN.images.manager.renameThis);
    });

    it("点它打开的是**单文件**弹窗，且预填当前文件名", async () => {
        const h = createHarness();
        h.vault.seed("images/日落.png", { bytes: 100 });

        const view = h.open();
        await waitForRows(view, "images/日落.png");

        const button = withClass(
            view.contentEl as unknown as ShimElement,
            "obsync-image-row-action"
        )[0]!;
        (button as unknown as { trigger(name: string): void }).trigger("click");

        expect(openedModals.some((modal) => modal instanceof RenameFileModal)).toBe(true);
        // 预填的是**文件名**（含扩展名），不是整条路径 —— 目录不由用户决定。
        const field = createdSettings.find(
            (setting) => setting.name === zhCN.images.manager.renameFileName
        );
        expect(field?.texts[0]?.value).toBe("日落.png");
    });

    /**
     * 行本身也监听 click（点行任意处 = 勾选）。真实 DOM 里点按钮时事件会**冒泡**
     * 到行上，所以行那个处理器必须把 `button` 一起排除掉 —— 否则用户只是想改个
     * 名字，却顺手把这一行勾上了（然后底下一排批量按钮亮起来）。
     *
     * 垫片**不冒泡**，所以这里按真实事件的形状手动造一个（`target.closest` 能
     * 匹配到 button）。它验的是处理器里的判据，不是浏览器的冒泡行为。
     */
    it("点行内按钮不会顺带勾中这一行", async () => {
        const h = createHarness();
        h.vault.seed("images/a.png", { bytes: 100 });

        const view = h.open();
        await waitForRows(view, "images/a.png");

        const row = withClass(view.contentEl as unknown as ShimElement, "obsync-image-row")[0]!;
        const button = withClass(
            view.contentEl as unknown as ShimElement,
            "obsync-image-row-action"
        )[0]!;
        type Triggerable = { trigger(name: string, ...args: unknown[]): void };

        (button as unknown as Triggerable).trigger("click");
        (row as unknown as Triggerable).trigger("click", {
            target: { closest: (selector: string) => (selector.includes("button") ? {} : null) },
        });

        expect(textsOf(view.contentEl as unknown as ShimElement)).toContain(
            zhCN.images.manager.selectedCount(0)
        );
    });
});

/**
 * 缩略图是「放大看这一张」的入口。
 *
 * 30px 的方框里什么都看不清，而「这到底是张什么图」恰恰是判断它能不能删之前
 * 要看的东西。所以这一格必须能点 —— 而点了**不能顺带把这一行勾上**：缩略图外面
 * 套的是 `<button>`，行上那个「点行 = 勾选」的处理器排除的正是 `button`。
 */
describe("行内缩略图的预览入口", () => {
    it("缩略图套在按钮里，并带说明标签", async () => {
        const h = createHarness();
        h.vault.seed("images/a.png", { bytes: 100 });

        const view = h.open();
        await waitForRows(view, "images/a.png");

        const buttons = withClass(
            view.contentEl as unknown as ShimElement,
            "obsync-image-thumb-button"
        );
        expect(buttons).toHaveLength(1);

        // 鼠标悬停要能看出这一格可点（图标本身没有文字）。
        const attrs = (buttons[0] as unknown as { attrs?: Record<string, string> }).attrs ?? {};
        expect(attrs["title"]).toBe(zhCN.images.manager.previewOpen);

        // 图仍然在按钮**里面** —— CSS 靠这条父子关系做悬停描边。
        expect(withClass(buttons[0]!, "obsync-image-thumb")).toHaveLength(1);
    });

    it("点缩略图打开预览弹窗，弹窗里就是这一张", async () => {
        const h = createHarness();
        h.vault.seed("images/日落.png", { bytes: 2048 });

        const view = h.open();
        await waitForRows(view, "images/日落.png");

        const button = withClass(
            view.contentEl as unknown as ShimElement,
            "obsync-image-thumb-button"
        )[0]!;
        (button as unknown as { trigger(name: string): void }).trigger("click");

        const modal = openedModals.find((item) => item instanceof ImagePreviewModal);
        expect(modal).toBeInstanceOf(ImagePreviewModal);
        // 标题是**文件名**，完整路径在弹窗里那一行元信息上（标题栏放不下长路径）。
        const title = (modal as unknown as { titleEl: { text?: string } }).titleEl;
        expect(title.text).toBe("日落.png");
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

/**
 * 单文件重命名弹窗。
 *
 * 判据与文案和批量弹窗是同一份（都走 `planSingleRename` / `renameProblem`），
 * 所以这里不重复验「非法字符长什么样」，只钉住两者不同的那一半：
 * 名字是用户**直接给的**，不是模板算的 —— 于是「预填」「补扩展名」
 * 「确认时交出去的是算好的路径」这三件事只有这条路径上存在。
 */
describe("RenameFileModal 渲染", () => {
    /** 弹窗里的文件名输入框。 */
    function fieldOf(): TextComponent {
        return createdSettings.find(
            (setting) => setting.name === zhCN.images.manager.renameFileName
        )!.texts[0]!;
    }

    /** 弹窗底部那颗确认按钮。 */
    function confirmOf(): ButtonComponent {
        return createdSettings
            .flatMap((setting) => setting.buttons)
            .find((button) => button.text === zhCN.images.manager.renameFileConfirm)!;
    }

    function openModal(
        exists: (path: string) => boolean = () => false,
        onConfirm: (entry: RenamePlanEntry) => void = () => undefined
    ): RenameFileModal {
        const modal = new RenameFileModal(createHarness().vault.app, zhCN, "photos/a.png", {
            exists,
            onConfirm,
        });
        modal.open();
        return modal;
    }

    it("预填当前文件名，并实时预览旧名 → 新名", () => {
        const modal = openModal();
        expect(fieldOf().value).toBe("a.png");

        // 不写扩展名 → 自动沿用原扩展名（与批量同一条规则）。
        fieldOf().type("海边");
        const all = textsOf(modal.contentEl as unknown as ShimElement);
        expect(all).toContain("photos/a.png");
        expect(all).toContain("photos/海边.png");
        expect(all).toContain("→");
        expect(confirmOf().disabled).toBe(false);
    });

    it("名字没变时不给确认 —— `unchanged` 不是错误，但没什么可做", () => {
        // 打开时输入框里就是原名，所以这是**初始**状态：进弹窗就先点一下
        // 确认不该发生任何事。
        const modal = openModal();
        expect(textsOf(modal.contentEl as unknown as ShimElement)).toContain(
            zhCN.images.manager.renameProblem.unchanged
        );
        expect(confirmOf().disabled).toBe(true);
    });

    it("目标已被占用时标出原因并禁用确认（**绝不覆盖**）", () => {
        const modal = openModal((path) => path === "photos/b.png");
        fieldOf().type("b");

        expect(textsOf(modal.contentEl as unknown as ShimElement)).toContain(
            zhCN.images.manager.renameProblem.taken
        );
        expect(confirmOf().disabled).toBe(true);
    });

    it("只改扩展名时整条拒绝 —— 改名不改内容", () => {
        const modal = openModal();
        fieldOf().type("a.webp");

        expect(textsOf(modal.contentEl as unknown as ShimElement)).toContain(
            zhCN.images.manager.renameProblem.extChanged
        );
        expect(confirmOf().disabled).toBe(true);
    });

    it("确认后交给调用方的是**算好的**条目，而不是输入框里的原文", () => {
        const confirmed: RenamePlanEntry[] = [];
        openModal(
            () => false,
            (entry) => {
                confirmed.push(entry);
            }
        );

        fieldOf().type("海边");
        confirmOf().click();

        // 扩展名是弹窗补上的（用户没写），所以调用方必须拿到补全后的路径 ——
        // 否则改出来的文件没有扩展名，Obsidian 不再把它当图片。
        expect(confirmed).toEqual([{ from: "photos/a.png", to: "photos/海边.png" }]);
    });
});

/**
 * 预览弹窗。
 *
 * 它刻意**不只是一张图**：放大看清之后紧接着要做的判断是「留还是删」，
 * 而支撑那个判断的三样东西（体积、在不在两边、谁在引用它）在列表里都放不下。
 */
describe("ImagePreviewModal 渲染", () => {
    /** 两边都有、被两处引用的一张图 —— 大部分断言用它当基准。 */
    const linked: ImageRecord = {
        path: "images/日落.png",
        local: { path: "images/日落.png", size: 2048, mtime: 1 },
        remote: { key: "images/日落.png", size: 2048, etag: "e", lastModified: 1 },
        refs: ["notes/a.md", "notes/b.md"],
    };

    function openModal(record: ImageRecord): ImagePreviewModal {
        const h = createHarness();
        // 库里得真有这个文件，否则 `getResourcePath` 那条路走不到 ——
        // `record.local` 有值就意味着它应该在本地。
        if (record.local) h.vault.seed(record.path, { bytes: record.local.size });
        const modal = new ImagePreviewModal(h.vault.app, zhCN, record);
        modal.open();
        return modal;
    }

    it("画大图，并把路径 / 体积 / 状态摆在下面", () => {
        const modal = openModal(linked);

        const images = withClass(
            modal.contentEl as unknown as ShimElement,
            "obsync-image-preview-img"
        );
        expect(images).toHaveLength(1);
        const attrs = (images[0] as unknown as { attrs?: Record<string, string> }).attrs ?? {};
        // src 指向库里那一份（真实 Obsidian 里是 `app://` 资源地址）。
        expect(attrs["src"]).toBeTruthy();
        // 这张图是弹窗的主体、不是装饰，所以 alt 要说清它是谁。
        expect(attrs["alt"]).toBe("images/日落.png");

        const all = textsOf(modal.contentEl as unknown as ShimElement);
        expect(all).toContain("images/日落.png");
        expect(all).toContain(formatBytes(2048));
        expect(all).toContain(zhCN.images.manager.badgeLocal);
        expect(all).toContain(zhCN.images.manager.badgeRemote);
        expect(all).toContain(zhCN.images.manager.badgeLinked(2));
    });

    it("「已链接」徽标的悬停里写着是谁在引用它（与列表同一个理由）", () => {
        const modal = openModal(linked);

        const badges = withClass(
            modal.contentEl as unknown as ShimElement,
            "obsync-image-badge-linked"
        );
        expect(badges).toHaveLength(1);
        const badge = badges[0] as unknown as { title?: string };
        expect(badge.title).toBe("notes/a.md\nnotes/b.md");
    });

    it("没人引用时明说「无人引用」—— 这正是要删的那一类", () => {
        const modal = openModal({
            path: "images/orphan.png",
            local: { path: "images/orphan.png", size: 100, mtime: 1 },
            refs: [],
        });

        const all = textsOf(modal.contentEl as unknown as ShimElement);
        expect(all).toContain(zhCN.images.manager.badgeOrphan);
        expect(all).not.toContain(zhCN.images.manager.badgeRemote);
    });

    it("本地没有那一份时不画图（拿不到资源地址），但元信息照给", () => {
        const modal = openModal({
            path: "images/cloud-only.png",
            remote: { key: "images/cloud-only.png", size: 512, etag: "e", lastModified: 1 },
            refs: [],
        });

        // `getResourcePath` 只认库里的文件。列表里这种行本来就没有缩略图
        // （也就没有入口），这里是兜底：宁可不画，也不画一个破图。
        expect(
            withClass(modal.contentEl as unknown as ShimElement, "obsync-image-preview-img")
        ).toHaveLength(0);

        const all = textsOf(modal.contentEl as unknown as ShimElement);
        expect(all).toContain("images/cloud-only.png");
        expect(all).toContain(formatBytes(512));
    });
});

/**
 * 预览弹窗的缩放。
 *
 * 档位表是可枚举的，所以「到顶了没有」能直接体现在按钮的可用性上 —— 这里钉住的是
 * 三件事：**档位按表走**、**放大走尺寸而不是 `transform`**（否则超出的部分滚不到）、
 * **到头就灰**。
 *
 * 拖动平移（`beginPan`）测不到：它读 `clientX` / `clientY` 并往 `document` 上挂监听，
 * 而垫片的 `document.addEventListener` 是空实现。那条路径只能真机看。
 */
describe("ImagePreviewModal 缩放", () => {
    function openModal(): ImagePreviewModal {
        const h = createHarness();
        h.vault.seed("images/a.png", { bytes: 2048 });
        const modal = new ImagePreviewModal(h.vault.app, zhCN, {
            path: "images/a.png",
            local: { path: "images/a.png", size: 2048, mtime: 1 },
            refs: [],
        });
        modal.open();
        return modal;
    }

    /** 工具条上那颗按钮（按图标找 —— 按钮只有图标，没有文字）。 */
    function buttonOf(modal: ImagePreviewModal, icon: string): ShimElement & { disabled?: boolean } {
        const element = withClass(
            modal.contentEl as unknown as ShimElement,
            "obsync-image-preview-button"
        ).find((item) => (item.attrs ?? {})["data-icon"] === icon);
        expect(element, `找不到图标为 ${icon} 的按钮`).toBeDefined();
        return element as unknown as ShimElement & { disabled?: boolean };
    }

    function press(modal: ImagePreviewModal, icon: string): void {
        (buttonOf(modal, icon) as unknown as { trigger(name: string): void }).trigger("click");
    }

    function zoomText(modal: ImagePreviewModal): string {
        const label = withClass(
            modal.contentEl as unknown as ShimElement,
            "obsync-image-preview-zoom"
        )[0];
        return label?.text ?? "";
    }

    /** 舞台元素。 */
    function stageOf(modal: ImagePreviewModal): ShimElement {
        return withClass(modal.contentEl as unknown as ShimElement, "obsync-image-preview-stage")[0]!;
    }

    function imageOf(modal: ImagePreviewModal): ShimElement {
        return withClass(modal.contentEl as unknown as ShimElement, "obsync-image-preview-img")[0]!;
    }

    function hintOf(modal: ImagePreviewModal): ShimElement {
        return withClass(modal.contentEl as unknown as ShimElement, "obsync-image-preview-hint")[0]!;
    }

    /** 某个元素的行内样式（尺寸与平移都写在上面）。 */
    function styleOf(element: ShimElement): Record<string, string> {
        return (element as unknown as { style?: Record<string, string> }).style ?? {};
    }

    /**
     * 垫片把 `window` 指向了 `globalThis`（见 `tests/setup.ts`），而可用空间是从
     * `window.innerWidth` / `innerHeight` 算出来的 —— 所以要设在这里。
     */
    function setViewport(width: number, height: number): void {
        const globals = globalThis as unknown as Record<string, number>;
        globals["innerWidth"] = width;
        globals["innerHeight"] = height;
    }

    /**
     * 让弹窗「量到」一张 `natural` 大小的图。
     *
     * 垫片不会真的解码图片，`onload` 也就不会自己触发 —— 这里把 `naturalWidth` /
     * `naturalHeight` 填上再触发一次，等价于真实环境里图片解码完的那一刻。
     */
    function loadImage(modal: ImagePreviewModal, natural: { width: number; height: number }): void {
        const image = imageOf(modal) as unknown as {
            naturalWidth?: number;
            naturalHeight?: number;
            trigger(name: string): void;
        };
        image.naturalWidth = natural.width;
        image.naturalHeight = natural.height;
        image.trigger("load");
    }

    it("工具条是「缩小 / 倍率 / 重置 / 放大」，初始 100%", () => {
        const modal = openModal();

        // 顺序就是排布（垫片按调用顺序 append），所以连顺序一起钉住。
        const icons = withClass(
            modal.contentEl as unknown as ShimElement,
            "obsync-image-preview-button"
        ).map((element) => (element.attrs ?? {})["data-icon"]);
        expect(icons).toEqual(["zoom-out", "rotate-ccw", "zoom-in"]);

        expect(zoomText(modal)).toBe("100%");

        // 初始状态下没什么可重置的 —— 灰掉，而不是让用户点了没反应。
        expect(buttonOf(modal, "zoom-out").disabled).toBe(false);
        expect(buttonOf(modal, "rotate-ccw").disabled).toBe(true);
        expect(buttonOf(modal, "zoom-in").disabled).toBe(false);
    });

    /**
     * 还没解码完时**不写任何行内尺寸**，退回 CSS 的兜底。
     *
     * 这条挡的是「按 0 去设」：`naturalWidth` 拿不到时算出来是 0，照着设
     * `width: 0px` 会让图片整个消失，而用户看到的只是「预览打不开」。
     */
    it("量不到自然尺寸时不写行内尺寸（退回 CSS 兜底）", () => {
        const modal = openModal();

        expect(styleOf(imageOf(modal))["width"]).toBeUndefined();
        expect(styleOf(stageOf(modal))["width"]).toBeUndefined();
        // 尺寸未知就无从判断溢出 —— 宁可不给抓手，也不要给一个拖不动的抓手。
        expect(stageOf(modal).cls ?? "").not.toContain("obsync-image-preview-pannable");
        expect(hintOf(modal).cls ?? "").toContain("obsync-image-preview-hint-off");
    });

    it("量到尺寸后，舞台与图片按倍率长大（弹窗宽度靠 CSS 的 fit-content 跟上）", () => {
        setViewport(1600, 1000);
        const modal = openModal();
        // 可用空间 = min(1600×0.92, 1400) × (1000-220) = 1400×780。
        // 4000×2000 装进去 → 受宽度约束，100% 就是 1400×700。
        loadImage(modal, { width: 4000, height: 2000 });

        expect(styleOf(stageOf(modal))["width"]).toBe("1400px");
        expect(styleOf(stageOf(modal))["height"]).toBe("700px");
        expect(styleOf(imageOf(modal))["width"]).toBe("1400px");
        expect(styleOf(imageOf(modal))["height"]).toBe("700px");

        // 100% 装得下 → 没有溢出 → 不给抓手、不显示提示。
        expect(stageOf(modal).cls ?? "").not.toContain("obsync-image-preview-pannable");
        expect(hintOf(modal).cls ?? "").toContain("obsync-image-preview-hint-off");
    });

    it("缩小 → 弹窗跟着变小", () => {
        setViewport(1600, 1000);
        const modal = openModal();
        loadImage(modal, { width: 4000, height: 2000 });

        press(modal, "zoom-out");
        expect(zoomText(modal)).toBe("75%");
        expect(styleOf(stageOf(modal))["width"]).toBe("1050px");
        expect(styleOf(stageOf(modal))["height"]).toBe("525px");
    });

    /**
     * 「弹窗跟着长大、到上限为止、再大就靠拖」的最后一段。
     *
     * 封顶之后舞台不再长，而图片继续变大 —— 两者的差就是靠拖去看的部分。
     */
    it("放大到装不下时舞台封顶、图片继续变大，并出现抓手与提示", () => {
        setViewport(1600, 1000);
        const modal = openModal();
        loadImage(modal, { width: 4000, height: 2000 });

        press(modal, "zoom-in"); // 150%：想要 2100×1050，装不下
        press(modal, "zoom-in"); // 200%：想要 2800×1400

        expect(zoomText(modal)).toBe("200%");
        // 舞台封顶在可用空间。
        expect(styleOf(stageOf(modal))["width"]).toBe("1400px");
        expect(styleOf(stageOf(modal))["height"]).toBe("780px");
        // 图片**不封顶**：多出来的部分正是靠拖去看的。
        expect(styleOf(imageOf(modal))["width"]).toBe("2800px");
        expect(styleOf(imageOf(modal))["height"]).toBe("1400px");

        expect(stageOf(modal).cls ?? "").toContain("obsync-image-preview-pannable");
        expect(hintOf(modal).cls ?? "").not.toContain("obsync-image-preview-hint-off");
    });

    it("缩放走尺寸而不是 transform（transform 不改变布局，撑不开弹窗）", () => {
        setViewport(1600, 1000);
        const modal = openModal();
        loadImage(modal, { width: 4000, height: 2000 });

        press(modal, "zoom-in");
        // 倍率取自档位表（150%），不是 1.25 累乘出来的 —— 累乘会给出 156%。
        expect(zoomText(modal)).toBe("150%");
        expect(styleOf(imageOf(modal))["width"]).toBe("2100px");
        // `transform` 只留给拖动平移，里面不该有 `scale`。
        expect(styleOf(imageOf(modal))["transform"] ?? "").not.toContain("scale");
    });

    it("重置回到 100%，弹窗也回到贴合图片的尺寸", () => {
        setViewport(1600, 1000);
        const modal = openModal();
        loadImage(modal, { width: 4000, height: 2000 });

        press(modal, "zoom-in");
        press(modal, "zoom-in");
        press(modal, "rotate-ccw");

        expect(zoomText(modal)).toBe("100%");
        expect(styleOf(stageOf(modal))["width"]).toBe("1400px");
        expect(styleOf(stageOf(modal))["height"]).toBe("700px");
        expect(buttonOf(modal, "rotate-ccw").disabled).toBe(true);
    });

    it("到两头就停住，并把对应那颗按钮灰掉", () => {
        const modal = openModal();

        for (let index = 0; index < 10; index++) press(modal, "zoom-in");
        expect(zoomText(modal)).toBe("400%");
        expect(buttonOf(modal, "zoom-in").disabled).toBe(true);

        for (let index = 0; index < 20; index++) press(modal, "zoom-out");
        expect(zoomText(modal)).toBe("25%");
        expect(buttonOf(modal, "zoom-out").disabled).toBe(true);
    });

    /**
     * 滚轮直接缩放 —— 舞台自己**不滚动**，所以滚轮落在这一格上没有别的含义。
     *
     * 这条是**回归守卫**：上一版把它改成「只有 Ctrl / Cmd + 滚轮才缩放」，
     * 用户立刻报「滚轮缩放丢失了」。
     */
    it("滚轮直接缩放（向上放大、向下缩小）", () => {
        const modal = openModal();
        let prevented = 0;
        const wheel = (deltaY: number): void => {
            (
                stageOf(modal) as unknown as { trigger(name: string, ...args: unknown[]): void }
            ).trigger("wheel", {
                deltaY,
                preventDefault: () => {
                    prevented += 1;
                },
            });
        };

        wheel(-100);
        expect(zoomText(modal)).toBe("150%");
        // 拦掉默认行为：不拦的话这一滚还会被宿主拿去滚页面 / 缩放界面。
        expect(prevented).toBe(1);

        wheel(100);
        expect(zoomText(modal)).toBe("100%");
        expect(prevented).toBe(2);
    });
});
