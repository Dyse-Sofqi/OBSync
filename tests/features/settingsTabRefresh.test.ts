import { beforeEach, describe, expect, it } from "vitest";
import { createdSettings, resetCreatedSettings } from "../stubs/obsidian";
import { normalizeSettings } from "../../src/core/settings";
import { zhCN } from "../../src/core/i18n/locales/zh-cn";
import { Notifier } from "../../src/core/notice";
import { SecretStore } from "../../src/core/secretStore";
import type { InstallerService } from "../../src/features/installer/installerService";
import type { UpdateChecker } from "../../src/features/installer/updateChecker";
import type { InstallResult, TrackedItem } from "../../src/features/installer/types";
import { ObsyncSettingsTab } from "../../src/settingsTab";
import { createFakeApp, type FakeApp } from "../helpers/fakeApp";

/**
 * 安装成功后，「已跟踪」列表的刷新时机。
 *
 * 弹窗关闭不会让 Obsidian 重新渲染底下的设置页，而列表内容是在渲染时从
 * settings 里读出来的 —— 「装完立刻看见新条目」只能由安装成功回调里那次重绘保证。
 * 曾经这里传的是个空回调（注释还写着「设置页下次渲染时自然带上」），实际表现是：
 * 新装的插件不出现在列表里，得点一次「检查全部更新」（它结尾会 `display()`）才冒出来。
 *
 * 所以这个文件驱动的是「头部栏按钮 → 弹窗 → 回调 → 重绘」整条线，断言的不是
 * 某个函数被调用过，而是**列表里真的出现了新条目**。
 */

interface TabHandle {
    tab: ObsyncSettingsTab;
    /** 弹窗被打开时收到的「安装成功」回调（没打开过就是 undefined）。 */
    onInstalled(): ((result: InstallResult) => void) | undefined;
}

function createTab(fake: FakeApp): TabHandle {
    const notifier = new Notifier({ getShowNotices: () => true, getT: () => zhCN });

    let captured: ((result: InstallResult) => void) | undefined;

    const plugin = {
        app: fake.app,
        manifest: { id: "obsync", version: "0.9.0" },
        t: zhCN,
        settings: normalizeSettings({}),
        notifier,
        secretStore: new SecretStore(fake.app),
        installer: {
            service: {} as InstallerService,
            // 打开设置页会触发自动检查（见 autoCheckOnOpen）—— 给一个「没有更新」的
            // 实现，否则自动检查会撞在空对象上变成未捕获的 Promise 拒绝。
            checker: {
                checkAll: async () => ({ outdated: 0, failed: 0, results: [] }),
            } as unknown as UpdateChecker,
            openAddRepoModal: (callback: (result: InstallResult) => void) => {
                captured = callback;
            },
        },
    };

    return {
        tab: new ObsyncSettingsTab(plugin as never),
        onInstalled: () => captured,
    };
}

/** 按下头部栏最左边的「添加插件仓库」按钮（三个主操作里的第一个）。 */
function clickAddRepoButton(tab: ObsyncSettingsTab): void {
    (tab as unknown as { renderTrackedTab(): void }).renderTrackedTab();

    const header = createdSettings.find(
        (setting) => setting.name === zhCN.settings.installer.tracked
    );
    if (!header) throw new Error("渲染出来的内容里找不到「已跟踪」头部栏");
    header.buttons[0]!.click();
}

/** 刚装好的那条记录 —— 真实流程里由 service 写进 settings（见 recordItem）。 */
function installedRecord(): TrackedItem {
    return {
        kind: "plugin",
        host: "github",
        owner: "owner",
        repo: "demo",
        id: "demo",
        name: "Demo Plugin",
        installedVersion: "1.0.0",
        requestedVersion: "latest",
        frozen: false,
        channel: "release",
        installedAt: 0,
    };
}

function installResult(): InstallResult {
    return {
        manifest: {
            id: "demo",
            name: "Demo Plugin",
            version: "1.0.0",
            minAppVersion: "1.0.0",
        },
        channel: "release",
        version: "1.0.0",
        replaced: false,
        enabled: true,
        repoRef: { host: "github", owner: "owner", repo: "demo" },
    };
}

beforeEach(() => {
    resetCreatedSettings();
});

describe("设置页 · 安装成功后的列表刷新", () => {
    it("「添加插件仓库」把重绘交给弹窗（不交的话列表永远停在旧内容上）", () => {
        const { tab, onInstalled } = createTab(createFakeApp());

        clickAddRepoButton(tab);

        expect(onInstalled()).toBeTypeOf("function");
    });

    it("安装成功回调触发后，新装的条目立刻出现在列表里", () => {
        const fake = createFakeApp();
        const { tab, onInstalled } = createTab(fake);

        clickAddRepoButton(tab);
        const callback = onInstalled()!;

        // 安装成功：记录已经落在 settings 里，接下来该由回调负责让它可见。
        (tab as unknown as { obsync: { settings: ReturnType<typeof normalizeSettings> } })
            .obsync.settings.installer.tracked.push(installedRecord());

        resetCreatedSettings();
        callback(installResult());

        const names = createdSettings.map((setting) => setting.name);
        expect(names).toContain("Demo Plugin");
    });

    it("重绘走的是设置页自己的渲染（标签栏也随之更新，计数不会落后）", () => {
        const fake = createFakeApp();
        const { tab, onInstalled } = createTab(fake);

        clickAddRepoButton(tab);
        const callback = onInstalled()!;
        (tab as unknown as { obsync: { settings: ReturnType<typeof normalizeSettings> } })
            .obsync.settings.installer.tracked.push(installedRecord());

        resetCreatedSettings();
        callback(installResult());

        // 标签栏也在这次重绘里重建了 —— 「已跟踪」上的计数跟着 settings 走
        const container = (tab as unknown as { containerEl: { children: unknown[] } }).containerEl;
        const tabs = container.children[0] as unknown as {
            children: Array<{ text?: string; children?: Array<{ text?: string }> }>;
        };
        const trackedTab = tabs.children.find((child) => child.text === zhCN.settings.tabs.tracked);
        const counts = (trackedTab?.children ?? []).map((child) => child.text);
        expect(counts).toContain("1");
    });
});
