import { describe, expect, it } from "vitest";
import { getVaultRoot, StatusBar } from "../../src/features/sync/statusBar";
import type { FileChange, RepoStatus } from "../../src/features/sync/types";
import { en } from "../../src/core/i18n/locales/en";
import { zhCN } from "../../src/core/i18n/locales/zh-cn";
import { createFakeApp } from "../helpers/fakeApp";

/**
 * `statusBar.ts` 此前**没有任何测试**。
 *
 * 它身上有两件事值得单测，而且都不是「不好看」：
 *
 * 1. `getVaultRoot` 决定 git 的 `baseDir`。错了不是状态栏的问题 ——
 *    是整个同步模块连不上仓库。而这个错**在本机（Windows）测不出来**，
 *    见下面第一组的说明。
 * 2. `StatusBar` 是全项目唯一把 `t` 在构造时快照下来的地方
 *    （别处一律 `getT()` 用到时才取），于是切换语言后它的文案不跟着变。
 */

function createItem(): { item: HTMLElement; texts: string[]; last: () => string | undefined } {
    const texts: string[] = [];
    const item = {
        setText(value: string) {
            texts.push(value);
        },
    } as unknown as HTMLElement;
    return { item, texts, last: () => texts[texts.length - 1] };
}

function makeStatus(overrides: Partial<RepoStatus> = {}): RepoStatus {
    return {
        branch: "main",
        staged: [],
        unstaged: [],
        untracked: [],
        conflicted: [],
        ahead: null,
        behind: null,
        ...overrides,
    };
}

function change(path: string, status: FileChange["status"] = "modified"): FileChange {
    return { path, status };
}

/** 造一个「vault 在某个具体路径」的 app。 */
function appWithBasePath(value: string) {
    const fake = createFakeApp();
    (fake.app.vault.adapter as unknown as { getBasePath(): string }).getBasePath = () =>
        value;
    return fake.app;
}

describe("getVaultRoot —— 这个值必须是文件系统的绝对路径", () => {
    /**
     * 这里是整个文件里最要紧的一组，原因是**它在本机测不出来**：
     * 开发机是 Windows，而 Windows 的 `C:\...` 不以斜杠开头，
     * 所以 `normalizePath`（真实实现与桩件一致：剥掉前导与结尾斜杠）
     * 对它是恒等变换 —— 测试全绿，macOS / Linux 全错。
     *
     * 要测这个方向，就必须**自己给出 POSIX 形态的输入**，
     * 不能依赖 `fakeApp` 的默认值（`path.join(os.tmpdir(), ...)`，跟着宿主机走）。
     */
    it("POSIX 绝对路径原样返回（前导斜杠是根目录，不是多余的斜杠）", () => {
        expect(getVaultRoot(appWithBasePath("/Users/sofi/Documents/Vault"))).toBe(
            "/Users/sofi/Documents/Vault"
        );
    });

    it("挂在挂载点、带结尾斜杠的路径也不被动", () => {
        expect(getVaultRoot(appWithBasePath("/Volumes/Vault/"))).toBe("/Volumes/Vault/");
    });

    it("Windows 盘符路径原样返回（也不换分隔符）", () => {
        // 这条钉的是**契约**「原样返回」，而不是「另一种写法会坏」——
        // 两种分隔符 simple-git 都认（实测过），把 `\` 换成 `/` 并不会坏功能。
        // 之所以仍然要求原样：一旦允许这一处「顺手归一」，下一个人就会觉得
        // 「前导斜杠也多余」—— 那正是这次的 bug。
        expect(getVaultRoot(appWithBasePath("D:\\Vault\\notes"))).toBe("D:\\Vault\\notes");
    });

    it("无论哪个平台，结果都是绝对路径", () => {
        // 前三条是逐字比较；这条表达的是**不变量**：
        // 削掉前导斜杠之后它就是一个相对路径，而相对路径按**进程 cwd** 解析 ——
        // 同一个库换个启动方式就指向别处（甚至不存在，simple-git 直接抛
        // "Cannot use simple-git on a directory that does not exist"）。
        for (const value of ["/Users/a/Vault", "/srv/notes", "C:\\Vault", "D:/Vault"]) {
            const root = getVaultRoot(appWithBasePath(value));
            const absolute = root.startsWith("/") || /^[A-Za-z]:/.test(root);
            expect(absolute, `${value} → ${root}`).toBe(true);
        }
    });
});

describe("StatusBar 渲染", () => {
    it("初始没有状态时只显示插件名", () => {
        const { item, last } = createItem();
        new StatusBar({ item, getT: () => zhCN });

        expect(last()).toBe("OBSync");
    });

    it("分支 + ahead/behind 用无语言符号表示", () => {
        const { item, last } = createItem();
        const bar = new StatusBar({ item, getT: () => zhCN });

        bar.update(makeStatus({ branch: "main", ahead: 2, behind: 1 }));

        expect(last()).toBe("OBSync: main ↑2 ↓1");
    });

    it("ahead/behind 为 0 或 null 时不显示", () => {
        const { item, last } = createItem();
        const bar = new StatusBar({ item, getT: () => zhCN });

        bar.update(makeStatus({ branch: "main", ahead: 0, behind: null }));

        expect(last()).toBe("OBSync: main");
    });

    it("脏文件**按路径去重**（同一个文件同时 staged 与 unstaged 只算一个）", () => {
        // 这条注释在源码里写着，但此前没有用例钉住。相加会把一个文件算成两个，
        // 而 `~N` 是用户判断「要不要提交」的唯一数字。
        const { item, last } = createItem();
        const bar = new StatusBar({ item, getT: () => zhCN });

        bar.update(
            makeStatus({
                staged: [change("a.md"), change("b.md")],
                unstaged: [change("a.md")],
                untracked: [change("c.md")],
            })
        );

        expect(last()).toBe("OBSync: main ~3");
    });

    it("有冲突时显示警告数，且**盖过**脏文件计数", () => {
        const { item, last } = createItem();
        const bar = new StatusBar({ item, getT: () => zhCN });

        bar.update(
            makeStatus({
                conflicted: ["a.md", "b.md"],
                unstaged: [change("a.md")],
            })
        );

        expect(last()).toBe("OBSync: main ⚠ 2");
    });

    it("活动态盖过仓库状态，动作结束后能恢复", () => {
        const { item, last } = createItem();
        const bar = new StatusBar({ item, getT: () => zhCN });

        bar.update(makeStatus({ branch: "main" }));
        bar.setActivity("pulling");
        expect(last()).toBe("OBSync: 正在拉取…");

        bar.setActivity("idle");
        expect(last()).toBe("OBSync: main");
    });

    it("状态不可得时退回插件名（不是报错）", () => {
        const { item, last } = createItem();
        const bar = new StatusBar({ item, getT: () => zhCN });

        bar.update(makeStatus({ branch: "main" }));
        bar.update(undefined);

        expect(last()).toBe("OBSync");
    });

    it("渲染失败不向外抛（状态栏坏掉绝不能打断同步本身）", () => {
        const item = {
            setText() {
                throw new Error("DOM is gone");
            },
        } as unknown as HTMLElement;

        const bar = new StatusBar({ item, getT: () => zhCN });

        expect(() => bar.update(makeStatus({ branch: "main" }))).not.toThrow();
        expect(() => bar.setActivity("pushing")).not.toThrow();
    });
});

describe("StatusBar 的语言", () => {
    it("活动态文案用当前语言", () => {
        const { item, last } = createItem();
        const bar = new StatusBar({ item, getT: () => zhCN });

        bar.setActivity("pushing");

        expect(last()).toBe("OBSync: 正在推送…");
    });

    /**
     * `StatusBar` 是**全项目唯一**把 `t` 在构造时快照下来的地方 ——
     * 其余（`SyncService` / `Notifier`）都是 `getT()` 用到时才取，
     * 所以它们切换语言后立刻跟着变。
     *
     * 而装配处是 `new StatusBar({ …, t: deps.getT() })`，`reload()` 也不重建它
     * （`item` 是稳定的 DOM 元素，重建会多挂一个状态栏条目）。
     * 于是用户在设置页切完语言，**状态栏还是旧语言**，一直到重启 Obsidian。
     */
    it("**切换语言后跟着变**（不是构造时快照）", () => {
        const { item, last } = createItem();
        let locale = zhCN;
        const bar = new StatusBar({ item, getT: () => locale });

        bar.setActivity("pushing");
        expect(last()).toBe("OBSync: 正在推送…");

        locale = en;
        bar.setActivity("committing");
        expect(last()).toBe("OBSync: Committing…");
    });
});
