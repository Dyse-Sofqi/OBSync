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
    id: "obsync",
    name: "OBSync",
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
        expect(plugin.secretStore).toBeDefined();
        expect(plugin.notifier).toBeDefined();
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
        // 两个图标：一个开同步面板，一个开安装器。原来只有一个，而它打开的是
        // 安装器 —— 于是「同步面板在哪」在界面上无解。
        expect(plugin.registered.ribbonIcons).toBe(2);
        // 状态栏元素由主类创建后传给 sync 模块 —— 这条断言锁的就是当年踩的那个坑
        // （挂到 workspace 上而不是 Plugin 上）。
        expect(plugin.registered.statusBarItems).toBe(1);
    });

    it("侧栏的同步图标真的会请求打开源码控制视图", async () => {
        const plugin = createPlugin(fake);
        await plugin.onload();

        const ribbons = plugin.registered.ribbons;
        expect(ribbons.map((ribbon) => ribbon.icon)).toEqual(["git-fork", "download"]);

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

    it("侧栏两个图标的悬停文案各自说清打开的是什么", async () => {
        const plugin = createPlugin(fake);
        await plugin.onload();

        const ribbons = plugin.registered.ribbons;

        expect(ribbons[0]!.title).toBe(plugin.t.plugin.ribbonSync);
        expect(ribbons[1]!.title).toBe(plugin.t.plugin.ribbonInstaller);
        expect(ribbons[0]!.title).not.toBe(ribbons[1]!.title);
    });

    it("注册了源码控制视图", async () => {
        const plugin = createPlugin(fake);
        await plugin.onload();

        expect(plugin.registered.views).toContain("obsync-sync-view");
    });

    it("所有命令名都带插件名前缀（否则命令面板里搜不到）", async () => {
        const plugin = createPlugin(fake);
        await plugin.onload();

        const commands = plugin.registered.commands;
        expect(commands.length).toBeGreaterThan(0);

        for (const command of commands) {
            expect(command.name, `${command.id} 缺少 OBSync 前缀`).toMatch(/^OBSync/);
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

    it("不注册源码控制视图（工厂函数会解引用 sync 模块）", async () => {
        const plugin = createPlugin(fake);
        await plugin.onload();

        expect(plugin.registered.views).not.toContain("obsync-sync-view");
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

    it("onunload 不抛错（sync 为 undefined）", async () => {
        const plugin = createPlugin(fake);
        await plugin.onload();

        expect(() => plugin.onunload()).not.toThrow();
    });
});
