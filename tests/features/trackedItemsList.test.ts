import { beforeEach, describe, expect, it } from "vitest";
import type { App } from "obsidian";
import { createdSettings, resetCreatedSettings, type Setting } from "../stubs/obsidian";
import { zhCN } from "../../src/core/i18n/locales/zh-cn";
import { Notifier } from "../../src/core/notice";
import { renderTrackedItems } from "../../src/features/installer/ui/TrackedItemsList";
import type { InstallerService } from "../../src/features/installer/installerService";
import type { UpdateChecker } from "../../src/features/installer/updateChecker";
import type { TrackedItem } from "../../src/features/installer/types";
import type { RepoRef } from "../../src/host/types";

/**
 * 「已跟踪的插件与主题」列表的渲染契约。
 *
 * 插件与主题共用一个列表，行为差异都收在 service / checker 里按 kind 分派，
 * 这里要守的是**展示层那两处分叉**：
 *
 * 1. 类型徽标要能一眼分出插件与主题（两者操作按钮完全一样，没有徽标就只能靠猜）；
 * 2. 更新徽标的键是 `<kind>:<id>` —— 一个叫 `minimal` 的插件与一个目录名为
 *    `minimal` 的主题**不能共用**一条记录（否则清掉一个另一个的徽标也消失）。
 *
 * 另外钉住两处「如实呈现」：主题读不到版本时不写「版本 」这种空壳，
 * 从源码通道更新过的行要说明来源。
 */

function badges(setting: Setting): string[] {
    // 替身里的元素是结构化对象（不是真 DOM），这里按我们关心的那一个字段读。
    const children = setting.nameEl.children as unknown as Array<{ text?: string }>;
    return children.map((child) => child.text ?? "");
}

function render(
    tracked: TrackedItem[],
    updates: Record<string, { latestVersion: string; checkedAt: number }> = {}
): { container: HTMLElement; rows: Setting[] } {
    const container = document.createElement("div") as HTMLElement;
    renderTrackedItems(container, {
        app: {} as App,
        t: zhCN,
        // 这些用例只渲染、不点击 —— 两个协作者只用来满足类型。
        service: {} as InstallerService,
        checker: {} as UpdateChecker,
        getTracked: () => tracked,
        getUpdateFor: (key) => updates[key],
        refresh: () => undefined,
    });

    return {
        container,
        rows: createdSettings.filter((setting) => setting.name !== ""),
    };
}

/** 造一个「装了什么就回报什么」的服务替身，外加被拦下来的成功提示。 */
function fakeService(options: {
    repoRef: RepoRef;
    origin?: RepoRef;
}): { service: InstallerService; notices: string[] } {
    const notices: string[] = [];
    const notifier = new Notifier({ getShowNotices: () => true, getT: () => zhCN });
    notifier.success = (message: string) => notices.push(message);

    const result = {
        manifest: { id: "demo", name: "Demo Plugin", version: "2.0.0", minAppVersion: "1.0.0" },
        channel: "release" as const,
        version: "2.0.0",
        replaced: true,
        enabled: true,
        repoRef: options.repoRef,
        origin: options.origin,
    };

    const service = {
        deps: { notifier },
        install: async () => result,
        updateTheme: async () => ({ ...result, wasActive: false }),
        reinstall: async () => result,
    } as unknown as InstallerService;

    return { service, notices };
}

function renderWith(
    service: InstallerService,
    tracked: TrackedItem[]
): { rows: Setting[] } {
    const container = document.createElement("div") as HTMLElement;
    renderTrackedItems(container, {
        app: {} as App,
        t: zhCN,
        service,
        checker: {} as UpdateChecker,
        getTracked: () => tracked,
        getUpdateFor: () => undefined,
        refresh: () => undefined,
    });
    return { rows: createdSettings.filter((setting) => setting.name !== "") };
}

function plugin(overrides: Partial<TrackedItem> = {}): TrackedItem {
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
        ...overrides,
    } as TrackedItem;
}

function theme(overrides: Partial<TrackedItem> = {}): TrackedItem {
    return {
        kind: "theme",
        host: "github",
        owner: "kepano",
        repo: "obsidian-minimal",
        id: "Minimal",
        name: "Minimal",
        installedVersion: "9.1.0",
        frozen: false,
        installedAt: 0,
        ...overrides,
    } as TrackedItem;
}

beforeEach(() => {
    resetCreatedSettings();
});

describe("renderTrackedItems", () => {
    it("插件与主题各带自己的类型徽标（操作按钮一样，只能靠徽标区分）", () => {
        const { rows } = render([plugin(), theme()]);

        expect(rows).toHaveLength(2);
        expect(badges(rows[0]!)).toContain(zhCN.installer.kindPlugin);
        expect(badges(rows[1]!)).toContain(zhCN.installer.kindTheme);
    });

    it("两种都能从描述行看到来源与版本", () => {
        const { rows } = render([plugin(), theme()]);

        expect(rows[0]!.desc).toBe("GitHub · owner/demo · 版本 1.0.0");
        expect(rows[1]!.desc).toBe("GitHub · kepano/obsidian-minimal · 版本 9.1.0");
    });

    it("**主题没有版本时不写空壳**（手工装的目录读不到 manifest）", () => {
        const { rows } = render([theme({ installedVersion: "" })]);

        expect(rows[0]!.desc).toBe("GitHub · kepano/obsidian-minimal");
        expect(rows[0]!.desc).not.toContain("版本");
    });

    it("从源码通道更新过的行说明来源（否则用户以为更新检查坏了）", () => {
        const { rows } = render([theme({ channel: "raw" })]);

        expect(rows[0]!.desc).toContain(zhCN.installer.sourceRaw);
    });

    it("**同 id 的插件与主题各用各的更新徽标**（键空间按 kind 分开）", () => {
        const { rows } = render(
            [plugin({ id: "minimal", name: "Minimal Plugin" }), theme({ id: "minimal" })],
            { "theme:minimal": { latestVersion: "9.2.0", checkedAt: 1 } }
        );

        const pluginBadges = badges(rows[0]!);
        const themeBadges = badges(rows[1]!);

        expect(pluginBadges.some((text) => text.includes("9.2.0"))).toBe(false);
        expect(themeBadges).toContain(zhCN.installer.updateBadge("9.2.0"));
    });

    it("冻结的条目显示冻结徽标", () => {
        const { rows } = render([theme({ frozen: true })]);

        expect(badges(rows[0]!)).toContain(zhCN.installer.frozen);
    });

    it("没有跟踪项时给出空状态，且不渲染任何行", () => {
        const { container, rows } = render([]);

        expect(rows).toEqual([]);
        const empty = container.children[0] as unknown as { text?: string; cls?: string };
        expect(empty.text).toBe(zhCN.settings.installer.trackedEmpty);
        expect(empty.cls).toContain("obsync-empty");
    });

    it("两种对象的六个操作按钮都在（检查 / 更新 / 重装 / 冻结 / 打开 / 取消绑定）", () => {
        const { rows } = render([plugin(), theme()]);
        // 取消绑定用 unlink 而不是垃圾桶 —— 它不删文件
        const expected = ["search", "download", "refresh-cw", "unlock", "external-link", "unlink"];

        for (const row of rows) {
            expect(row.buttons.map((button) => button.icon)).toEqual(expected);
        }
    });
});

/**
 * 描述区里除「来源 · 版本」之外**另加的那些行**。
 *
 * 替身里的 `setDesc` 只记字符串、不往 `descEl` 里写（真实 Obsidian 是写进去的），
 * 所以这里读到的 children 正好就是额外创建的行 —— 断言不会把第一行混进来。
 */
function extraLines(setting: Setting): string[] {
    const children = setting.descEl.children as unknown as Array<{ text?: string }>;
    return children.map((child) => child.text ?? "");
}

/**
 * 走了 Gitee 镜像的条目：`host/owner/repo` 是**实际使用**的镜像，
 * 用户填的源地址在 `origin` 里（见 `installer/types.ts` 的 `origin` 说明）。
 */
function mirrored(overrides: Partial<TrackedItem> = {}): TrackedItem {
    return plugin({
        host: "gitee",
        origin: { host: "github", owner: "owner", repo: "demo" },
        ...overrides,
    });
}

describe("镜像行", () => {
    it("源地址在描述行，镜像**另起一行**", () => {
        const { rows } = render([mirrored()]);

        // 第一行报的是源仓库（插件的家，也是用户认得出来的地址），不是镜像
        expect(rows[0]!.desc).toBe("GitHub · owner/demo · 版本 1.0.0");
        expect(extraLines(rows[0]!)).toEqual([
            zhCN.installer.mirrorLine("Gitee", "owner/demo"),
        ]);
    });

    it("镜像行必须点明**下载走它**", () => {
        // 只写「Gitee 镜像」的话，用户看到上面一行 GitHub、下面一行 Gitee，
        // 无从判断 OBSync 到底在跟谁说话 —— 而下载与更新检查都走镜像。
        const { rows } = render([mirrored()]);

        expect(extraLines(rows[0]!)[0]).toContain("下载使用此源");
    });

    it("没走镜像时**没有**第二行（只有这一个地址，不必重复）", () => {
        const { rows } = render([plugin()]);

        expect(rows[0]!.desc).toBe("GitHub · owner/demo · 版本 1.0.0");
        expect(extraLines(rows[0]!)).toEqual([]);
    });

    it("用户直接填 Gitee 地址的条目也没有第二行（没有第二个地址可展示）", () => {
        const { rows } = render([plugin({ host: "gitee" })]);

        expect(rows[0]!.desc).toBe("Gitee · owner/demo · 版本 1.0.0");
        expect(extraLines(rows[0]!)).toEqual([]);
    });

    it("主题同样有（插件与主题共用这一个列表）", () => {
        const { rows } = render([
            theme({
                host: "gitee",
                origin: { host: "github", owner: "kepano", repo: "obsidian-minimal" },
            }),
        ]);

        expect(rows[0]!.desc).toContain("GitHub · kepano/obsidian-minimal");
        expect(extraLines(rows[0]!)).toEqual([
            zhCN.installer.mirrorLine("Gitee", "kepano/obsidian-minimal"),
        ]);
    });

    it("第二行与徽标、按钮互不干扰（同一行上该有的都还在）", () => {
        const { rows } = render([mirrored({ frozen: true })]);

        expect(extraLines(rows[0]!)).toHaveLength(1);
        expect(badges(rows[0]!)).toContain(zhCN.installer.frozen);
        expect(rows[0]!.buttons).toHaveLength(6);
    });
});

/**
 * 更新 / 重装之后的提示**必须报出来源**。
 *
 * 用户看不出走没走镜像：列表里那行镜像文案只在命中时才出现，「没出现」既可能是
 * 没探测到、也可能是根本没探测（实测：绑进来的条目从不做镜像探测）。所以完成
 * 提示是唯一能确认「东西实际从哪来」的地方 —— 而它必须报**服务实际用的地址**
 * （可能就是这一趟才发现的镜像），不是跟踪记录里那个。
 */
describe("完成提示里的来源", () => {
    const GITHUB: RepoRef = { host: "github", owner: "owner", repo: "demo" };
    const GITEE: RepoRef = { host: "gitee", owner: "owner", repo: "demo" };

    /** 点第 n 个图标对应的操作按钮（见上面那组「六个操作按钮都在」的用例）。 */
    async function clickIcon(row: Setting, icon: string): Promise<void> {
        const button = row.buttons.find((candidate) => candidate.icon === icon);
        if (!button) throw new Error(`这一行没有 ${icon} 按钮`);
        await button.click();
    }

    it("命中镜像时点名「Gitee 镜像」（只写 Gitee 会让人以为跟踪的地址被换了）", async () => {
        const { service, notices } = fakeService({ repoRef: GITEE, origin: GITHUB });
        const { rows } = renderWith(service, [plugin({ host: "gitee", origin: GITHUB })]);

        await clickIcon(rows[0]!, "download");

        expect(notices).toEqual([zhCN.installer.updated("Demo Plugin", "2.0.0", "Gitee 镜像")]);
    });

    it("没走镜像时报平台名", async () => {
        const { service, notices } = fakeService({ repoRef: GITHUB });
        const { rows } = renderWith(service, [plugin()]);

        await clickIcon(rows[0]!, "download");

        expect(notices).toEqual([zhCN.installer.updated("Demo Plugin", "2.0.0", "GitHub")]);
    });

    it("重装那条提示同样报来源", async () => {
        const { service, notices } = fakeService({ repoRef: GITHUB });
        const { rows } = renderWith(service, [plugin()]);

        await clickIcon(rows[0]!, "refresh-cw");

        expect(notices).toEqual([zhCN.installer.reinstalled("Demo Plugin", "GitHub")]);
    });

    it("主题也一样（主题不做镜像发现，报的就是它自己的平台）", async () => {
        const { service, notices } = fakeService({ repoRef: GITHUB });
        const { rows } = renderWith(service, [theme()]);

        await clickIcon(rows[0]!, "download");

        expect(notices).toEqual([zhCN.installer.updated("Minimal", "2.0.0", "GitHub")]);
    });
});
