import { beforeEach, describe, expect, it } from "vitest";
import type { App } from "obsidian";
import { createdSettings, resetCreatedSettings } from "../stubs/obsidian";
import { normalizeSettings } from "../../src/core/settings";
import { zhCN } from "../../src/core/i18n/locales/zh-cn";
import { Notifier } from "../../src/core/notice";
import { SecretStore } from "../../src/core/secretStore";
import type { InstallerService } from "../../src/features/installer/installerService";
import type { UpdateChecker } from "../../src/features/installer/updateChecker";
import { ObsyncSettingsTab } from "../../src/settingsTab";
import { createFakeApp, type FakeApp } from "../helpers/fakeApp";

/**
 * 设置页的**渲染冒烟**（安装器那一页）。
 *
 * 这页没有别的测试：它依赖真实 DOM 与 Obsidian 的设置页组件，节点环境里只能
 * 验证「渲染不抛错 + 关键行在场」。之所以值得单独跑一遍，是因为启动冒烟
 * （`pluginBoot.test.ts`）的教训：**装配/渲染里的 TypeError 只有真机才会暴露**，
 * 而设置页是用户每天要点的地方。
 *
 * 这里不测交互（那需要更完整的 fake 组件），只把「这一页能不能画出来」钉住 ——
 * 加上 `describeSelfState` 覆盖的文案逻辑，就够拦住常见的回归了。
 */

/**
 * @param raw 原始设置（会被 `normalizeSettings` 归一化）。默认空对象 ——
 * 只有「仓库同步页」的用例需要构造特定的拉取策略，其余页面用默认值就够。
 */
function createTab(fake: FakeApp, raw: Record<string, unknown> = {}): ObsyncSettingsTab {
    const settings = normalizeSettings(raw);
    const notifier = new Notifier({ getShowNotices: () => true, getT: () => zhCN });

    const plugin = {
        app: fake.app,
        manifest: { id: "obsync", version: "0.9.0" },
        t: zhCN,
        settings,
        notifier,
        // 同步那一页先问这个。为 false（移动端）时它只画一行说明就 return，
        // 于是「仓库同步页」的用例什么也验不到 —— 必须为 true。
        isSyncAvailable: true,
        secretStore: new SecretStore(fake.app),
        // `commit()` 会调这两个。**必须真的记一笔**：不记的话
        // 「拨了开关有没有生效」这件事就验不了 —— 而设置页最容易犯的错正是
        // 「改了值但没落盘 / 没重算派生状态」（那表现为「拨了没用」）。
        saved: 0,
        applied: 0,
        async saveSettings(): Promise<void> {
            plugin.saved += 1;
        },
        applyDerivedSettings(): void {
            plugin.applied += 1;
        },
        // 渲染阶段只用到这两个协作者的**存在**（点击回调查用），这里不构造它们。
        installer: {
            service: {} as InstallerService,
            checker: {} as UpdateChecker,
        },
    };

    return new ObsyncSettingsTab(plugin as never);
}

function renderInstallerPage(tab: ObsyncSettingsTab): void {
    // 私有方法：这些用例只关心「这一页画得出来」，不引入设置页的页签切换机制。
    (tab as unknown as { renderInstaller(): void }).renderInstaller();
}

beforeEach(() => {
    resetCreatedSettings();
});

describe("设置页 · 安装器页", () => {
    it("渲染不抛错，且模型里的每一行都在", () => {
        const fake = createFakeApp();
        const tab = createTab(fake);

        expect(() => renderInstallerPage(tab)).not.toThrow();

        const names = createdSettings.map((setting) => setting.name);
        expect(names).toContain(zhCN.settings.installer.heading);
        expect(names).toContain(zhCN.settings.installer.enabled);
        expect(names).toContain(zhCN.settings.installer.mirrorDiscovery);
        expect(names).toContain(zhCN.settings.installer.selfHeading);
    });

    it("「OBSync 自身」一节有检查更新与更新两个按钮", () => {
        const fake = createFakeApp();
        const tab = createTab(fake);

        renderInstallerPage(tab);

        const selfRow = createdSettings.find(
            (setting) => setting.name === zhCN.settings.installer.selfHeading
        );
        expect(selfRow?.buttons.map((button) => button.text)).toEqual([
            zhCN.installer.checkOne,
            zhCN.installer.updateToLatest,
        ]);
    });

    it("状态行显示当前版本（还没查过时）", () => {
        const fake = createFakeApp();
        const tab = createTab(fake);

        renderInstallerPage(tab);

        const container = (tab as unknown as { containerEl: { children: unknown[] } }).containerEl;
        const texts = (container.children as Array<{ text?: string }>).map(
            (child) => child.text ?? ""
        );

        expect(texts).toContain(zhCN.installer.selfNotChecked("0.9.0"));
    });

    it("有待重启标记时，状态行显示的是「重启后生效」而不是版本号", () => {
        const fake = createFakeApp();
        const tab = createTab(fake);
        // 直接改设置对象：等价于「上次更新完还没重启」
        (tab as unknown as { obsync: { settings: ReturnType<typeof normalizeSettings> } }).obsync.settings.installer.pendingRestartVersion = "0.9.1";

        renderInstallerPage(tab);

        const container = (tab as unknown as { containerEl: { children: unknown[] } }).containerEl;
        const texts = (container.children as Array<{ text?: string }>).map(
            (child) => child.text ?? ""
        );

        expect(texts).toContain(zhCN.installer.selfPendingRestart("0.9.1"));
    });

    it("app 只是被透传（这页不碰 vault）", () => {
        const fake = createFakeApp();
        const tab = createTab(fake);

        // 真正的意图是断言上面那些构造不需要真实 vault —— 这里只确认 app 到了位
        expect((tab as unknown as { app: App }).app).toBe(fake.app);
    });
});

/**
 * 设置页「通用」标签。
 *
 * 这一页此前**一个用例都没有**（上面那组是安装器页）。这里补上状态栏全宽那个开关：
 * 它在不在、默认值对不对、拨动之后设置**真的被写进去**。
 *
 * 「写进去了没有」必须验：设置页里 toggle 的 `onChange` 忘了赋值 / 忘了 `commit()`
 * 都是很容易犯的错，而那种错在界面上只表现为「拨了开关没用」——
 * 与当年那个「启用笔记同步」的死开关是同一类问题（见第三节的检查 6）。
 */
describe("设置页 · 通用页", () => {
    function renderGeneralPage(tab: ObsyncSettingsTab): void {
        (tab as unknown as { renderGeneral(): void }).renderGeneral();
    }

    it("渲染不抛错，且三行都在（提示 / 调试日志 / 状态栏全宽）", () => {
        const fake = createFakeApp();
        const tab = createTab(fake);

        expect(() => renderGeneralPage(tab)).not.toThrow();

        const names = createdSettings.map((setting) => setting.name);
        expect(names).toContain(zhCN.settings.general.showNotices);
        expect(names).toContain(zhCN.settings.general.debugLogging);
        expect(names).toContain(zhCN.settings.general.statusBarFullWidth);
    });

    it("状态栏全宽默认是**开着**的（加开关不该悄悄改掉所有人的界面）", () => {
        const fake = createFakeApp();
        const tab = createTab(fake);

        renderGeneralPage(tab);

        const row = createdSettings.find(
            (setting) => setting.name === zhCN.settings.general.statusBarFullWidth
        );
        expect(row?.toggles[0]?.value).toBe(true);
        expect(row?.desc).toBe(zhCN.settings.general.statusBarFullWidthDesc);
    });

    it("拨动开关会把设置**真的写进去**，并立刻重算派生状态（不用重载插件）", async () => {
        const fake = createFakeApp();
        const tab = createTab(fake);
        const plugin = (
            tab as unknown as {
                obsync: {
                    settings: ReturnType<typeof normalizeSettings>;
                    saved: number;
                    applied: number;
                };
            }
        ).obsync;

        renderGeneralPage(tab);
        const row = createdSettings.find(
            (setting) => setting.name === zhCN.settings.general.statusBarFullWidth
        );

        row!.toggles[0]!.toggle(false);
        await Promise.resolve();

        expect(plugin.settings.statusBarFullWidth).toBe(false);
        // 落盘 + 重算派生状态（后者才会给 body 加/摘那个类 —— 见 pluginBoot 的用例）
        expect(plugin.saved).toBe(1);
        expect(plugin.applied).toBe(1);
    });
});

/**
 * 设置页「仓库同步」标签。
 *
 * 这一页此前也没有用例。这里钉住两件事，都是**组合条件**才出问题的地方：
 *
 * 1. 注意事项在标题正下方 —— 它说的是「这样配会丢东西」，位置错了（比如沉到
 *    页面底部）就等于没写。
 * 2. 策略为「重置」时总开关被禁用且换了描述。这是 UI 那一半；**真正拦住定时器
 *    的是 `Automatics.start()`**，那条在 `automatics.test.ts` 里单独测 ——
 *    只测这里会漏掉「库里已经存着 enabled + reset」的用户（他们根本不碰设置页）。
 */
describe("设置页 · 仓库同步页", () => {
    /** DOM shim 记下的节点形状（见 `tests/setup.ts`）。 */
    type ShimEl = {
        cls?: string;
        text?: string;
        children?: ShimEl[];
    };

    function renderSyncPage(tab: ObsyncSettingsTab): void {
        (tab as unknown as { renderSync(): void }).renderSync();
    }

    function childrenOf(tab: ObsyncSettingsTab): ShimEl[] {
        const container = (tab as unknown as { containerEl: { children: unknown[] } }).containerEl;
        return container.children as ShimEl[];
    }

    it("渲染不抛错，且注意事项紧跟在「仓库同步」标题下面", () => {
        const fake = createFakeApp();
        const tab = createTab(fake);

        expect(() => renderSyncPage(tab)).not.toThrow();

        const heading = createdSettings.find(
            (setting) => setting.name === zhCN.settings.sync.heading
        );
        const children = childrenOf(tab);
        const headingIndex = children.indexOf(heading!.settingEl as unknown as ShimEl);

        // 「标题正下方」＝ 紧邻的下一个节点。被挪到页面别处这条就红。
        expect(children[headingIndex + 1]?.cls).toBe("obsync-sync-notes");
    });

    it("注意事项里是 locale 里的那两条，标题也在", () => {
        const fake = createFakeApp();
        const tab = createTab(fake);

        renderSyncPage(tab);

        const notes = childrenOf(tab).find((child) => child.cls === "obsync-sync-notes");
        const [heading, list] = notes!.children!;

        expect(heading?.cls).toBe("obsync-sync-notes-heading");
        expect(heading?.text).toBe(zhCN.settings.sync.notesHeading);
        // 逐条比对，而不是只看「有一条」：漏掉 reset 那条就等于没写。
        expect(list?.children?.map((item) => item.text)).toEqual(zhCN.settings.sync.notes);
    });

    it("策略为「重置」时总开关被禁用，描述说明为什么", () => {
        const fake = createFakeApp();
        const tab = createTab(fake, { sync: { syncStrategy: "reset" } });

        renderSyncPage(tab);

        const row = createdSettings.find((setting) => setting.name === zhCN.settings.sync.enabled);
        expect(row?.toggles[0]?.disabled).toBe(true);
        expect(row?.desc).toBe(zhCN.settings.sync.enabledSuspendedByReset);
    });

    it("策略不是「重置」时开关可用，描述是常规说明", () => {
        const fake = createFakeApp();
        const tab = createTab(fake);

        renderSyncPage(tab);

        const row = createdSettings.find((setting) => setting.name === zhCN.settings.sync.enabled);
        expect(row?.toggles[0]?.disabled).toBe(false);
        expect(row?.desc).toBe(zhCN.settings.sync.enabledDesc);
    });

    it("开关被禁用时**值不被改写** —— 改回「合并」后才会自动恢复", () => {
        const fake = createFakeApp();
        const tab = createTab(fake, { sync: { enabled: true, syncStrategy: "reset" } });

        renderSyncPage(tab);

        const row = createdSettings.find((setting) => setting.name === zhCN.settings.sync.enabled);
        // 灰掉的是「能不能拨」，不是「值是多少」。若这里被写成 setValue(false)，
        // 用户改回 merge 之后自动同步就再也不会自己恢复 —— 而文案承诺了会。
        expect(row?.toggles[0]?.value).toBe(true);
    });
});
