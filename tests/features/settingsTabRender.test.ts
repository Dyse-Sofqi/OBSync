import { beforeEach, describe, expect, it } from "vitest";
import type { App } from "obsidian";
import { createdSettings, openedModals, resetCreatedSettings, resetOpenedModals } from "../stubs/obsidian";
import { normalizeSettings, type ObsyncSettings } from "../../src/core/settings";
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
 * @param sync 同步模块的替身。不传时 `this.obsync.sync` 是 undefined ——
 * 那正是移动端 / 装配失败时的状态，「仓库同步页」必须能扛住它。
 */
function createTab(
    fake: FakeApp,
    raw: Record<string, unknown> = {},
    sync?: unknown
): ObsyncSettingsTab {
    const settings = normalizeSettings(raw);
    const notifier = new Notifier({ getShowNotices: () => true, getT: () => zhCN });

    const plugin = {
        app: fake.app,
        manifest: { id: "ob-sync", version: "0.9.0" },
        t: zhCN,
        settings,
        notifier,
        // 同步那一页先问这个。为 false（移动端）时它只画一行说明就 return，
        // 于是「仓库同步页」的用例什么也验不到 —— 必须为 true。
        isSyncAvailable: true,
        secretStore: new SecretStore(fake.app),
        sync,
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

/**
 * 让「先渲染、再异步读内容」那条路（`.gitignore` 一节）跑完。
 *
 * 设置页的渲染是同步的，而读文件是异步的 —— 不 await 就断言不到读回来的内容。
 */
async function flush(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * `.gitignore` 代码框 —— 挂在页面上的块级 `textarea`（不是 `Setting` 的控件）。
 *
 * 之所以要单独一个类型：放进 `.setting-item-control` 只有右侧几百像素宽，
 * 读不了规则清单（用户原话：「只占了右侧有限空间，太丑了」），所以它是裸 DOM
 * 节点，`value` 与 `trigger` 都得自己按 shim 的形状声明。
 */
type TextAreaEl = {
    cls?: string;
    /** shim 的 `createEl` 会记下标签名 —— 用它证明它真的是 `textarea`。 */
    tagName?: string;
    value: string;
    /** 内联样式（宽度与 box-sizing 在 JS 里写了一份）。 */
    style?: Record<string, string>;
    trigger: (name: string, ...args: unknown[]) => void;
};

beforeEach(() => {
    resetCreatedSettings();
    resetOpenedModals();
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

    it("「SyncHub 自身」一节有检查更新与更新两个按钮", () => {
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

    it("「SyncHub 自身」一节有「更新来源」输入框，初值来自设置", () => {
        const fake = createFakeApp();
        const tab = createTab(fake, {
            installer: { selfUpdateSource: "https://gitee.com/sofqi/SyncHub" },
        });

        renderInstallerPage(tab);

        const row = createdSettings.find(
            (setting) => setting.name === zhCN.settings.installer.selfSource
        );
        expect(row).toBeDefined();
        expect(row?.desc).toBe(zhCN.settings.installer.selfSourceDesc);
        expect(row?.texts[0]?.value).toBe("https://gitee.com/sofqi/SyncHub");
    });

    it("改「更新来源」会**真的写进设置**（否则「填了没用」），并去掉首尾空白", async () => {
        const fake = createFakeApp();
        const tab = createTab(fake);
        const plugin = (
            tab as unknown as {
                obsync: { settings: ReturnType<typeof normalizeSettings>; saved: number };
            }
        ).obsync;

        renderInstallerPage(tab);
        const row = createdSettings.find(
            (setting) => setting.name === zhCN.settings.installer.selfSource
        );

        // 带首尾空白：从浏览器地址栏复制时经常带上，而它会让 parseRepoRef 解析失败
        row!.texts[0]!.type("  https://gitee.com/sofqi/SyncHub  ");
        await Promise.resolve();

        expect(plugin.settings.installer.selfUpdateSource).toBe("https://gitee.com/sofqi/SyncHub");
        expect(plugin.saved).toBe(1);
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

    /**
     * `.gitignore` 那一节（2026-09-24）。
     *
     * 这是设置页上**唯一能直接改文件内容**的地方，所以三件事都要钉住：
     * 内容真的显示出来了、改完真的写进磁盘了、写失败时用户知道「没写下去」。
     * 只验「渲染不抛错」等于没验 —— 一个连不上任何东西的输入框看起来完全一样。
     */
    describe(".gitignore 一节", () => {
        /** 同步模块的替身：只实现这一节用到的那三个方法，并把写入记下来。 */
        function createSyncStub(initial?: string) {
            const stub = {
                writes: [] as string[],
                opened: 0,
                /** `openGitignore` 的返回值 —— false 模拟「Obsidian 打不开它」。 */
                openResult: true,
                /** 设了就让读失败。 */
                readError: undefined as Error | undefined,
                /** 设了就让写失败（模拟磁盘/权限问题）。 */
                writeError: undefined as Error | undefined,
                content: initial,
                service: {
                    async readGitignore(): Promise<string | undefined> {
                        if (stub.readError) throw stub.readError;
                        return stub.content;
                    },
                    async writeGitignore(value: string): Promise<void> {
                        if (stub.writeError) throw stub.writeError;
                        stub.writes.push(value);
                        stub.content = value;
                    },
                    async openGitignore(): Promise<boolean> {
                        stub.opened += 1;
                        return stub.openResult;
                    },
                },
            };
            return stub;
        }

        /** 状态徽标挂在标题那一行的 `nameEl` 上。 */
        function statusText(): string | undefined {
            const setting = createdSettings.find(
                (item) => item.name === zhCN.settings.sync.gitignoreHeading
            );
            const nameEl = setting?.nameEl as unknown as { children?: Array<{ text?: string }> };
            return nameEl?.children?.[0]?.text;
        }

        /**
         * 代码框是**挂在页面上的块级 `textarea`**，不是 `Setting` 的控件
         * （放进 `.setting-item-control` 只有右侧几百像素宽，读不了规则清单）。
         * 所以它从 `containerEl.children` 里按类名找，而不是从 `createdSettings`。
         */
        function gitignoreArea(tab: ObsyncSettingsTab): TextAreaEl {
            const container = (tab as unknown as { containerEl: { children: TextAreaEl[] } })
                .containerEl;
            const found = container.children.find((child) => child.cls === "obsync-gitignore");
            expect(found, "页面上没有找到 .gitignore 代码框").toBeDefined();
            return found as unknown as TextAreaEl;
        }

        /** 模拟用户输入（真实 DOM 里 `input` 事件）。 */
        function typeIn(area: TextAreaEl, value: string): void {
            area.value = value;
            area.trigger("input");
        }

        function saveButton() {
            return createdSettings
                .flatMap((setting) => setting.buttons)
                .find((button) => button.text === zhCN.settings.sync.gitignoreSave)!;
        }

        it("代码框是块级 textarea **直接挂在页面上**，不是 `Setting` 的控件", () => {
            // 用户原话：「.gitignore的编辑框只占了右侧有限空间，太丑了，应该全宽才对」。
            // `.setting-item-control` 在 Obsidian 的设置页里只有右侧几百像素宽，
            // 12 行的规则清单挤在里面根本没法读 —— 所以它必须是块级元素。
            const tab = createTab(createFakeApp(), {}, createSyncStub("# 规则\n"));

            renderSyncPage(tab);

            const area = gitignoreArea(tab);
            expect(area.tagName).toBe("TEXTAREA");
            // 一个 `Setting` 控件都没占：它不可能被塞进某个控件区
            expect(createdSettings.flatMap((setting) => setting.textAreas)).toHaveLength(0);
        });

        /**
         * 宽度**只能来自 CSS 类**，不能是内联样式。
         *
         * 社区审核的 `obsidianmd/no-static-styles-assignment` 会拦下
         * `el.style.width = "100%"`（以及 `setCssProps({ width })` —— 那条规则只放行
         * `--*` 自定义属性）。用户实测反馈过两次「全宽并没有实现」，最后一次的原因
         * 正是内联宽度；现在改成类 + 样式表，并由 `.hotreload` 标记保证样式表会重载。
         */
        it("宽度来自 CSS 类，**不写内联样式**（审核会拦）", () => {
            const tab = createTab(createFakeApp(), {}, createSyncStub("# 规则\n"));

            renderSyncPage(tab);

            const area = gitignoreArea(tab);
            expect(area.cls).toBe("obsync-gitignore");
            expect(Object.keys(area.style ?? {})).toHaveLength(0);
        });

        it("文件已经存在时：内容显示在框里，徽标是「已保存」", async () => {
            const sync = createSyncStub("# 我的规则\n.obsidian/workspace.json\n");
            const tab = createTab(createFakeApp(), {}, sync);

            renderSyncPage(tab);
            await flush();

            expect(gitignoreArea(tab).value).toBe(
                "# 我的规则\n.obsidian/workspace.json\n"
            );
            expect(statusText()).toBe(zhCN.settings.sync.gitignoreSaved);
            // 没有未保存的改动 → 保存按钮置灰（点了什么都不发生只会让人怀疑它坏了）
            expect(saveButton().disabled).toBe(true);
        });

        it("文件还不存在时：框是空的、徽标是「尚未创建」，且**不自动建文件**", async () => {
            const sync = createSyncStub(undefined);
            const tab = createTab(createFakeApp(), {}, sync);

            renderSyncPage(tab);
            await flush();

            expect(gitignoreArea(tab).value).toBe("");
            expect(statusText()).toBe(zhCN.settings.sync.gitignoreMissing);
            // 打开设置页不该往用户库里多出一个文件
            expect(sync.writes).toEqual([]);
        });

        it("改内容 → 徽标变「有未保存的修改」，保存按钮可用；点保存真的写盘", async () => {
            const sync = createSyncStub("# 旧\n");
            const tab = createTab(createFakeApp(), {}, sync);

            renderSyncPage(tab);
            await flush();

            typeIn(gitignoreArea(tab), "# 新\n*.tmp\n");
            expect(statusText()).toBe(zhCN.settings.sync.gitignoreDirty);
            expect(saveButton().disabled).toBe(false);

            await saveButton().click();

            expect(sync.writes).toEqual(["# 新\n*.tmp\n"]);
            expect(statusText()).toBe(zhCN.settings.sync.gitignoreSaved);
            expect(saveButton().disabled).toBe(true);
        });

        it("失焦也会保存（不点按钮就点到别处不会丢）", async () => {
            const sync = createSyncStub("# 旧\n");
            const tab = createTab(createFakeApp(), {}, sync);

            renderSyncPage(tab);
            await flush();

            const area = gitignoreArea(tab);
            typeIn(area, "# 忘了点保存\n");
            area.trigger("blur");
            await flush();

            expect(sync.writes).toEqual(["# 忘了点保存\n"]);
        });

        it("写失败时**说清磁盘上还是旧内容**，且徽标仍显示有未保存的改动", async () => {
            const sync = createSyncStub("# 旧\n");
            sync.writeError = new Error("EACCES");
            const tab = createTab(createFakeApp(), {}, sync);
            const notifier = (tab as unknown as { obsync: { notifier: { reportError: unknown } } })
                .obsync.notifier;
            const reported: unknown[] = [];
            notifier.reportError = (error: unknown) => reported.push(error);

            renderSyncPage(tab);
            await flush();

            typeIn(gitignoreArea(tab), "# 写不下去\n");
            await saveButton().click();

            expect(reported).toHaveLength(1);
            // 不能翻成「已保存」—— 用户会以为改完了，而 git 那边一点没变
            expect(statusText()).toBe(zhCN.settings.sync.gitignoreDirty);
        });

        it("「填入默认内容」只填进框里，**不直接覆盖磁盘**", async () => {
            // 覆盖掉用户自己的规则是数据损失 —— 要让他先看一眼再决定保存。
            const sync = createSyncStub("# 用户自己的规则\n");
            const tab = createTab(createFakeApp(), {}, sync);

            renderSyncPage(tab);
            await flush();

            const restore = createdSettings
                .flatMap((setting) => setting.buttons)
                .find((button) => button.text === zhCN.settings.sync.gitignoreRestore)!;
            restore.click();

            // 模板按**本库的配置目录名**展开（可以不是 `.obsidian`）
            const configDir = (tab.app as { vault: { configDir: string } }).vault.configDir;
            expect(gitignoreArea(tab).value).toBe(zhCN.sync.gitignoreTemplate(configDir));
            expect(sync.writes).toEqual([]);
            expect(statusText()).toBe(zhCN.settings.sync.gitignoreDirty);
        });

        it("「在编辑器中打开」走服务（而不是自己拼一条路径）", async () => {
            const sync = createSyncStub("# 规则\n");
            const tab = createTab(createFakeApp(), {}, sync);

            renderSyncPage(tab);
            await flush();

            const open = createdSettings
                .flatMap((setting) => setting.buttons)
                .find((button) => button.text === zhCN.settings.sync.gitignoreOpen)!;
            await open.click();

            expect(sync.opened).toBe(1);
        });

        /**
         * Obsidian 的库索引里不一定有以点开头的文件 —— 那时 `openGitignore` 打不开它。
         * **点了没反应**是最容易被当成「插件坏了」的一种失败，所以必须说一句，
         * 并且把用户指回上面那个确实能改的框。
         */
        it("打不开时给一句说明（而不是点了没反应）", async () => {
            const sync = createSyncStub("# 规则\n");
            sync.openResult = false;
            const tab = createTab(createFakeApp(), {}, sync);
            const warnings: string[] = [];
            (
                tab as unknown as { obsync: { notifier: { warn: (message: string) => void } } }
            ).obsync.notifier.warn = (message) => warnings.push(message);

            renderSyncPage(tab);
            await flush();

            await createdSettings
                .flatMap((setting) => setting.buttons)
                .find((button) => button.text === zhCN.settings.sync.gitignoreOpen)!
                .click();

            expect(warnings).toEqual([zhCN.sync.gitignoreOpenFailed]);
        });

        it("读失败不让整页崩：徽标留在「尚未创建」，框仍然可用", async () => {
            const sync = createSyncStub();
            sync.readError = new Error("EIO");
            const tab = createTab(createFakeApp(), {}, sync);

            expect(() => renderSyncPage(tab)).not.toThrow();
            await flush();

            expect(statusText()).toBe(zhCN.settings.sync.gitignoreMissing);
        });

        it("没有装配同步模块时这一节**不渲染**（移动端不会看到一堆点了没反应的按钮）", () => {
            const tab = createTab(createFakeApp());

            renderSyncPage(tab);

            expect(
                createdSettings.find(
                    (setting) => setting.name === zhCN.settings.sync.gitignoreHeading
                )
            ).toBeUndefined();
        });
    });
});

/**
 * 图片同步页。
 *
 * 这一页比别的页更值得渲染冒烟：它是**唯一能让用户指定「插件能动哪些文件」**
 * 的地方，而那一格填错的表现是「一个文件都不动」或「动了不该动的」——
 * 两种都没有任何提示。所以除了「画得出来」，这里还验「改了就真的写进设置」
 * 与「归一之后才写」。
 */
describe("设置页 · 图片同步页", () => {
    type ShimEl = { cls?: string; text?: string; children?: ShimEl[] };

    function renderImagesPage(tab: ObsyncSettingsTab): void {
        (tab as unknown as { renderImages(): void }).renderImages();
    }

    function childrenOf(tab: ObsyncSettingsTab): ShimEl[] {
        const container = (tab as unknown as { containerEl: { children: unknown[] } }).containerEl;
        return container.children as ShimEl[];
    }

    function row(name: string) {
        return createdSettings.find((setting) => setting.name === name);
    }

    /** 设置页的落盘计数（`commit()` 会 +1）。 */
    function saveCount(tab: ObsyncSettingsTab): number {
        return (tab as unknown as { obsync: { saved: number } }).obsync.saved;
    }

    /** 设置页持有的是**插件对象**，设置从它上面取（不是 `tab.settings`）。 */
    function settingsOf(tab: ObsyncSettingsTab): ObsyncSettings {
        return (tab as unknown as { obsync: { settings: ObsyncSettings } }).obsync.settings;
    }

    it("渲染不抛错，且注意事项紧跟在「图片同步」标题下面", () => {
        const tab = createTab(createFakeApp());

        expect(() => renderImagesPage(tab)).not.toThrow();

        const heading = row(zhCN.settings.images.heading);
        const children = childrenOf(tab);
        const headingIndex = children.indexOf(heading!.settingEl as unknown as ShimEl);

        // 「标题正下方」＝ 紧邻的下一个节点。被挪到页面别处这条就红。
        expect(children[headingIndex + 1]?.cls).toBe("obsync-image-notes");
    });

    it("注意事项逐条来自 locale（漏一条就等于没写）", () => {
        const tab = createTab(createFakeApp());
        renderImagesPage(tab);

        const notes = childrenOf(tab).find((child) => child.cls === "obsync-image-notes");
        const [heading, list] = notes!.children!;

        expect(heading?.text).toBe(zhCN.settings.images.notesHeading);
        expect(list?.children?.map((item) => item.text)).toEqual(zhCN.settings.images.notes);
    });

    /**
     * 默认值已经是仓库根目录，所以这行提示**不再**随默认设置出现。
     * 要验它，必须显式给一个空列表 —— 那才是「用户把文件夹全删了」的状态。
     */
    it("一个受管文件夹都没配时多一行说明（否则用户不知道下一步做什么）", () => {
        const tab = createTab(createFakeApp(), { images: { folders: [] } });
        renderImagesPage(tab);

        const hint = childrenOf(tab).find(
            (child) =>
                child.cls === "setting-item-description" &&
                child.text === zhCN.settings.images.foldersEmpty
        );
        expect(hint).toBeDefined();
    });

    it("配了文件夹之后那行提示消失", () => {
        const tab = createTab(createFakeApp(), { images: { folders: ["attachments"] } });
        renderImagesPage(tab);

        expect(
            childrenOf(tab).find((child) => child.text === zhCN.settings.images.foldersEmpty)
        ).toBeUndefined();
    });

    it("文件夹多行框的初值是一行一个", () => {
        const tab = createTab(createFakeApp(), {
            images: { folders: ["attachments", "assets/img"] },
        });
        renderImagesPage(tab);

        expect(row(zhCN.settings.images.folders)?.textAreas[0]?.value).toBe(
            "attachments\nassets/img"
        );
    });

    /**
     * 默认值是仓库根目录（整个库），归一后的形状是 `[""]`。
     *
     * 文本框里必须显示 `.`：一个空行读起来像「什么都没填」，而它正是默认值 ——
     * 用户会以为插件坏了，然后去手动填一个更窄的范围。
     */
    it("默认的仓库根目录在文本框里显示成 .", () => {
        const tab = createTab(createFakeApp());
        renderImagesPage(tab);

        expect(settingsOf(tab).images.folders).toEqual([""]);
        expect(row(zhCN.settings.images.folders)?.textAreas[0]?.value).toBe(".");
    });

    it("「浏览…」与「恢复默认」在同一行，紧跟文件夹设置", () => {
        const tab = createTab(createFakeApp());
        renderImagesPage(tab);

        // 这一行没有名称（与页面底部那排「测试 / 预览 / 立即同步」同一形状），
        // 所以按按钮文字找。
        const actionRow = createdSettings.find((setting) =>
            setting.buttons.some((button) => button.text === zhCN.settings.images.foldersBrowse)
        );
        expect(actionRow).toBeDefined();
        expect(actionRow!.buttons.map((button) => button.text)).toEqual([
            zhCN.settings.images.foldersBrowse,
            zhCN.settings.images.foldersReset,
        ]);
        expect(createdSettings.indexOf(actionRow!)).toBeGreaterThan(
            createdSettings.indexOf(row(zhCN.settings.images.folders)!)
        );
    });

    /**
     * 「恢复默认」把列表重置回仓库根目录。
     *
     * 两件事都要验：值**真的被改写**（而不是只重绘一遍），以及落盘 ——
     * 「改了没存」是设置页最容易犯的错，表现为「重置完重启又变回去」。
     */
    it("「恢复默认」把列表重置回仓库根目录，并落盘", async () => {
        const tab = createTab(createFakeApp(), {
            images: { folders: ["attachments", "assets/img"] },
        });
        renderImagesPage(tab);

        const before = saveCount(tab);
        const reset = createdSettings
            .find((setting) =>
                setting.buttons.some((button) => button.text === zhCN.settings.images.foldersReset)
            )!
            .buttons.find((button) => button.text === zhCN.settings.images.foldersReset)!;
        await reset.click();

        expect(settingsOf(tab).images.folders).toEqual([""]);
        expect(saveCount(tab)).toBe(before + 1);
    });

    it("已经是默认值时「恢复默认」置灰（点了什么都不发生，只会让人怀疑按钮坏了）", () => {
        const tab = createTab(createFakeApp());
        renderImagesPage(tab);

        const reset = createdSettings
            .find((setting) =>
                setting.buttons.some((button) => button.text === zhCN.settings.images.foldersReset)
            )!
            .buttons.find((button) => button.text === zhCN.settings.images.foldersReset)!;
        expect(reset.disabled).toBe(true);
    });

    /**
     * 「浏览…」的完整链路：点下去 → 弹出选择器 → 选中一个文件夹 → 并进受管
     * 列表（归一后）并落盘。
     *
     * 为什么要验到这一步：入口按钮最常见的坏法是「弹是弹了，选中之后什么都
     * 没有发生」—— 那在界面上只是「选完就没了」，没有任何提示。
     */
    it("点「浏览…」弹出选择器，选中后并进受管列表并落盘", async () => {
        const fake = createFakeApp({ "attachments/a.png": "x" });
        const tab = createTab(fake, { images: { folders: ["assets/img"] } });
        renderImagesPage(tab);

        const before = saveCount(tab);
        createdSettings
            .find((setting) =>
                setting.buttons.some((button) => button.text === zhCN.settings.images.foldersBrowse)
            )!
            .buttons.find((button) => button.text === zhCN.settings.images.foldersBrowse)!
            .click();

        // 拿到真弹窗：选择器的建议列表由 vault 的文件夹生成，
        // 所以「选了什么」不必手捏一个选项对象。
        const modal = openedModals.at(-1) as unknown as {
            getSuggestions: (query: string) => Array<{ path: string }>;
            onChooseSuggestion: (option: { path: string }) => void;
        };
        expect(modal).toBeDefined();

        const option = modal.getSuggestions("attach")[0]!;
        expect(option.path).toBe("attachments");
        modal.onChooseSuggestion(option);
        await Promise.resolve();

        expect(settingsOf(tab).images.folders).toEqual(["assets/img", "attachments"]);
        expect(saveCount(tab)).toBe(before + 1);
    });

    /**
     * 归一必须在**写的时候**做一次。
     *
     * 用户写 `/attachments/` 或留空行是常事，而没归一化的前缀会让范围判断
     * 悄悄失准 —— 表现是「填了却一个文件都不动」，且没有任何提示。
     */
    it("改文件夹会归一后再写进设置，并落盘", async () => {
        const tab = createTab(createFakeApp());
        renderImagesPage(tab);

        const before = saveCount(tab);
        await row(zhCN.settings.images.folders)?.textAreas[0]?.type(
            "/attachments/\n\nassets//img\n."
        );

        expect(settingsOf(tab).images.folders).toEqual(["attachments", "assets/img", ""]);
        // 「改了值但没落盘」是设置页最容易犯的错
        expect(saveCount(tab)).toBe(before + 1);
    });

    it("总开关的初值来自设置，拨动会写进设置", async () => {
        const tab = createTab(createFakeApp(), { images: { enabled: false } });
        renderImagesPage(tab);

        const toggle = row(zhCN.settings.images.enabled)?.toggles[0];
        expect(toggle?.value).toBe(false);

        await toggle?.toggle(true);
        expect(settingsOf(tab).images.enabled).toBe(true);
    });

    it("冲突策略下拉的初值来自设置，改它会写进设置", async () => {
        const tab = createTab(createFakeApp(), { images: { conflictPolicy: "remote" } });
        renderImagesPage(tab);

        const dropdown = row(zhCN.settings.images.conflictPolicy)?.dropdowns[0];
        expect(dropdown?.value).toBe("remote");

        await dropdown?.select("local");
        expect(settingsOf(tab).images.conflictPolicy).toBe("local");
    });

    /**
     * 这一页只有一个开关。
     *
     * 断言「有哪些开关」而不只是「某个开关在不在」：删除本地图片时的云端处置
     * 已经从开关改成下拉（`deleteRemotePolicy`），旧的询问开关必须**消失** ——
     * 留着它会是「能拨但没有任何作用」的假控件，而这个项目里正是靠「设置项
     * 无人读取」那类检查在防这个，那一项只扫 `core/settings.ts` 的字段，
     * 管不到界面上多出来的开关。
     */
    it("只有一个开关：启用（删除时的云端处置已经改成下拉）", () => {
        const tab = createTab(createFakeApp());
        renderImagesPage(tab);

        const toggleRows = createdSettings.filter((setting) => setting.toggles.length > 0);
        expect(toggleRows.map((setting) => setting.name)).toEqual([zhCN.settings.images.enabled]);
    });

    it("「删除本地图片时」下拉的初值来自设置，改它会写进设置", async () => {
        const tab = createTab(createFakeApp(), { images: { deleteRemotePolicy: "always" } });
        renderImagesPage(tab);

        const dropdown = row(zhCN.settings.images.deleteRemotePolicy)?.dropdowns[0];
        expect(dropdown?.value).toBe("always");

        await dropdown?.select("never");
        expect(settingsOf(tab).images.deleteRemotePolicy).toBe("never");
    });

    /**
     * 三个选项都必须在，且顺序固定（默认值排最前）。
     *
     * 少一个选项的下拉等于把用户锁在当前行为里；而顺序漂移会让「默认是哪一档」
     * 在视觉上变得不确定。
     */
    it("下拉的三个选项与默认值", () => {
        const tab = createTab(createFakeApp());
        renderImagesPage(tab);

        const dropdown = row(zhCN.settings.images.deleteRemotePolicy)?.dropdowns[0];
        expect(dropdown?.options).toEqual([
            { value: "ask", label: zhCN.settings.images.deleteRemoteAsk },
            { value: "always", label: zhCN.settings.images.deleteRemoteAlways },
            { value: "never", label: zhCN.settings.images.deleteRemoteNever },
        ]);
        expect(dropdown?.value).toBe("ask");
    });

    /**
     * Secret Access Key 这一行。
     *
     * 它**不在** `data.json` 里（走 `SecretStore`），所以「初值从哪儿来」与
     * 「保存按钮真的写进去了没有」这两件事必须验 —— 而后者尤其重要：
     * 用户粘完密钥最可能的下一步是直接点「测试连接」，若还没落盘，
     * 测的就是**旧值**，报出来的错会让人去怀疑一个根本没被使用的密钥。
     */
    describe("R2 密钥行", () => {
        /**
         * 状态徽标里的文字。
         *
         * 它挂在**那一行的 `nameEl`** 上（`renderR2Secret` 里 `setting.nameEl.createSpan`），
         * 所以从 `createdSettings` 里按名字找那一行即可 —— 不需要 tab 实例。
         */
        function statusText(): string | undefined {
            const setting = row(zhCN.settings.images.secretKey);
            const nameEl = setting?.nameEl as unknown as { children?: ShimEl[] };
            return nameEl?.children?.[0]?.text;
        }

        it("没配密钥时状态是「未配置」", () => {
            const tab = createTab(createFakeApp());
            renderImagesPage(tab);

            expect(statusText()).toBe(zhCN.settings.images.secretNotConfigured);
        });

        it("已经存过密钥时状态是「已配置」，且输入框里是那个值", () => {
            const fake = createFakeApp();
            fake.app.saveLocalStorage("obsync-token-r2", "secret-value");

            const tab = createTab(fake);
            renderImagesPage(tab);

            expect(statusText()).toBe(zhCN.settings.images.secretConfigured);
            expect(row(zhCN.settings.images.secretKey)?.texts[0]?.value).toBe("secret-value");
        });

        it("保存按钮把密钥写进 SecretStore，并把状态翻成「已配置」", () => {
            const fake = createFakeApp();
            const tab = createTab(fake);
            renderImagesPage(tab);

            const setting = row(zhCN.settings.images.secretKey)!;
            setting.texts[0]!.type("pasted-secret");
            setting.buttons[0]!.click();

            // 落进 SecretStore（而不是 data.json）
            expect(fake.app.loadLocalStorage("obsync-token-r2")).toBe("pasted-secret");
            expect(statusText()).toBe(zhCN.settings.images.secretConfigured);
        });

        it("密钥**不进设置对象**（data.json 会随笔记仓库同步到别的设备）", () => {
            const fake = createFakeApp();
            const tab = createTab(fake);
            renderImagesPage(tab);

            const setting = row(zhCN.settings.images.secretKey)!;
            setting.texts[0]!.type("pasted-secret");
            setting.buttons[0]!.click();

            expect(JSON.stringify(settingsOf(tab))).not.toContain("pasted-secret");
        });
    });

    it("没有装配出同步服务时给出说明，而不是一堆点了没反应的按钮", () => {
        const tab = createTab(createFakeApp());
        renderImagesPage(tab);

        // 操作区的小标题还在（用户知道这里有东西），下面是一行说明
        expect(row(zhCN.settings.images.actionsHeading)).toBeDefined();
        expect(
            childrenOf(tab).find((child) => child.text === zhCN.images.notice.notConfigured)
        ).toBeDefined();
    });
});
