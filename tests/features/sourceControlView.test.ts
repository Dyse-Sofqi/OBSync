import { beforeEach, describe, expect, it } from "vitest";
import type { WorkspaceLeaf } from "obsidian";
import {
    changeRows,
    remoteStateText,
    shortDate,
    SourceControlView,
} from "../../src/features/sync/ui/SourceControlView";
import { createdSettings, resetCreatedSettings, Setting } from "../stubs/obsidian";
import { zhCN } from "../../src/core/i18n/locales/zh-cn";
import type { LocaleStrings } from "../../src/core/i18n";
import type { SyncService } from "../../src/features/sync/syncService";
import type { SimpleGitManager } from "../../src/features/sync/simpleGitManager";
import type { CommitInfo, FileChange, RepoStatus } from "../../src/features/sync/types";

/**
 * 源码控制视图。
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

describe("changeRows", () => {
    it("普通变更按 staged / unstaged / untracked 汇总", () => {
        const rows = changeRows(
            status({
                staged: [change("a.md", "added")],
                unstaged: [change("b.md", "modified")],
                untracked: [change("c.md", "untracked")],
            })
        );

        expect(rows.map((row) => row.path)).toEqual(["a.md", "b.md", "c.md"]);
    });

    it("**冲突文件不出现在变更列表里**（它由调用方单独渲染）", () => {
        // 模拟真实状态：冲突文件同时被算进 staged 与 unstaged
        const rows = changeRows(
            status({
                staged: [change("notes/会打架.md", "conflicted")],
                unstaged: [change("notes/会打架.md", "conflicted")],
                conflicted: ["notes/会打架.md"],
            })
        );

        expect(rows).toEqual([]);
    });

    it("冲突与普通变更并存时，只滤掉冲突", () => {
        const rows = changeRows(
            status({
                staged: [change("notes/会打架.md", "conflicted"), change("a.md", "added")],
                unstaged: [change("notes/会打架.md", "conflicted")],
                untracked: [change("b.md", "untracked")],
                conflicted: ["notes/会打架.md"],
            })
        );

        expect(rows.map((row) => row.path)).toEqual(["a.md", "b.md"]);
    });

    it("干净仓库返回空", () => {
        expect(changeRows(status({}))).toEqual([]);
    });

    it("「改了又暂存」的文件（AM / MM）只显示一次", () => {
        // mapStatus 按 git status 的两位状态位分别归类，AM/MM 的文件
        // 两个位都非空 → 同时进 staged 与 unstaged。列表是给人看的
        // 「有哪些文件变了」，同一个路径出现两遍会让人以为有两处改动。
        const rows = changeRows(
            status({
                staged: [change("a.md", "added"), change("b.md", "modified")],
                unstaged: [change("b.md", "modified")],
            })
        );

        expect(rows.map((row) => row.path)).toEqual(["a.md", "b.md"]);
    });

    it("保留第一次出现的那个（staged 优先）", () => {
        const rows = changeRows(
            status({
                staged: [change("a.md", "added")],
                unstaged: [change("a.md", "modified")],
            })
        );

        expect(rows).toHaveLength(1);
        expect(rows[0]!.status).toBe("added");
    });

    it("标出「已暂存」，未暂存与未跟踪都是 false", () => {
        // 这一位决定那一行给的是「暂存」还是「取消暂存」按钮 —— 反了会让
        // 用户点了之后文件往相反的方向动。
        const rows = changeRows(
            status({
                staged: [change("a.md", "added")],
                unstaged: [change("b.md", "modified")],
                untracked: [change("c.md", "untracked")],
            })
        );

        expect(rows.map((row) => row.staged)).toEqual([true, false, false]);
    });

    it("去重不影响不同路径的文件", () => {
        const rows = changeRows(
            status({
                staged: [change("a.md", "added")],
                unstaged: [change("b.md", "modified")],
                untracked: [change("c.md", "untracked")],
            })
        );

        expect(rows.map((row) => row.path)).toEqual(["a.md", "b.md", "c.md"]);
    });
});

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
    } as unknown as SyncService;

    const git = {
        listBranches: async () => options.branches ?? [{ name: "main", current: true }],
        getRemoteUrl: async () => options.remoteUrl ?? "https://github.com/owner/repo.git",
        log: async () => firstCommits,
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

beforeEach(() => {
    resetCreatedSettings();
});

describe("SourceControlView 渲染", () => {
    it("不是仓库时给出「初始化仓库」的出路（原来只有一句提示）", async () => {
        const h = harness({ status: undefined });

        await h.view.onOpen();

        const init = findSetting("").buttons.find((button) => button.text === zhCN.sync.actInit);
        expect(init).toBeDefined();
        init!.click();
        expect(h.calls).toContain("initRepo");
    });

    it("标题用的是面板名，不是带 OBSync 前缀的命令名", async () => {
        const h = harness({});

        await h.view.onOpen();

        expect(h.view.getDisplayText()).toBe(zhCN.sync.viewTitle);
        expect(zhCN.sync.viewTitle).not.toMatch(/^OBSync/);
        expect(zhCN.sync.cmdOpenView).toMatch(/^OBSync/);
    });

    it("分支下拉框走服务切分支（不再直接调 git.checkout）", async () => {
        const h = harness({
            branches: [
                { name: "main", current: true },
                { name: "dev", current: false },
            ],
        });

        await h.view.onOpen();

        const dropdown = findSetting(zhCN.sync.branchLabel).dropdowns[0]!;
        expect(dropdown.options.map((option) => option.value)).toEqual(["main", "dev"]);
        expect(dropdown.value).toBe("main");

        dropdown.select("dev");
        expect(h.calls).toContain("checkout:dev");
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
