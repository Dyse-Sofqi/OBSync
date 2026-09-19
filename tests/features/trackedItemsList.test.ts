import { beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import {
    createdSettings,
    resetCreatedSettings,
    Notice,
    type ButtonComponent,
    type DropdownComponent,
    type Setting,
} from "../stubs/obsidian";
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
        getMirrorSuggestion: () => undefined,
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
    /**
     * 让安装慢一拍，并回放一次「正在取 main.js」的逐文件进度。
     *
     * 用来断言**长耗时期间的反馈**（按钮转圈、进度文案）—— 不慢一拍的话，
     * 那些状态在同一个微任务里就被收掉了，测不到。
     */
    slow?: boolean;
}): {
    service: InstallerService;
    notices: string[];
    /** 安装请求 —— 「版本管理」要断言装的是**哪一版**。 */
    installs: Array<{ repo: string; version?: string }>;
} {
    const notices: string[] = [];
    const installs: Array<{ repo: string; version?: string }> = [];
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
        install: async (request: {
            repo: string;
            version?: string;
            onProgress?: (file: string) => void;
        }) => {
            installs.push(request);
            if (options.slow) {
                request.onProgress?.("main.js");
                await new Promise((resolve) => setTimeout(resolve, 0));
            }
            return result;
        },
        updateTheme: async () => ({ ...result, wasActive: false }),
        recordUpdateChecks: async () => undefined,
        // 版本管理弹窗要的列表。真实实现在 installerService.listVersions 里，
        // 这里只要求形状对得上（第一项固定是「最新版本」）。
        listVersions: async () => [
            { value: "latest", label: zhCN.installer.versionLatest, prerelease: false },
            { value: "1.0.0", label: "1.0.0", prerelease: false },
        ],
        probeMirror: async () => undefined,
    } as unknown as InstallerService;

    return { service, notices, installs };
}

function renderWith(
    service: InstallerService,
    tracked: TrackedItem[],
    checker: UpdateChecker = {} as UpdateChecker
): { rows: Setting[] } {
    const container = document.createElement("div") as HTMLElement;
    renderTrackedItems(container, {
        app: {} as App,
        t: zhCN,
        service,
        checker,
        getTracked: () => tracked,
        getUpdateFor: () => undefined,
        getMirrorSuggestion: () => undefined,
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

    it("插件比主题多一个「版本管理」按钮 —— 这条不对称是刻意的", () => {
        const { rows } = render([plugin(), theme()]);
        // 取消绑定用 unlink 而不是垃圾桶 —— 它不删文件
        const shared = ["refresh-cw", "download", "unlock", "external-link", "unlink"];

        // 插件有「用户要求的版本」这个字段（可以回退到指定版本），主题没有 ——
        // 主题的更新永远按最新走（见 installer/types.ts）。
        expect(rows[0]!.buttons.map((button) => button.icon)).toEqual([
            "refresh-cw",
            "download",
            "history",
            "unlock",
            "external-link",
            "unlink",
        ]);
        // 给主题一个能选版本的按钮就等于承诺一件做不到的事，所以它不出现。
        expect(rows[1]!.buttons.map((button) => button.icon)).toEqual(shared);

        // history 的位置紧跟 download：两个都是「装哪一版」，一个只往最新走、
        // 一个能往回走，摆在一起才读得出来。
        expect(rows[0]!.buttons.map((button) => button.tooltip)).toContain(
            zhCN.installer.versionManage
        );
        // 圆箭头（refresh-cw）归「检查更新」—— 重装按钮删掉之后它空了出来
        expect(rows[0]!.buttons[0]!.tooltip).toBe(zhCN.installer.checkOne);
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

const GITHUB: RepoRef = { host: "github", owner: "owner", repo: "demo" };
const GITEE: RepoRef = { host: "gitee", owner: "owner", repo: "demo" };

/** 点某个图标对应的操作按钮（图标见上面那组「插件比主题多一个」的用例）。 */
async function clickIcon(row: Setting, icon: string): Promise<void> {
    const button = row.buttons.find((candidate) => candidate.icon === icon);
    if (!button) throw new Error(`这一行没有 ${icon} 按钮`);
    await button.click();
}

/**
 * 更新之后的提示**必须报出来源**。
 *
 * 用户看不出走没走镜像：列表里那行镜像文案只在命中时才出现，「没出现」既可能是
 * 没探测到、也可能是根本没探测（实测：绑进来的条目从不做镜像探测）。所以完成
 * 提示是唯一能确认「东西实际从哪来」的地方 —— 而它必须报**服务实际用的地址**
 * （可能就是这一趟才发现的镜像），不是跟踪记录里那个。
 */
describe("完成提示里的来源", () => {
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

    it("主题也一样（主题不做镜像发现，报的就是它自己的平台）", async () => {
        const { service, notices } = fakeService({ repoRef: GITHUB });
        const { rows } = renderWith(service, [theme()]);

        await clickIcon(rows[0]!, "download");

        expect(notices).toEqual([zhCN.installer.updated("Minimal", "2.0.0", "GitHub")]);
    });
});

/**
 * 「疑似镜像」在列表里的样子。
 *
 * 这一行与上面那行「已在使用」的镜像文案**长得像、含义相反**（一个是已经在走、
 * 一个是还没走），所以两条都要钉：措辞不同（「尚未使用，待确认」），
 * 并且**只有存在提议时才多出那个确认按钮** —— 正常行仍然是六个按钮。
 */
describe("疑似镜像的提议", () => {
    function renderWithSuggestion(
        suggestion: { host: "github" | "gitee"; owner: string; repo: string } | undefined
    ): Setting[] {
        const container = document.createElement("div") as HTMLElement;
        renderTrackedItems(container, {
            app: {} as App,
            t: zhCN,
            service: {} as InstallerService,
            checker: {} as UpdateChecker,
            getTracked: () => [plugin()],
            getUpdateFor: () => undefined,
            getMirrorSuggestion: () => suggestion,
            refresh: () => undefined,
        });
        return createdSettings.filter((setting) => setting.name !== "");
    }

    const SUGGESTION = { host: "gitee", owner: "sofqi", repo: "MDRazor" } as const;

    it("地址列出来，并说明**尚未使用**", () => {
        const rows = renderWithSuggestion(SUGGESTION);

        const lines = extraLines(rows[0]!);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toBe(zhCN.installer.mirrorSuggestionLine("Gitee", "sofqi/MDRazor"));
        expect(lines[0]).toContain("尚未使用");
    });

    it("多出「确认镜像来源」按钮（图标 git-compare）", () => {
        const rows = renderWithSuggestion(SUGGESTION);

        expect(rows[0]!.buttons.map((button) => button.icon)).toEqual([
            "refresh-cw",
            "download",
            "history",
            "unlock",
            "external-link",
            "git-compare",
            "unlink",
        ]);
    });

    it("没有提议时不多这个按钮（正常行仍是六个：插件的五项 + 版本管理）", () => {
        const rows = renderWithSuggestion(undefined);

        expect(rows[0]!.buttons).toHaveLength(6);
        expect(extraLines(rows[0]!)).toEqual([]);
    });
});

/**
 * 「版本管理」在列表这一层的契约。
 *
 * 弹窗自己怎么列版本、怎么标「当前」由 `versionManagerModal.test.ts` 守；
 * 这里守的是**接线**与**可见性**：
 *
 * 1. 按钮只给插件 —— 主题在设计上没有版本钉选（`TrackedTheme` 上没有
 *    `requestedVersion`，`updateTheme` 永远按最新走），给它这个按钮等于承诺
 *    一件做不到的事；
 * 2. 选中之后装的是**选中的那一版**（这是「回退」的全部含义）；
 * 3. 钉住的状态必须显示出来 —— 它只存在于 `data.json` 里，后果却是
 *    「重装会装回旧版」。不显示的话，用户看到旧版本号分不清是自己选的还是
 *    更新失败留下的（与 `sync.enabled` 那个「死开关」是同一类问题）。
 */
describe("版本管理", () => {
    /** 弹窗里的版本下拉框 —— 列表本身没有下拉框，按「有下拉框的那一行」找。 */
    function versionDropdown(): DropdownComponent {
        const row = [...createdSettings].reverse().find((setting) => setting.dropdowns.length > 0);
        if (!row) throw new Error("版本弹窗还没渲染出下拉框");
        return row.dropdowns[0]!;
    }

    function versionApplyButton(): ButtonComponent {
        const row = [...createdSettings]
            .reverse()
            .find((setting) =>
                setting.buttons.some((button) => button.text === zhCN.installer.versionApply)
            );
        if (!row) throw new Error("版本弹窗还没渲染出「切换」按钮");
        return row.buttons.find((button) => button.text === zhCN.installer.versionApply)!;
    }

    it("插件行有版本管理按钮，主题行没有（主题没有版本钉选）", () => {
        const { rows } = render([plugin(), theme()]);

        expect(rows[0]!.buttons.some((button) => button.icon === "history")).toBe(true);
        expect(rows[1]!.buttons.some((button) => button.icon === "history")).toBe(false);
    });

    it("选中一个版本之后按那个 tag 安装，并报出**实际装成的**版本与来源", async () => {
        const { service, notices, installs } = fakeService({ repoRef: GITHUB });
        const { rows } = renderWith(service, [plugin()]);

        await clickIcon(rows[0]!, "history");
        await vi.waitFor(() => expect(versionDropdown()).toBeDefined());
        versionDropdown().select("1.0.0");
        versionApplyButton().click();

        await vi.waitFor(() => expect(installs).toHaveLength(1));
        expect(installs[0]).toMatchObject({ repo: "owner/demo", version: "1.0.0" });
        // 报服务装成的那个版本（tag `v1.2.0` 与 manifest 里的 `1.2.0` 经常不同形）
        expect(notices).toEqual([
            zhCN.installer.versionSwitched("Demo Plugin", "2.0.0", "GitHub"),
        ]);
    });

    it("钉在某个版本上时挂「已固定」徽标 —— 这个状态在界面上只有这一处", () => {
        const { rows } = render([plugin({ requestedVersion: "1.0.0" })]);

        expect(badges(rows[0]!)).toContain(zhCN.installer.versionPinned("1.0.0"));
    });

    it("跟随最新时不挂那个徽标（默认状态不该多一个药丸）", () => {
        const { rows } = render([plugin({ requestedVersion: "latest" })]);

        expect(badges(rows[0]!).some((text) => text.includes("已固定"))).toBe(false);
    });
});

/**
 * 长耗时动作的反馈。
 *
 * 用户原话：「获取插件时，请显示加载动画，不然我根本不知道你是不是在更新」。
 * 装一个插件的网络等待可以到 17~20 秒（GitHub 资产域名的冷连接，见 HANDOVER
 * 第七节第 19 条），这段时间必须**看得出在跑**。两处反馈都要有：
 *
 * 1. 被点的那个图标按钮自己转起来 —— 它不受「显示操作结果提示」设置影响；
 * 2. 提示条里按文件写清在取什么 —— 卡住时用户唯一能判断「没死」的依据。
 */
describe("行内长耗时动作的反馈", () => {
    /** 提示条里的全部文本。 */
    function noticeTexts(notice: { noticeEl: HTMLElement }): string[] {
        const walk = (node: unknown): string[] => {
            const el = node as { text?: string; children?: unknown[] };
            return [...(el.text ? [el.text] : []), ...(el.children ?? []).flatMap(walk)];
        };
        return ((notice.noticeEl.children as unknown) as unknown[]).flatMap(walk);
    }

    it("点「更新到最新」之后按钮变成会转的 loader，做完换回原图标", async () => {
        const { service } = fakeService({ repoRef: GITHUB, slow: true });
        const { rows } = renderWith(service, [plugin()]);
        const button = rows[0]!.buttons.find((candidate) => candidate.icon === "download")!;

        void button.click();

        // 转圈期间：图标换成 loader、加上动画类、并且禁用（避免重复点）
        expect(button.icon).toBe("loader");
        expect(button.extraSettingsEl.hasClass("obsync-spinning")).toBe(true);
        expect(button.disabled).toBe(true);

        await vi.waitFor(() => expect(button.icon).toBe("download"));
        expect(button.extraSettingsEl.hasClass("obsync-spinning")).toBe(false);
        expect(button.disabled).toBe(false);
    });

    it("进度提示里写清**在取哪个文件**（不然只看到一句不说话的不动界面）", async () => {
        const before = Notice.instances.length;
        const { service } = fakeService({ repoRef: GITHUB, slow: true });
        const { rows } = renderWith(service, [plugin()]);

        await clickIcon(rows[0]!, "download");

        const texts = Notice.instances.slice(before).flatMap(noticeTexts);
        expect(texts).toContain(zhCN.installer.progressFetching("Demo Plugin", "main.js"));
    });

    it("「检查更新」同样转圈（它也是网络动作）", async () => {
        const { service } = fakeService({ repoRef: GITHUB });
        const checker = {
            checkOne: async () => {
                await new Promise((resolve) => setTimeout(resolve, 0));
                return { tracked: plugin(), latestVersion: "2.0.0", hasUpdate: false };
            },
        } as unknown as UpdateChecker;
        const { rows } = renderWith(service, [plugin()], checker);
        // 圆箭头 = 检查更新（图标从放大镜换过来的：重装按钮删掉后它空了出来）
        const button = rows[0]!.buttons.find((candidate) => candidate.icon === "refresh-cw")!;

        void button.click();

        expect(button.icon).toBe("loader");
        await vi.waitFor(() => expect(button.icon).toBe("refresh-cw"));
    });
});
