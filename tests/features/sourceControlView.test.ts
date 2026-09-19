import { beforeEach, describe, expect, it } from "vitest";
import type { WorkspaceLeaf } from "obsidian";
import {
    remoteStateText,
    shortDate,
    SourceControlView,
} from "../../src/features/sync/ui/SourceControlView";
import {
    ButtonComponent,
    createdSettings,
    DropdownComponent,
    resetCreatedSettings,
    Setting,
    TextComponent,
    ToggleComponent,
} from "../stubs/obsidian";
import { zhCN } from "../../src/core/i18n/locales/zh-cn";
import { en } from "../../src/core/i18n/locales/en";
import type { LocaleStrings } from "../../src/core/i18n";
import type { SyncService } from "../../src/features/sync/syncService";
import type { SimpleGitManager } from "../../src/features/sync/simpleGitManager";
import type { CommitInfo, FileChange, RepoSize, RepoStatus } from "../../src/features/sync/types";

/**
 * 仓库同步视图（源码控制视图的后继 —— 只改了显示名与顶部布局，见文件头注释）。
 *
 * 这个面板此前**一个渲染测试都没有** —— 于是它有下面这些问题而没人发现：
 * 面板标题与「打开面板」的命令名都是「OBSync」（命令面板里搜「同步」找不到）、
 * 不是仓库时只给一句提示没有任何出路、README 说它支持逐文件暂存而代码里
 * 根本没有暂存这个动作。
 *
 * 所以这里分两层测：
 *
 * 1. **纯函数**（`changeRows` / `remoteStateText` / `shortDate`）——
 *    列表去重、ahead/behind 的 null 语义这类问题读代码看不出来，
 *    而它们错了用户会看到**与事实相反**的内容。
 * 2. **渲染与交互**（用替身的 `Setting` 与 DOM shim 驱动）——
 *    点「暂存」必须对**那一行**的路径调用服务、冲突行**不能**给暂存开关。
 */

function change(path: string, status: FileChange["status"]): FileChange {
    return { path, status };
}

function status(partial: Partial<RepoStatus>): RepoStatus {
    return {
        branch: "main",
        staged: [],
        unstaged: [],
        untracked: [],
        conflicted: [],
        ahead: 0,
        behind: 0,
        ...partial,
    };
}


describe("remoteStateText", () => {
    it("ahead/behind 为 null 表示**没有 upstream**，不是「一致」", () => {
        // 当 0 显示成「与远端一致」正好说反了：那可能是一个从没推送过的分支，
        // 本地几十个提交、远端一个都没有。
        const text = remoteStateText(status({ ahead: null, behind: null }), zhCN);

        expect(text).toBe(zhCN.sync.noUpstreamHint);
    });

    it("都为 0 时是「与远端一致」", () => {
        expect(remoteStateText(status({ ahead: 0, behind: 0 }), zhCN)).toBe(
            zhCN.sync.inSyncWithRemote
        );
    });

    it("领先与落后各说各的", () => {
        expect(remoteStateText(status({ ahead: 2, behind: 0 }), zhCN)).toBe(
            zhCN.sync.aheadOf(2)
        );
        expect(remoteStateText(status({ ahead: 0, behind: 3 }), zhCN)).toBe(
            zhCN.sync.behindOf(3)
        );
    });

    it("双向分叉时两条都写", () => {
        expect(remoteStateText(status({ ahead: 2, behind: 3 }), zhCN)).toBe(
            `${zhCN.sync.aheadOf(2)} · ${zhCN.sync.behindOf(3)}`
        );
    });

    it("只判 null，0 仍然算「一致」而不是「没有 upstream」", () => {
        expect(remoteStateText(status({ ahead: 0, behind: null }), zhCN)).toBe(
            zhCN.sync.noUpstreamHint
        );
    });
});

describe("shortDate", () => {
    it("ISO 时间 → `YYYY-MM-DD HH:mm`", () => {
        // 用本地时间构造再断言，避免测试跟着时区变。
        const local = new Date(2026, 8, 19, 8, 5);
        expect(shortDate(local.toISOString())).toBe("2026-09-19 08:05");
    });

    it("解不出来的字符串原样返回（不显示 Invalid Date）", () => {
        expect(shortDate("不是时间")).toBe("不是时间");
        expect(shortDate("")).toBe("");
    });
});

// ── 渲染与交互 ──────────────────────────────────────────────────────────────

interface Harness {
    view: SourceControlView;
    calls: string[];
    /** 让服务「在背后」推送一次状态（模拟自动提交 / 外部改动）。 */
    publish(status: RepoStatus | undefined): Promise<void>;
    refreshCount(): number;
}

function harness(options: {
    status?: RepoStatus | undefined;
    commits?: CommitInfo[] | undefined;
    remoteUrl?: string | undefined;
    branches?: Array<{ name: string; current: boolean }>;
    /** 仓库体积；显式给 null 表示「读不到」。 */
    repoSize?: RepoSize | null;
    /** 待提交改动的字节数。 */
    pendingBytes?: number;
    t?: LocaleStrings;
}): Harness {
    const calls: string[] = [];
    let refreshCount = 0;
    let listener: ((status: RepoStatus | undefined) => void) | undefined;
    // 显式写 `undefined` 与「没传」是两种意思：前者是「不是仓库 / 读不出历史」。
    let current: RepoStatus | undefined = "status" in options ? options.status : status({});
    const firstCommits: CommitInfo[] | undefined = "commits" in options ? options.commits : [];

    const service = {
        // 视图只碰 deps.notifier（报错出口）—— 少了它点出错的按钮会 TypeError。
        deps: {
            notifier: {
                reportError: (err: unknown) => calls.push(`error:${String(err)}`),
            },
        },
        onStatusChange: (callback: (status: RepoStatus | undefined) => void) => {
            listener = callback;
            return () => {
                listener = undefined;
            };
        },
        refresh: async () => {
            refreshCount += 1;
            // 关键：refresh 会通知订阅者，而订阅者会重绘 —— 视图里没有重入
            // 保护的话这里就是无限递归（栈溢出，面板一片空白）。
            listener?.(current);
            return current;
        },
        sync: async () => {
            calls.push("sync");
        },
        commitAll: async () => {
            calls.push("commitAll");
        },
        pull: async () => {
            calls.push("pull");
        },
        push: async () => {
            calls.push("push");
        },
        abortMerge: async () => {
            calls.push("abortMerge");
        },
        stageFiles: async (paths: string[]) => {
            calls.push(`stage:${paths.join(",")}`);
        },
        unstageFiles: async (paths: string[]) => {
            calls.push(`unstage:${paths.join(",")}`);
        },
        checkoutBranch: async (name: string) => {
            calls.push(`checkout:${name}`);
        },
        pendingChangeBytes: async () => options.pendingBytes ?? 0,
    } as unknown as SyncService;

    const git = {
        listBranches: async () => options.branches ?? [{ name: "main", current: true }],
        getRemoteUrl: async () => options.remoteUrl ?? "https://github.com/owner/repo.git",
        log: async () => firstCommits,
        repoSize: async () => {
            if (options.repoSize === null) throw new Error("count-objects failed");
            return options.repoSize ?? { bytes: 12 * 1024 * 1024, objects: 1234 };
        },
    } as unknown as SimpleGitManager;

    const view = new SourceControlView(null as unknown as WorkspaceLeaf, {
        service,
        git,
        getT: () => options.t ?? zhCN,
        onEditRemote: () => calls.push("editRemote"),
        onInitRepo: () => calls.push("initRepo"),
        onOpenFileOnRemote: (path) => calls.push(`fileOnRemote:${path}`),
        onOpenCommitOnRemote: (hash) => calls.push(`commitOnRemote:${hash}`),
    });

    return {
        view,
        calls,
        refreshCount: () => refreshCount,
        publish: async (next) => {
            current = next;
            listener?.(next);
            await flush();
        },
    };
}

/** 让 `void this.render()` 这类不 await 的调用跑完。 */
async function flush(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
}

/** 一眼看出「这一行是哪一行」：行里的路径文字。 */
function rowPath(setting: Setting): string | undefined {
    const children = (setting.nameEl as unknown as { children?: Array<{ text?: string; cls?: string }> })
        .children;
    return children
        ?.find((child) => (child.cls ?? "").split(" ").includes("obsync-change-path"))
        ?.text;
}

function settingsNamed(name: string): Setting[] {
    return createdSettings.filter((setting) => setting.name === name);
}

/** 渲染出来的所有 Setting，按名字找那一个（找不到直接报出全部名字）。 */
function findSetting(name: string): Setting {
    const found = settingsNamed(name);
    expect(found.length, `没有找到名为「${name}」的设置项`).toBeGreaterThan(0);
    return found[found.length - 1]!;
}

/** 顶部工具条（唯一带 `obsync-actions` 的那个 Setting）。 */
function findToolbar(): Setting {
    const found = createdSettings.filter((setting) =>
        setting.classes.includes("obsync-actions")
    );
    expect(found.length, "没有找到工具条").toBeGreaterThan(0);
    return found[0]!;
}

/** 某个下拉框上的 `aria-label`（工具条里没有可见标签，标签挂在这里）。 */
function ariaLabel(dropdown: DropdownComponent): string | undefined {
    const selectEl = dropdown.selectEl as unknown as { attrs?: Record<string, string> };
    return selectEl.attrs?.["aria-label"];
}

/**
 * 一个控件在界面上的「样子」—— 用来断言工具条**从左到右**的顺序。
 *
 * 按钮看文字（图标按钮没有文字，退化成图标名），下拉框看当前值。混在一起排成
 * 一条，才能验「分支下拉夹在推送和立即同步之间」这种排布。
 */
function controlLabel(
    control: ButtonComponent | DropdownComponent | ToggleComponent | TextComponent
): string {
    if (control instanceof DropdownComponent) return `<select:${control.value}>`;
    if (control instanceof ButtonComponent) return control.text || `<icon:${control.icon}>`;
    return "<other>";
}

/** 一个 Setting 挂在哪个容器里、那个容器带什么类（验「两栏并排」要用）。 */
function containerClass(setting: Setting): string {
    const container = setting.containerEl as unknown as { cls?: string };
    return container.cls ?? "";
}

beforeEach(() => {
    resetCreatedSettings();
});

describe("SourceControlView 渲染", () => {
    it("不是仓库时给出「初始化仓库」的出路（原来只有一句提示）", async () => {
        const h = harness({ status: undefined });

        await h.view.onOpen();

        const init = createdSettings
            .flatMap((setting) => setting.buttons)
            .find((button) => button.text === zhCN.sync.actInit);
        expect(init).toBeDefined();
        init!.click();
        expect(h.calls).toContain("initRepo");
    });

    it("不是仓库时工具条还在（刷新能用），但**没有**分支下拉", async () => {
        // 没有状态就没有分支 —— 那一格必须空着，而不是显示一个编出来的分支名。
        const h = harness({ status: undefined });

        await h.view.onOpen();

        const toolbar = findToolbar();
        expect(toolbar.dropdowns).toHaveLength(0);
        // 刷新仍然在（这是面板唯一的「重新读一次状态」入口）
        expect(toolbar.buttons[toolbar.buttons.length - 1]!.icon).toBe("refresh-cw");
    });

    it("标题用的是面板名，不是带 OBSync 前缀的命令名", async () => {
        const h = harness({});

        await h.view.onOpen();

        expect(h.view.getDisplayText()).toBe(zhCN.sync.viewTitle);
        expect(zhCN.sync.viewTitle).not.toMatch(/^OBSync/);
        expect(zhCN.sync.cmdOpenView).toMatch(/^OBSync/);
    });

    it("面板内**不再**重复一个标题（标签页上已经写着视图名了）", async () => {
        // 2026-09-19 用户要求删掉它 —— 侧边栏里一行标题就是一行浪费。
        const h = harness({});
        await h.view.onOpen();

        expect(settingsNamed(zhCN.sync.viewTitle)).toHaveLength(0);
        // 视图名本身还在（`getDisplayText` 就是标签页的标题）
        expect(h.view.getDisplayText()).toBe(zhCN.sync.viewTitle);
    });

    it("工具条**一行**，顺序是 提交 / 拉取 / 推送 / 分支 / 立即同步 / 刷新", async () => {
        // 用户的要求：标题右边的刷新按钮、四个动作、下一行的分支下拉合并成一行。
        // 「一行」在实现上就是**同一个 Setting** —— 它们都落在它的 controlEl 里。
        // 顺序是当天晚上第二次指定的：分步动作在左、立即同步在右、刷新最右。
        const h = harness({});
        await h.view.onOpen();

        const toolbar = findToolbar();

        // 用 `controls`（调用顺序 = 真实 DOM 里从左到右）而不是只看 `buttons` ——
        // 分支下拉夹在中间，只看按钮列表是验不出它在哪一格。
        expect(toolbar.controls.map(controlLabel)).toEqual([
            zhCN.sync.actCommit,
            zhCN.sync.actPull,
            zhCN.sync.actPush,
            "<select:main>",
            zhCN.sync.actSync,
            "<icon:refresh-cw>",
        ]);
        // 窄面板里换行交给 CSS（这个类就是干这个的）
        expect(toolbar.classes).toContain("obsync-actions");
    });

    it("「立即同步」带一个只属于它的类 —— 靠 auto 外边距顶到右侧", async () => {
        // 顺序对了不等于位置对了：面板够宽时它要贴着右边，靠的是这个类
        // （`.obsync-action-sync { margin-left: auto }`）。
        const h = harness({});
        await h.view.onOpen();

        const sync = findToolbar().buttons.find(
            (button) => button.text === zhCN.sync.actSync
        )!;
        expect(sync.buttonEl.hasClass("obsync-action-sync")).toBe(true);
        // 其余按钮不该有这个类（否则右边会多出好几段空隙）
        const others = findToolbar().buttons.filter(
            (button) => button.text !== zhCN.sync.actSync
        );
        expect(
            others.every((button) => !button.buttonEl.hasClass("obsync-action-sync"))
        ).toBe(true);
    });

    it("「提交」按钮的文案就是两个字（不是「提交全部」）", async () => {
        // 用户明确要求改短 —— 四个按钮要挤一行。
        expect(zhCN.sync.actCommit).toBe("提交");
        expect(en.sync.actCommit).toBe("Commit");
    });

    it("三个动作按钮的悬停提示说清了「提交」与「推送」的区别", async () => {
        // 用户的提问原话：「推送按钮是单纯的推送还是提交全部加推送，
        // 如果是后者应该写清楚」—— 按钮上只有两个字，答案必须由界面给出。
        const h = harness({});
        await h.view.onOpen();

        const tooltips = createdSettings.flatMap((setting) =>
            setting.buttons.map((button) => button.tooltip)
        );

        expect(tooltips).toContain(zhCN.sync.actSyncHint);
        expect(tooltips).toContain(zhCN.sync.actCommitHint);
        expect(tooltips).toContain(zhCN.sync.actPushHint);
        // 推送那条必须点明它只送「已提交」的内容（否则这句提示等于没说）
        expect(zhCN.sync.actPushHint).toContain("已提交");
        // 「立即同步」要说清它是一条链，而不只是「同步」两个字
        expect(zhCN.sync.actSyncHint).toContain("提交");
        expect(zhCN.sync.actSyncHint).toContain("推送");
    });

    it("分支下拉框走服务切分支（不再直接调 git.checkout）", async () => {
        const h = harness({
            branches: [
                { name: "main", current: true },
                { name: "dev", current: false },
            ],
        });

        await h.view.onOpen();

        const dropdown = findToolbar().dropdowns[0]!;
        expect(dropdown.options.map((option) => option.value)).toEqual(["main", "dev"]);
        expect(dropdown.value).toBe("main");
        // 「分支」两个字没地方写了，标签挂在 aria-label 上（读屏仍然知道它是什么）
        expect(ariaLabel(dropdown)).toBe(zhCN.sync.branchLabel);

        dropdown.select("dev");
        expect(h.calls).toContain("checkout:dev");
    });

    it("游离 HEAD：下拉框写着「游离 HEAD」且不可选（没有分支可切）", async () => {
        // 这一格是这条信息唯一的落点 —— 藏起来的话用户只会觉得「少了点什么」。
        const h = harness({ status: status({ branch: null }) });

        await h.view.onOpen();

        const dropdown = findToolbar().dropdowns[0]!;
        expect(dropdown.disabled).toBe(true);
        expect(dropdown.options).toEqual([
            { value: "", label: zhCN.sync.detachedHeadLabel },
        ]);
    });

    it("列不出分支时给的是置灰的当前分支，不是可切的下拉框", async () => {
        // 可切的下拉框里只有它自己 —— 那是个假象（选了不会有任何事发生）。
        const h = harness({ branches: [] });

        await h.view.onOpen();

        const dropdown = findToolbar().dropdowns[0]!;
        expect(dropdown.disabled).toBe(true);
        expect(dropdown.options).toEqual([{ value: "main", label: "main" }]);
    });

    it("仓库体积与待提交改动的体积都在，且**并排两栏**", async () => {
        const h = harness({
            status: status({ unstaged: [change("a.md", "modified")] }),
            repoSize: { bytes: 12 * 1024 * 1024, objects: 1234 },
            pendingBytes: 1024 * 1024,
        });

        await h.view.onOpen();

        const size = findSetting(zhCN.sync.repoSizeLabel);
        const pending = findSetting(zhCN.sync.pendingChangesLabel);

        // 两句话本身没变（它们回答的是两个不同的问题，见 repoSize.ts）
        expect(size.desc).toBe(zhCN.sync.repoSizeDesc("12 MB", 1234));
        expect(pending.desc).toBe(zhCN.sync.pendingChangesDesc("1 MB", 1));

        // 「两栏」在实现上就是**挂在同一个容器里**，而那个容器是横向 flex。
        // 谁要是把它们各自塞回 contentEl，这条立刻失败。
        expect(size.containerEl).toBe(pending.containerEl);
        expect(containerClass(size)).toContain("obsync-metrics");
    });

    it("**读不到仓库体积时说「读不到」，不编一个 0 B**", async () => {
        // 0 B 会被当成「空仓库」—— 那是个错误的结论，比「读不到」糟得多。
        const h = harness({ repoSize: null });

        await h.view.onOpen();

        expect(findSetting(zhCN.sync.repoSizeLabel).desc).toBe(zhCN.sync.sizeUnknown);
    });

    it("没有未提交改动时，「待提交改动」写的是「没有需要提交的更改」", async () => {
        const h = harness({ status: status({}) });

        await h.view.onOpen();

        expect(findSetting(zhCN.sync.pendingChangesLabel).desc).toBe(
            zhCN.sync.nothingToCommit
        );
    });

    it("与远端完全一致时，状态摘要那一行高亮（与状态栏的 ✓ 同一判据）", async () => {
        const h = harness({ status: status({ ahead: 0, behind: 0 }) });

        await h.view.onOpen();

        const line = (
            h.view.contentEl as unknown as {
                children: Array<{ cls?: string; text?: string }>;
            }
        ).children.find((child) => (child.cls ?? "").includes("obsync-remote-state"));

        expect(line?.cls).toContain("obsync-remote-synced");
        expect(line?.text).toBe(zhCN.sync.inSyncWithRemote);
    });

    it("领先 / 落后远端时不高亮", async () => {
        for (const partial of [{ ahead: 1, behind: 0 }, { ahead: 0, behind: 2 }]) {
            const h = harness({ status: status(partial) });
            await h.view.onOpen();

            const line = (
                h.view.contentEl as unknown as {
                    children: Array<{ cls?: string }>;
                }
            ).children.find((child) => (child.cls ?? "").includes("obsync-remote-state"));

            expect(line?.cls, JSON.stringify(partial)).not.toContain("obsync-remote-synced");
        }
    });

    it("远端地址回显前脱敏（面板会把地址显示在屏幕上）", async () => {
        const h = harness({
            remoteUrl: "https://user:secret-token@github.com/owner/repo.git",
        });

        await h.view.onOpen();

        const row = findSetting(zhCN.sync.remoteLabel);
        expect(row.desc).not.toContain("secret-token");
        expect(row.desc).toContain("github.com/owner/repo.git");
    });

    it("按暂存状态分组，每一行点「暂存 / 取消暂存」作用于**那一行**的路径", async () => {
        const h = harness({
            status: status({
                staged: [change("已暂存.md", "added")],
                unstaged: [change("未暂存.md", "modified")],
                untracked: [change("新文件.md", "untracked")],
            }),
        });

        await h.view.onOpen();

        // 两组的标题带各自的条数
        expect(settingsNamed(zhCN.sync.sectionStaged(1))).toHaveLength(1);
        expect(settingsNamed(zhCN.sync.sectionChanges(2))).toHaveLength(1);

        const rows = createdSettings.filter((setting) =>
            setting.classes.includes("obsync-change-row")
        );
        expect(rows.map(rowPath)).toEqual(["已暂存.md", "未暂存.md", "新文件.md"]);

        // 已暂存的那行给的是「取消暂存」
        const stagedRow = rows[0]!;
        expect(stagedRow.buttons[1]!.icon).toBe("minus");
        expect(stagedRow.buttons[1]!.tooltip).toBe(zhCN.sync.actUnstage);
        stagedRow.buttons[1]!.click();
        expect(h.calls).toContain("unstage:已暂存.md");

        // 未暂存的那行给的是「暂存」
        const unstagedRow = rows[1]!;
        expect(unstagedRow.buttons[1]!.icon).toBe("plus");
        expect(unstagedRow.buttons[1]!.tooltip).toBe(zhCN.sync.actStage);
        unstagedRow.buttons[1]!.click();
        expect(h.calls).toContain("stage:未暂存.md");
    });

    it("「全部暂存 / 全部取消暂存」把整组的路径一次交出去", async () => {
        const h = harness({
            status: status({
                staged: [change("a.md", "added")],
                unstaged: [change("b.md", "modified")],
                untracked: [change("c.md", "untracked")],
            }),
        });

        await h.view.onOpen();

        findSetting(zhCN.sync.sectionChanges(2)).buttons[0]!.click();
        expect(h.calls).toContain("stage:b.md,c.md");

        findSetting(zhCN.sync.sectionStaged(1)).buttons[0]!.click();
        expect(h.calls).toContain("unstage:a.md");
    });

    it("每一行都能在远端打开对应文件", async () => {
        const h = harness({ status: status({ unstaged: [change("a.md", "modified")] }) });

        await h.view.onOpen();

        const row = createdSettings.find((setting) =>
            setting.classes.includes("obsync-change-row")
        )!;
        row.buttons[0]!.click();
        expect(h.calls).toContain("fileOnRemote:a.md");
    });

    it("冲突行**不给暂存开关**，但给「放弃本次合并」", async () => {
        const h = harness({
            status: status({ conflicted: ["notes/会打架.md"] }),
        });

        await h.view.onOpen();

        const heading = findSetting(zhCN.sync.sectionConflicts(1));
        expect(heading.buttons[0]!.text).toBe(zhCN.sync.actAbortMerge);
        heading.buttons[0]!.click();
        expect(h.calls).toContain("abortMerge");

        const conflictRow = createdSettings.find((setting) =>
            setting.classes.includes("obsync-conflict")
        )!;
        expect(rowPath(conflictRow)).toBe("notes/会打架.md");
        // 只有「在远端打开」一个按钮：冲突文件的暂存要等用户在编辑器里
        // 把 <<<<<<< 处理掉，面板看不到内容，所以不给这个入口。
        expect(conflictRow.buttons).toHaveLength(1);
    });

    it("干净仓库只提示无事可做，不给暂存分组", async () => {
        const h = harness({ status: status({}) });

        await h.view.onOpen();

        expect(JSON.stringify(h.view.contentEl)).toContain(zhCN.sync.nothingToCommit);
        expect(
            createdSettings.filter((setting) => setting.classes.includes("obsync-change-row"))
        ).toHaveLength(0);
    });

    it("历史列表点 hash 交给主类在远端打开提交", async () => {
        const commit: CommitInfo = {
            hash: "0123456789abcdef",
            shortHash: "0123456",
            message: "同步：1 个文件\n\n正文不该显示",
            author: "Sofqi",
            date: new Date(2026, 8, 19, 8, 5).toISOString(),
        };
        const h = harness({ commits: [commit] });

        await h.view.onOpen();

        const list = (h.view.contentEl as unknown as {
            children: Array<{ cls?: string; children?: unknown[] }>;
        }).children.find((child) => (child.cls ?? "").split(" ").includes("obsync-history"));
        expect(list).toBeDefined();

        const row = (list!.children as Array<{ children: Array<{ text?: string; attrs?: Record<string, string> }> }>)[0]!;
        const texts = row.children.map((child) => child.text);
        // 提交信息只取第一行 —— 面板里塞不下正文
        expect(texts).toContain("同步：1 个文件");
        expect(texts.join(" ")).not.toContain("正文不该显示");
    });

    it("读不出提交历史时给出说明而不是空白", async () => {
        const h = harness({ commits: undefined });

        await h.view.onOpen();

        const text = JSON.stringify(h.view.contentEl);
        expect(text).toContain(zhCN.sync.historyFailed);
    });
});

describe("SourceControlView 的状态订阅", () => {
    it("渲染时不会因为 refresh 通知订阅者而无限递归", async () => {
        const h = harness({});

        await h.view.onOpen();

        // 只渲染一次：重绘里再 refresh 一次就会又通知一次 …
        expect(h.refreshCount()).toBe(1);
    });

    it("状态在背后变化时面板跟着重绘（自动提交 / 外部改动）", async () => {
        const h = harness({});
        await h.view.onOpen();
        expect(h.refreshCount()).toBe(1);
        expect(
            createdSettings.filter((setting) => setting.classes.includes("obsync-change-row"))
        ).toHaveLength(0);

        // 服务在视图背后刷新了状态（自动提交定时器到点、库外编辑器改了文件…）
        await h.publish(status({ unstaged: [change("外面改的.md", "modified")] }));

        expect(h.refreshCount()).toBe(2);
        const rows = createdSettings.filter((setting) =>
            setting.classes.includes("obsync-change-row")
        );
        expect(rows.map(rowPath)).toEqual(["外面改的.md"]);
    });

    it("关闭视图后退订，之后的状态变化不再重绘", async () => {
        const h = harness({});
        await h.view.onOpen();

        await h.view.onClose();
        await h.publish(status({}));

        expect(h.refreshCount()).toBe(1);
    });
});
