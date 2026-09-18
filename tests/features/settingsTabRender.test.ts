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

function createTab(fake: FakeApp): ObsyncSettingsTab {
    const settings = normalizeSettings({});
    const notifier = new Notifier({ getShowNotices: () => true, getT: () => zhCN });

    const plugin = {
        app: fake.app,
        manifest: { id: "obsync", version: "0.9.0" },
        t: zhCN,
        settings,
        notifier,
        secretStore: new SecretStore(fake.app),
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
