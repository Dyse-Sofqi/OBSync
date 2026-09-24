import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __setDesktop } from "./stubs/obsidian";
import ObsyncPlugin from "../src/main";
import { createFakeApp, type FakeApp } from "./helpers/fakeApp";

/**
 * 装配路径的冒烟测试 —— `main.ts` 的 `onload()` 整个跑一遍。
 *
 * ## 为什么需要它
 *
 * 这是**目前唯一没有别的测试覆盖的路径**，而它恰恰踩过坑：曾经把状态栏元素
 * 挂到 `app.workspace.addStatusBarItem()` 上，而真实 API 在 `Plugin` 类上 ——
 * 单测全绿，**真机启动才 TypeError**。那类错误（方法挂在哪个对象上、
 * 调用了不存在的方法、初始化顺序）靠模块级单测是发现不了的。
 *
 * 做法：把 Obsidian 基类的方法补全（`tests/stubs/obsidian.ts` 的 `Plugin`），
 * 让真实的 `onload()` 跑在假的 app 上，断言它注册了什么。
 * 只要 `onload` 里调用了 stub 没有的 API，这里就会以 TypeError 失败。
 *
 * 它不能替代真机验证（渲染、真实网络、Obsidian 内部 API 的实际行为仍要手测），
 * 但能把「装配写错」这一类问题从"真机才发现"提前到"跑测试就发现"。
 */

const MANIFEST = {
    id: "ob-sync",
    name: "SyncHub",
    version: "0.1.0",
    minAppVersion: "1.5.0",
    description: "test",
    author: "test",
};

function createPlugin(fake: FakeApp): ObsyncPlugin & {
    registered: {
        commands: Array<{ id: string; name: string }>;
        views: string[];
        settingTabs: number;
        ribbonIcons: number;
        ribbons: Array<{ icon: string; title: string; onClick: () => void }>;
        statusBarItems: number;
        postProcessors: number;
    };
} {
    // 真实签名是 (app, manifest)，stub 与之对齐。
    return new ObsyncPlugin(fake.app, MANIFEST) as never;
}

/**
 * 替身 Plugin 上的落盘记录。
 *
 * 类型层面用的是**官方 obsidian 类型**（没有 `savedData` / `__data` —— 它们是
 * 我们替身加的），所以这里显式取值。运行时走的才是替身（vitest 别名）。
 */
function savedDataOf(plugin: ObsyncPlugin): unknown[] {
    return (plugin as unknown as { savedData: unknown[] }).savedData;
}

function setLoadedData(plugin: ObsyncPlugin, data: unknown): void {
    (plugin as unknown as { __data: unknown }).__data = data;
}

let fake: FakeApp;

beforeEach(() => {
    fake = createFakeApp();
    __setDesktop(true);
});

afterEach(() => {
    __setDesktop(true);
});

describe("桌面端启动", () => {
    it("onload 不抛错", async () => {
        const plugin = createPlugin(fake);

        await expect(plugin.onload()).resolves.toBeUndefined();
    });

    it("两个功能模块都装配上了", async () => {
        const plugin = createPlugin(fake);
        await plugin.onload();

        expect(plugin.installer).toBeDefined();
        expect(plugin.sync).toBeDefined();
        // 图片同步是**第三个**模块，两个平台都装。
        expect(plugin.images).toBeDefined();
        expect(plugin.secretStore).toBeDefined();
        expect(plugin.notifier).toBeDefined();
    });

    it("注册了图片同步的四条命令", async () => {
        const plugin = createPlugin(fake);
        await plugin.onload();

        const ids = plugin.registered.commands.map((command) => command.id);
        expect(ids).toContain("sync-images");
        expect(ids).toContain("preview-image-sync");
        expect(ids).toContain("edit-image");
        expect(ids).toContain("copy-image-link");
    });

    /**
     * 阅读视图的图片工具条挂在 Markdown 后处理器上。
     *
     * 这条断言看着琐碎，但它守的是一类**真机才炸**的错误：`onload` 里调了
     * stub 没有的方法会直接 TypeError，而症状是「插件加载失败」——
     * 与真正的原因（API 用错）隔得很远。
     */
    it("注册了 Markdown 后处理器（阅读视图的图片工具条）", async () => {
        const plugin = createPlugin(fake);
        await plugin.onload();

        expect(plugin.registered.postProcessors).toBe(1);
    });

    /**
     * 「删掉一张本地图片 → 问一句要不要连云端一起删」靠 `vault.on("delete")`。
     *
     * 这是删除的**唯一**入口：同步本身只复制、不删除。挂不上这个事件，
     * 功能就整个不存在，而界面上看不出任何异常 —— 只是「删了图之后从来没人问」。
     */
    it("挂在 vault 的 delete 事件上（本地删除的唯一入口）", async () => {
        const plugin = createPlugin(fake);
        await plugin.onload();

        expect(fake.vaultEvents.map((entry) => entry.event)).toContain("delete");
    });

    it("加载时清掉「待重启」标记（否则重启完还会看到「重启后生效」）", async () => {
        const plugin = createPlugin(fake);
        setLoadedData(plugin, { installer: { pendingRestartVersion: "0.2.0" } });

        await plugin.onload();

        // 存回过一次，且标记被清空 —— 这次加载跑的就是那个新版本了
        expect(savedDataOf(plugin)).toHaveLength(1);
        expect(
            (savedDataOf(plugin)[0] as { installer: { pendingRestartVersion: string } })
                .installer.pendingRestartVersion
        ).toBe("");
        expect(plugin.settings.installer.pendingRestartVersion).toBe("");
    });

    it("没有待重启标记时**不做多余的保存**（否则每次启动都写一次 data.json）", async () => {
        const plugin = createPlugin(fake);

        await plugin.onload();

        expect(savedDataOf(plugin)).toEqual([]);
    });

    it("注册了设置页、侧栏图标与状态栏元素", async () => {
        const plugin = createPlugin(fake);
        await plugin.onload();

        expect(plugin.registered.settingTabs).toBe(1);
        // 三个图标：同步面板、安装器、图片管理。原来只有一个，而它打开的是
        // 安装器 —— 于是「同步面板在哪」在界面上无解。
        expect(plugin.registered.ribbonIcons).toBe(3);
        // 状态栏元素由主类创建后传给 sync 模块 —— 这条断言锁的就是当年踩的那个坑
        // （挂到 workspace 上而不是 Plugin 上）。
        expect(plugin.registered.statusBarItems).toBe(1);
    });

    it("侧栏的同步图标真的会请求打开仓库同步视图", async () => {
        const plugin = createPlugin(fake);
        await plugin.onload();

        const ribbons = plugin.registered.ribbons;
        expect(ribbons.map((ribbon) => ribbon.icon)).toEqual(["git-fork", "download", "images"]);

        // 点第一个（同步）→ 让 Obsidian 在右侧边栏打开那个视图
        ribbons[0]!.onClick();
        await Promise.resolve();

        expect(fake.workspaceLeaves.viewStates.map((state) => state.type)).toContain(
            "obsync-sync-view"
        );

        // 再点一次不该开第二个（已经开着就把它显示出来）
        ribbons[0]!.onClick();
        await Promise.resolve();
        expect(fake.workspaceLeaves.viewStates).toHaveLength(1);
        expect(fake.workspaceLeaves.revealed).toHaveLength(2);
    });

    it("侧栏图标的悬停文案各自说清打开的是什么", async () => {
        const plugin = createPlugin(fake);
        await plugin.onload();

        const ribbons = plugin.registered.ribbons;

        expect(ribbons[0]!.title).toBe(plugin.t.plugin.ribbonSync);
        expect(ribbons[1]!.title).toBe(plugin.t.plugin.ribbonInstaller);
        expect(ribbons[2]!.title).toBe(plugin.t.plugin.ribbonImages);
        // 三个文案两两不同 —— 两个图标共用一句话时，用户分不出该点哪个。
        expect(new Set(ribbons.map((ribbon) => ribbon.title)).size).toBe(3);
    });

    it("注册了仓库同步视图", async () => {
        const plugin = createPlugin(fake);
        await plugin.onload();

        expect(plugin.registered.views).toContain("obsync-sync-view");
    });

    /**
     * 图片管理视图**桌面端也注册**（不是「只有桌面端」）。
     *
     * 它与同步视图的分屏条件正好相反：图片模块移动端也装，工厂函数解引用
     * `this.images` 不会踩空。写成 `if (this.sync)` 那样的守卫会让手机上
     * 的「打开图片管理」命令点下去什么也不发生。
     */
    it("注册了图片管理视图（主工作区标签页）", async () => {
        const plugin = createPlugin(fake);
        await plugin.onload();

        expect(plugin.registered.views).toContain("obsync-image-view");
    });

    /**
     * 图片图标真的去开**主工作区**的标签页，而不是又弹一个模态窗。
     *
     * 2026-09-23 从弹窗改成标签页：整理图片时要一边看着笔记一边决定哪张能删。
     * 这条断言守的是「走的是 getLeaf 这条路」—— 走成右侧边栏（getRightLeaf）
     * 或走回弹窗，都表现为「打开了，但不在该在的地方」。
     */
    it("侧栏的图片图标打开主工作区的图片管理标签页", async () => {
        const plugin = createPlugin(fake);
        await plugin.onload();

        const ribbons = plugin.registered.ribbons;
        const images = ribbons[2]!;
        expect(images.icon).toBe("images");

        images.onClick();
        await Promise.resolve();

        expect(fake.workspaceLeaves.viewStates.map((state) => state.type)).toContain(
            "obsync-image-view"
        );
        expect(fake.workspaceLeaves.revealed).toHaveLength(1);

        // 再点一次不该开第二个（已经开着就把它显示出来）——
        // 两个标签页扫的是同一批图，而每扫一遍要好几秒。
        images.onClick();
        await Promise.resolve();
        expect(fake.workspaceLeaves.viewStates).toHaveLength(1);
        expect(fake.workspaceLeaves.revealed).toHaveLength(2);
    });

    it("所有命令名都带插件名前缀（否则命令面板里搜不到）", async () => {
        const plugin = createPlugin(fake);
        await plugin.onload();

        const commands = plugin.registered.commands;
        expect(commands.length).toBeGreaterThan(0);

        for (const command of commands) {
            expect(command.name, `${command.id} 缺少 SyncHub 前缀`).toMatch(/^SyncHub/);
        }
    });

    it("命令 id 不重复", async () => {
        const plugin = createPlugin(fake);
        await plugin.onload();

        const ids = plugin.registered.commands.map((command) => command.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it("桌面端注册了同步相关命令", async () => {
        const plugin = createPlugin(fake);
        await plugin.onload();

        const ids = plugin.registered.commands.map((command) => command.id);
        for (const expected of ["sync-now", "pull", "push", "init-repo", "open-source-control-view"]) {
            expect(ids, `缺少命令 ${expected}`).toContain(expected);
        }
    });

    it("注册了文件右键菜单（在远端打开）", async () => {
        const plugin = createPlugin(fake);
        await plugin.onload();

        const events = fake.workspaceEvents.map((entry) => entry.event);
        expect(events).toContain("file-menu");
    });

    it("onunload 不抛错", async () => {
        const plugin = createPlugin(fake);
        await plugin.onload();

        expect(() => plugin.onunload()).not.toThrow();
    });

    /**
     * 状态栏全宽开关（设置页「通用」）。
     *
     * 这条规则用到了 `:has()`，只能写在 CSS 里，所以开关的做法是**给 body 加类**
     * （见 `main.ts` 的 `applyStatusBarWidth`）。三件事都要钉住：
     * 开着时加上、关掉时摘掉、**卸载时也摘掉**。
     *
     * 最后那条最容易漏：不摘的话插件禁用后全宽规则还挂在 body 上，状态栏莫名
     * 保持全宽，而谁也看不出是谁干的。
     */
    it("按设置给 body 加/摘「状态栏全宽」的类，卸载时也会摘掉", async () => {
        const plugin = createPlugin(fake);
        await plugin.onload();

        // 默认开着（与既有行为一致）
        expect(document.body.hasClass("obsync-status-bar-full-width")).toBe(true);

        plugin.settings.statusBarFullWidth = false;
        plugin.applyDerivedSettings();
        expect(document.body.hasClass("obsync-status-bar-full-width")).toBe(false);

        plugin.settings.statusBarFullWidth = true;
        plugin.applyDerivedSettings();
        expect(document.body.hasClass("obsync-status-bar-full-width")).toBe(true);

        plugin.onunload();
        expect(document.body.hasClass("obsync-status-bar-full-width")).toBe(false);
    });

    it("启动完成回调不抛同步异常（会起定时器与后台检查）", async () => {
        const plugin = createPlugin(fake);
        await plugin.onload();

        // 只断言「不抛同步异常」：回调里是异步的定时器与网络检查，
        // 这里跑的是装配，不是那些行为本身。
        expect(() => fake.runLayoutReady()).not.toThrow();
    });
});

describe("移动端启动", () => {
    beforeEach(() => {
        __setDesktop(false);
    });

    it("onload 不抛错，且不创建同步模块", async () => {
        const plugin = createPlugin(fake);

        await expect(plugin.onload()).resolves.toBeUndefined();
        // 决策是 v1 不支持移动端 git（见 PLAN.md），所以这里是 undefined 而不是抛错。
        expect(plugin.sync).toBeUndefined();
        // 但安装器是纯 HTTP 的，移动端照常可用。
        expect(plugin.installer).toBeDefined();
    });

    it("不注册仓库同步视图（工厂函数会解引用 sync 模块）", async () => {
        const plugin = createPlugin(fake);
        await plugin.onload();

        expect(plugin.registered.views).not.toContain("obsync-sync-view");
        // 但图片管理视图**要**注册：图片模块移动端也装，而这是它在手机上
        // 唯一的图形入口（命令面板在手机上很难用）。
        expect(plugin.registered.views).toContain("obsync-image-view");
    });

    it("不注册同步命令，但保留安装器命令", async () => {
        const plugin = createPlugin(fake);
        await plugin.onload();

        const ids = plugin.registered.commands.map((command) => command.id);
        expect(ids).not.toContain("sync-now");
        expect(ids).toContain("add-plugin-repo");
    });

    it("不创建状态栏元素", async () => {
        const plugin = createPlugin(fake);
        await plugin.onload();

        expect(plugin.registered.statusBarItems).toBe(0);
    });

    /**
     * 图片同步模块**移动端也装** —— 与笔记同步（依赖系统 git，只装桌面端）相反。
     *
     * 它走的是 Obsidian 的 `requestUrl` + vault 文件读写，两者在移动端都有，
     * 所以「在手机上看笔记时图片能显示、裁剪压缩也能用」是成立的。
     * 这条断言与 `scripts/checks.mjs` 的「移动端安全」是两回事：那个查静态
     * 导入图有没有碰到 Node 依赖，这个查装配有没有真的把它装上。
     */
    it("装配图片同步模块（移动端也能裁剪 / 压缩图片）", async () => {
        const plugin = createPlugin(fake);
        await plugin.onload();

        expect(plugin.images).toBeDefined();
        expect(plugin.registered.postProcessors).toBe(1);
    });

    it("图片同步的四条命令在移动端也注册", async () => {
        const plugin = createPlugin(fake);
        await plugin.onload();

        const ids = plugin.registered.commands.map((command) => command.id);
        for (const id of ["sync-images", "preview-image-sync", "edit-image", "copy-image-link"]) {
            expect(ids, id).toContain(id);
        }
    });

    it("onunload 不抛错（sync 为 undefined）", async () => {
        const plugin = createPlugin(fake);
        await plugin.onload();

        expect(() => plugin.onunload()).not.toThrow();
    });
});
