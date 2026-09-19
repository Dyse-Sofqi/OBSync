import { describe, expect, it } from "vitest";
import { __setApiVersion } from "../stubs/obsidian";
import { Notifier } from "../../src/core/notice";
import { normalizeSettings } from "../../src/core/settings";
import { zhCN } from "../../src/core/i18n/locales/zh-cn";
import { SyncService } from "../../src/features/sync/syncService";
import { StatusBar } from "../../src/features/sync/statusBar";
import { SecretStore } from "../../src/core/secretStore";
import type { GitManager } from "../../src/features/sync/gitManager";
import { ConflictError, GitAuthError, PushRejectedError } from "../../src/features/sync/errors";
import type { CommitInfo, FileChange, RepoSize, RepoStatus, SyncOutcome, SyncStrategy } from "../../src/features/sync/types";
import { createFakeApp, type FakeApp } from "../helpers/fakeApp";

/**
 * syncService 的编排逻辑用**内存假 GitManager** 测 ——
 * git 真实行为已由 simpleGitManager.test.ts（真仓库）覆盖，
 * 这里只验证编排层：动作顺序、冲突指南、推送前置检查、串行化。
 */

/** 可编程假实现：记录调用序列，按脚本决定行为。 */
class FakeGit implements GitManager {
    calls: string[] = [];

    repo = true;
    staged: string[] = [];
    unstaged: string[] = [];
    untracked: string[] = [];
    conflicted: string[] = [];
    ahead = 0;
    /** 落后远端的提交数（`isFullyInSync` 也看它 —— 落后就不是「一致」）。 */
    behind = 0;
    remoteUrl: string | undefined = "https://github.com/owner/repo.git";

    /** pull 的脚本：默认 up-to-date；设为 "conflict" 时抛 ConflictError；设为 "pulled" 时正常拉取。 */
    pullScript: "up-to-date" | "conflict" | "pulled" = "up-to-date";

    /** 设成 promise 就把 `status()` 卡住 —— 用来验「后面的动作排在队列里」。 */
    waitBeforeStatus: Promise<void> | undefined;

    /** 设了就让它抛（验「动作失败时状态栏也要恢复活动态」）。 */
    pushError: Error | undefined;

    async isRepo(): Promise<boolean> {
        return this.repo;
    }
    async init(): Promise<void> {
        this.calls.push("init");
        this.repo = true;
    }
    async status(): Promise<RepoStatus> {
        this.calls.push("status");
        // 「队列真的串行吗」只能这样验：让一次状态查询卡住，后面的动作就得等。
        if (this.waitBeforeStatus) await this.waitBeforeStatus;
        if (!this.repo) throw new ConflictError("not repo", []);
        return {
            branch: "main",
            staged: this.staged.map((path) => ({ path, status: "added" as const })),
            unstaged: this.unstaged.map((path) => ({ path, status: "modified" as const })),
            untracked: this.untracked.map((path) => ({ path, status: "untracked" as const })),
            conflicted: [...this.conflicted],
            // 有远端（也就是有 upstream）时 ahead/behind 都是数字 —— 这正是
            // 真实 `git status -b` 的语义；两者为 null 只表示「没有跟踪的远端分支」。
            ahead: this.remoteUrl ? this.ahead : null,
            behind: this.remoteUrl ? this.behind : null,
        };
    }
    async stage(paths: string[]): Promise<void> {
        this.calls.push(paths.length === 0 ? "stage-all" : `stage:${paths.join(",")}`);
        const moving = paths.length === 0
            ? [...this.unstaged, ...this.untracked]
            : paths.filter((path) => this.unstaged.includes(path) || this.untracked.includes(path));
        this.staged.push(...moving);
        this.unstaged = this.unstaged.filter((path) => !moving.includes(path));
        this.untracked = this.untracked.filter((path) => !moving.includes(path));
    }
    async unstage(paths: string[]): Promise<void> {
        this.calls.push(`unstage:${paths.join(",")}`);
        this.staged = this.staged.filter((path) => !paths.includes(path));
    }
    async commit(message: string): Promise<boolean> {
        this.calls.push(`commit:${message}`);
        if (this.staged.length === 0) return false;
        this.staged = [];
        // 真实提交会让本地领先远端一个提交（不模拟这一步的话，「提交后是否
        // 与远端一致」永远算成一致 —— 而那正好是反的）。
        this.ahead += 1;
        return true;
    }
    async pull(_strategy: SyncStrategy): Promise<SyncOutcome> {
        this.calls.push(`pull:${_strategy}`);
        if (this.pullScript === "conflict") {
            throw new ConflictError("conflict", ["notes/会打架.md"]);
        }
        if (this.pullScript === "pulled") {
            // 拉取会带来新改动 → 编排层应再提交一次；远端提交也已合入本地
            this.untracked = ["pulled-note.md"];
            this.ahead += 1;
            return { kind: "pulled", files: 1 };
        }
        return { kind: "up-to-date" };
    }
    async abortMerge(): Promise<void> {
        this.calls.push("abortMerge");
        this.conflicted = [];
    }
    async push(): Promise<SyncOutcome> {
        this.calls.push("push");
        if (this.pushError) throw this.pushError;
        // 真实推送成功 = 本地不再领先远端（不模拟这一步的话，「推送后是否
        // 与远端一致」这类判断在测试里永远看不到一致的状态）。
        this.ahead = 0;
        return { kind: "pushed" };
    }
    async fetch(): Promise<void> {
        this.calls.push("fetch");
    }
    async listBranches(): Promise<Array<{ name: string; current: boolean }>> {
        return [{ name: "main", current: true }];
    }
    async checkout(branch: string): Promise<void> {
        this.calls.push(`checkout:${branch}`);
    }
    async createBranch(name: string): Promise<void> {
        this.calls.push(`createBranch:${name}`);
    }
    async deleteBranch(name: string): Promise<void> {
        this.calls.push(`deleteBranch:${name}`);
    }
    async log(_limit: number): Promise<CommitInfo[]> {
        return [];
    }
    async getRemoteUrl(): Promise<string | undefined> {
        return this.remoteUrl;
    }
    async setRemoteUrl(url: string): Promise<void> {
        this.remoteUrl = url;
    }
    async fileChanges(): Promise<FileChange[]> {
        return [];
    }

    /** 仓库体积：给一个固定值，「与远端一致」的提示里会带上它。 */
    sizeBytes = 12 * 1024 * 1024;
    sizeObjects = 1234;
    /** 设了就让它抛（验「读不到体积时不编数字」）。 */
    sizeError: Error | undefined;

    async repoSize(): Promise<RepoSize> {
        if (this.sizeError) throw this.sizeError;
        return { bytes: this.sizeBytes, objects: this.sizeObjects };
    }

    /** testRemoteAccess 的行为脚本 —— 诊断用例靠它模拟各种失败。 */
    remoteAccessScript: "ok" | "auth-failed" | "unreachable" = "ok";
    remoteRefCount = 3;

    async testRemoteAccess(): Promise<number> {
        this.calls.push("testRemoteAccess");
        if (this.remoteAccessScript === "auth-failed") {
            throw new GitAuthError("remote authentication failed (testing remote access: ...)");
        }
        if (this.remoteAccessScript === "unreachable") {
            throw new Error("Could not resolve host: gitee.com");
        }
        return this.remoteRefCount;
    }
}

function makeService(git: FakeGit, fake: FakeApp) {
    const notices: string[] = [];
    const notifier = new Notifier({ getShowNotices: () => true, getT: () => zhCN });
    notifier.error = (message: string) => notices.push(message);
    notifier.warn = (message: string) => notices.push(message);
    notifier.info = (message: string) => notices.push(message);
    notifier.success = (message: string) => notices.push(message);
    // 「与远端一致」的醒目提示走单独一个方法（带对勾、停留更久）——
    // 替身也要截住它，否则「说了什么」断言不到。
    notifier.synced = (message: string) => notices.push(message);

    // 状态栏元素直接给个假 DOM 节点 —— StatusBar 只调 setText 与 addClass
    // （后者用于把条目贴到状态栏最左，见 statusBar.ts）。
    const fakeItem = { setText: () => {}, addClass: () => {} } as unknown as HTMLElement;

    const settings = normalizeSettings({});
    settings.sync.commitMessage = "backup {{numFiles}}";

    const statusBar = new StatusBar({ item: fakeItem, getT: () => zhCN });
    // 记录活动状态变化 —— 「整条链路都显示正在提交」那个 bug 就靠这个断言。
    const activities: string[] = [];
    const realSetActivity = statusBar.setActivity.bind(statusBar);
    statusBar.setActivity = (activity: Parameters<StatusBar["setActivity"]>[0]) => {
        activities.push(activity);
        realSetActivity(activity);
    };

    const secretStore = new SecretStore(fake.app);
    const service = new SyncService(git, {
        app: fake.app,
        notifier,
        secretStore,
        getT: () => zhCN,
        getCommitTemplate: () => settings.sync.commitMessage,
        getStrategy: () => "merge",
        getConflictGuideName: () => zhCN.sync.conflictGuideFile,
    }, statusBar);

    return { service, notices, activities, secretStore };
}

describe("commitAll", () => {
    it("有更改时：暂存全部 → 按模板提交", async () => {
        __setApiVersion("1.13.1");
        const fake = createFakeApp();
        const git = new FakeGit();
        git.unstaged = ["a.md"];
        git.untracked = ["b.md"];
        const { service } = makeService(git, fake);

        const outcome = await service.commitAll();

        expect(outcome.kind).toBe("committed");
        expect(git.calls).toContain("stage-all");
        expect(git.calls).toContain("commit:backup 2");
    });

    it("没有更改时是空操作，不调 stage/commit", async () => {
        __setApiVersion("1.13.1");
        const fake = createFakeApp();
        const git = new FakeGit();
        const { service } = makeService(git, fake);

        const outcome = await service.commitAll();

        expect(outcome.kind).toBe("nothing-to-commit");
        expect(git.calls).not.toContain("stage-all");
    });
});

describe("sync（提交 → 拉取 → 提交 → 推送）", () => {
    it("拉取带来新文件时会二次提交再推送", async () => {
        __setApiVersion("1.13.1");
        const fake = createFakeApp();
        const git = new FakeGit();
        git.pullScript = "pulled";
        git.unstaged = ["local.md"];
        const { service } = makeService(git, fake);

        await service.sync();

        const commits = git.calls.filter((call) => call.startsWith("commit:"));
        expect(commits).toHaveLength(2); // 本地更改一次 + 拉取产物一次
        expect(git.calls.indexOf("push")).toBeGreaterThan(
            git.calls.lastIndexOf("pull:merge")
        );
    });

    it("拉取冲突时：写冲突指南 + 提示 + 中止链路（不推送）", async () => {
        __setApiVersion("1.13.1");
        const fake = createFakeApp();
        const git = new FakeGit();
        git.pullScript = "conflict";
        git.untracked = ["local.md"];
        const { service, notices } = makeService(git, fake);

        const outcome = await service.sync();

        expect(outcome.kind).toBe("conflict");
        // 指南文件落在库根目录，列出冲突文件
        expect(fake.files.has(zhCN.sync.conflictGuideFile)).toBe(true);
        const guide = fake.files.get(zhCN.sync.conflictGuideFile)!;
        expect(guide).toContain("notes/会打架.md");
        // 用户被明确告知
        expect(notices.some((message) => message.includes("1 个冲突"))).toBe(true);
        // 冲突后绝不提交（会写进冲突标记）、绝不 push
        const commitCalls = git.calls.filter((call) => call.startsWith("commit:"));
        expect(commitCalls).toHaveLength(1); // 只有 pull 之前那次本地提交
        expect(git.calls).not.toContain("push");
    });

    it("没有远端时 push 前置拦截", async () => {
        __setApiVersion("1.13.1");
        const fake = createFakeApp();
        const git = new FakeGit();
        git.remoteUrl = undefined;
        const { service, notices } = makeService(git, fake);

        await service.sync();

        expect(git.calls).not.toContain("push");
        expect(notices.some((message) => message.includes("远端"))).toBe(true);
    });

    it("本地无领先提交时不推送", async () => {
        __setApiVersion("1.13.1");
        const fake = createFakeApp();
        const git = new FakeGit();
        git.ahead = 0;
        const { service } = makeService(git, fake);

        await service.sync();

        expect(git.calls).not.toContain("push");
    });
});

describe("并发控制", () => {
    it("同一时刻只有一个动作在跑（isBusy + 串行）", async () => {
        __setApiVersion("1.13.1");
        const fake = createFakeApp();
        const git = new InstrumentedGit();
        git.unstaged = ["a.md"];
        const { service } = makeService(git as unknown as FakeGit, fake);

        let sawBusy = false;
        const first = service.commitAll();
        const second = service.commitAll();
        sawBusy = service.isBusy;
        await Promise.all([first, second]);

        expect(sawBusy).toBe(true);
        // 串行队列保证 git 调用永不重叠 —— 并发的 commitAll 不会互相踩 index。
        expect(git.maxInFlight).toBe(1);
    });
});

describe("冲突未解决时拒绝提交", () => {
    it("commitAll 抛 ConflictError，且完全不碰 index 与提交", async () => {
        const git = new FakeGit();
        const fake = createFakeApp();
        const { service } = makeService(git, fake);

        // 冲突文件在 `git status` 里是 `UU`，于是它**同时**算 staged 与 unstaged ——
        // 所以「有没有改动」的判断在有冲突时必然为真，光看 dirty 拦不住。
        git.conflicted = ["notes/会打架.md"];
        git.staged = ["notes/会打架.md"];
        git.unstaged = ["notes/会打架.md"];

        await expect(service.commitAll()).rejects.toBeInstanceOf(ConflictError);

        // 关键：不能调 stage / commit。否则 `git add -A` 会把
        // `<<<<<<<` / `>>>>>>>` 冲突标记当普通内容提交，把冲突写进历史。
        expect(git.calls).not.toContain("stage-all");
        expect(git.calls.some((call) => call.startsWith("commit:"))).toBe(false);
    });

    it("sync 在冲突未解决时也拒绝开跑（自动定时器会走到这条路）", async () => {
        const git = new FakeGit();
        const fake = createFakeApp();
        const { service } = makeService(git, fake);
        git.conflicted = ["notes/会打架.md"];

        await expect(service.sync()).rejects.toBeInstanceOf(ConflictError);

        // 冲突没解决就不该继续拉取与推送
        expect(git.calls.some((call) => call.startsWith("pull:"))).toBe(false);
        expect(git.calls).not.toContain("push");
    });

    it("没有冲突时正常提交（确认没误伤）", async () => {
        const git = new FakeGit();
        const fake = createFakeApp();
        const { service } = makeService(git, fake);
        git.untracked = ["new.md"];

        await expect(service.commitAll()).resolves.toMatchObject({ kind: "committed" });
    });
});

describe("isBusy 的语义", () => {
    it("排队中的任务也算忙，不只是正在跑的那个", async () => {
        const git = new InstrumentedGit();
        const fake = createFakeApp();
        const { service } = makeService(git, fake);

        expect(service.isBusy).toBe(false);

        const first = service.push();
        const second = service.push();

        // 用布尔量实现的话，第一个任务 settle 时就会变 false ——
        // 而此时第二个还在跑，于是「忙」的状态在真正有活干时报"空闲"。
        expect(service.isBusy).toBe(true);

        await Promise.all([first, second]);
        expect(service.isBusy).toBe(false);
    });
});

describe("sync 的阶段状态", () => {
    it("按阶段更新活动状态，而不是整条链路都显示「正在提交」", async () => {
        const git = new FakeGit();
        const fake = createFakeApp();
        const { service, activities } = makeService(git, fake);

        git.untracked = ["a.md"];
        git.pullScript = "pulled"; // 拉到东西 → 会二次提交
        git.ahead = 1;

        await service.sync();

        expect(activities).toEqual(["committing", "pulling", "committing", "pushing", "idle"]);
        // 最后那个 `idle` 是必需的：没有它状态栏会永远停在「正在推送…」，
        // 连分支 / ahead / behind / 脏文件数都不再显示（见下面那组用例）。
    });
});

/** 给 status 加延迟与并发计数，直接观察编排层的串行化效果。 */
class InstrumentedGit extends FakeGit {
    inFlight = 0;
    maxInFlight = 0;

    override async status(): Promise<RepoStatus> {
        this.inFlight += 1;
        this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
        try {
            await new Promise((resolve) => setTimeout(resolve, 5));
            return await super.status();
        } finally {
            this.inFlight -= 1;
        }
    }
}

describe("diagnose（同步配置诊断）", () => {
    it("一切正常时全部通过，且带出远端与引用数", async () => {
        const git = new FakeGit();
        const fake = createFakeApp();
        const { service, secretStore } = makeService(git, fake);
        secretStore.setToken("github", "tok");

        const report = await service.diagnose();

        expect(report.ok).toBe(true);
        expect(report.checks.map((check) => check.id)).toEqual([
            "git",
            "repo",
            "remote",
            "platform",
            "access",
        ]);
        expect(report.checks.every((check) => check.status === "ok")).toBe(true);
        // 远端 URL 与引用数作为 detail 带出来，方便用户核对
        expect(report.checks.find((c) => c.id === "remote")?.detail).toContain("github.com");
        expect(report.checks.find((c) => c.id === "access")?.detail).toBe("3");
    });

    it("**鉴权失败时明确报出来** —— 这是这个功能存在的理由", async () => {
        // 令牌填了不代表有效，光看设置项判断不了。只有真的连一次才知道。
        const git = new FakeGit();
        const fake = createFakeApp();
        const { service, secretStore } = makeService(git, fake);
        secretStore.setToken("github", "expired-token");
        git.remoteAccessScript = "auth-failed";

        const report = await service.diagnose();

        expect(report.ok).toBe(false);
        const access = report.checks.find((check) => check.id === "access");
        expect(access?.status).toBe("failed");
        // detail 是**本地化**的文案（走 describeSyncError），用户能直接看懂
        expect(access?.detail).toBe(zhCN.sync.gitAuthFailed);
    });

    it("网络不通与鉴权失败要能区分（引导完全不同）", async () => {
        const git = new FakeGit();
        const fake = createFakeApp();
        const { service } = makeService(git, fake);
        git.remoteAccessScript = "unreachable";

        const report = await service.diagnose();

        const detail = report.checks.find((check) => check.id === "access")?.detail ?? "";
        expect(report.ok).toBe(false);
        expect(detail).not.toBe(zhCN.sync.gitAuthFailed);
        expect(detail).toContain("gitee.com"); // 原始网络错误信息透传
    });

    it("不是 git 仓库时只报到那一步，不继续往下测", async () => {
        const git = new FakeGit();
        const fake = createFakeApp();
        const { service } = makeService(git, fake);
        git.repo = false;

        const report = await service.diagnose();

        expect(report.ok).toBe(false);
        expect(report.checks.map((c) => c.id)).toEqual(["git", "repo"]);
        expect(report.checks[1]!.status).toBe("failed");
        // 没到访问那一步就不该去连远端
        expect(git.calls).not.toContain("testRemoteAccess");
    });

    it("没配远端时停在 remote 那一步", async () => {
        const git = new FakeGit();
        const fake = createFakeApp();
        const { service } = makeService(git, fake);
        git.remoteUrl = undefined;

        const report = await service.diagnose();

        expect(report.checks.map((c) => c.id)).toEqual(["git", "repo", "remote"]);
        expect(report.checks[2]!.status).toBe("failed");
    });

    it("平台认不出时标为 skipped（不是失败），并且仍然去测访问", async () => {
        // 认不出平台只意味着**注入不了令牌**，用户仍可走系统凭据助手 ——
        // 报成失败会误导人去改一个没问题的配置。
        const git = new FakeGit();
        const fake = createFakeApp();
        const { service } = makeService(git, fake);
        git.remoteUrl = "https://gitlab.com/owner/repo.git";

        const report = await service.diagnose();

        expect(report.checks.find((c) => c.id === "platform")?.status).toBe("skipped");
        expect(git.calls).toContain("testRemoteAccess");
    });

    it("没配令牌时 platform 标为 skipped 而不是 failed（公开仓库不需要令牌）", async () => {
        const git = new FakeGit();
        const fake = createFakeApp();
        const { service } = makeService(git, fake);

        const report = await service.diagnose();

        expect(report.checks.find((c) => c.id === "platform")?.status).toBe("skipped");
        expect(report.ok).toBe(true);
    });

    it("是**只读**的：不碰 stage / commit / push", async () => {
        const git = new FakeGit();
        const fake = createFakeApp();
        const { service } = makeService(git, fake);
        git.untracked = ["a.md"];

        await service.diagnose();

        expect(git.calls).not.toContain("stage-all");
        expect(git.calls.some((call) => call.startsWith("commit:"))).toBe(false);
        expect(git.calls).not.toContain("push");
    });

    /**
     * 报告里的 `detail` 会被设置页**渲染出来**，所以它是「令牌会不会上屏」的
     * 最后一个关口 —— 而 `add()` 是这个报告唯一的写入点，脱敏放在那里。
     *
     * 触发路径很现实：库的远端**本来就**写着带令牌的地址
     * （用户从前用别的方式配的），或他在「编辑远端地址」里明知代价还是粘了进来
     * （弹窗会警告，但刻意不拦）。
     */
    const TOKEN = "ghp_MUST_NOT_LEAK_0000";

    it("远端地址自带凭据时，报告里的地址已脱敏但地址本身还在", async () => {
        const git = new FakeGit();
        const fake = createFakeApp();
        const { service } = makeService(git, fake);
        git.remoteUrl = `https://oauth2:${TOKEN}@gitee.com/owner/repo.git`;

        const report = await service.diagnose();

        // 整份报告都不该出现令牌 —— 逐条扫，而不是只看 remote 那条。
        // 漏了后面新加的检查条目正是这类改动最容易留下的洞。
        for (const check of report.checks) {
            expect(check.detail ?? "").not.toContain(TOKEN);
        }

        const detail = report.checks.find((c) => c.id === "remote")?.detail ?? "";
        // 地址本身要留着 —— 报告的作用就是让用户核对自己配了什么
        expect(detail).toContain("gitee.com/owner/repo.git");
        expect(detail).toContain("oauth2:***@");
    });

    it("平台认不出时，skipped 那条里的地址也脱敏（另一条分支）", async () => {
        const git = new FakeGit();
        const fake = createFakeApp();
        const { service } = makeService(git, fake);
        git.remoteUrl = `https://oauth2:${TOKEN}@gitlab.com/owner/repo.git`;

        const report = await service.diagnose();
        const detail = report.checks.find((c) => c.id === "platform")?.detail ?? "";

        expect(detail).not.toContain(TOKEN);
        expect(detail).toContain("gitlab.com");
    });

    it("查询串里的令牌同样处理（不只是 userinfo）", async () => {
        const git = new FakeGit();
        const fake = createFakeApp();
        const { service } = makeService(git, fake);
        git.remoteUrl = `https://gitee.com/owner/repo.git?access_token=${TOKEN}`;

        const report = await service.diagnose();

        for (const check of report.checks) {
            expect(check.detail ?? "").not.toContain(TOKEN);
        }
    });
});

describe("initRepo 与 .gitignore", () => {
    it("初始化时建一份默认 .gitignore（避免同步 workspace.json）", async () => {
        const git = new FakeGit();
        const fake = createFakeApp();
        const { service } = makeService(git, fake);

        const result = await service.initRepo();

        expect(git.calls).toContain("init");
        expect(result.createdGitignore).toBe(true);
        const content = fake.files.get(".gitignore") ?? "";
        // 这条规则是这个功能存在的理由：workspace.json 每次开关标签都变，
        // 多设备同步它必然冲突，而且冲突内容是整份 JSON，没法手工合并。
        expect(content).toContain(".obsidian/workspace.json");
        expect(content).toContain(".obsidian/workspace-mobile.json");
    });

    it("**已有 .gitignore 时绝不覆盖**（用户可能有自己的规则）", async () => {
        const git = new FakeGit();
        const fake = createFakeApp({ ".gitignore": "# 我自己的规则\n*.tmp\n" });
        const { service } = makeService(git, fake);

        const result = await service.initRepo();

        expect(result.createdGitignore).toBe(false);
        expect(fake.files.get(".gitignore")).toBe("# 我自己的规则\n*.tmp\n");
    });

    it("建不了 .gitignore 也不让初始化失败（只是少一层保护）", async () => {
        const git = new FakeGit();
        const fake = createFakeApp();
        const { service } = makeService(git, fake);
        fake.failWriteOn = (path) => path.endsWith(".gitignore");

        await expect(service.initRepo()).resolves.toEqual({ createdGitignore: false });
        expect(git.calls).toContain("init");
    });
});

describe("提交信息的文件数按路径去重", () => {
    it("「改了又暂存」的文件不会被算成两个", async () => {
        // 同一个根因的另一处表现：mapStatus 按 git status 的两位状态位分别归类，
        // AM / MM 的文件同时进 staged 与 unstaged。不去重的话
        // {{numFiles}} 会多算、{{files}} 会把同一个文件列两遍。
        const git = new FakeGit();
        const fake = createFakeApp();
        const { service } = makeService(git, fake);
        git.staged = ["a.md"];
        git.unstaged = ["a.md"]; // 同一个文件，两个状态位都非空

        await service.commitAll();

        const commitCall = git.calls.find((call) => call.startsWith("commit:"));
        expect(commitCall).toBeDefined();
        // 模板是 "backup {{numFiles}}"，一个文件就该是 1
        expect(commitCall).toBe("commit:backup 1");
    });
});

/**
 * 仓库同步视图里的逐文件操作。
 *
 * 这些动作**必须走串行队列**：视图里点一下「暂存」的同时，自动提交定时器
 * 到点了 —— 两条 git 命令并发写索引是真实会发生的。视图原来切分支就是直接
 * 调 `git.checkout`，绕过了队列。
 *
 * 队列是「排成一条链」，所以「有没有走队列」不能只看结果 —— 得让队列
 * **忙着**（一个慢动作还没结束），再看第二个动作有没有等它。
 */
describe("视图的逐文件操作", () => {
    it("暂存指定文件 → 只 stage 这些路径，并刷新状态", async () => {
        const git = new FakeGit();
        const fake = createFakeApp();
        const { service } = makeService(git, fake);
        git.unstaged = ["a.md", "b.md"];

        await service.stageFiles(["a.md"]);

        expect(git.calls).toContain("stage:a.md");
        expect(git.staged).toEqual(["a.md"]);
        // 刷了状态：视图重绘、状态栏更新都靠它
        expect(git.calls.filter((call) => call === "status").length).toBeGreaterThan(0);
    });

    it("路径为空时是空操作（不碰 git，也不报错）", async () => {
        // 判空在入队**之前**：整组都已暂存时不该白跑一次 git。
        const git = new FakeGit();
        const fake = createFakeApp();
        const { service } = makeService(git, fake);

        await service.stageFiles([]);
        await service.unstageFiles([]);

        expect(git.calls).toEqual([]);
    });

    it("取消暂存只动指定的文件", async () => {
        const git = new FakeGit();
        const fake = createFakeApp();
        const { service } = makeService(git, fake);
        git.staged = ["a.md", "b.md"];

        await service.unstageFiles(["b.md"]);

        expect(git.calls).toContain("unstage:b.md");
        expect(git.staged).toEqual(["a.md"]);
    });

    it("切分支走队列（不再绕过同步动作直接调 git）", async () => {
        const git = new FakeGit();
        const fake = createFakeApp();
        const { service } = makeService(git, fake);

        await service.checkoutBranch("dev");

        expect(git.calls).toContain("checkout:dev");
    });

    it("**与正在跑的动作排成一条链**：慢提交没结束时暂存不会插队", async () => {
        const git = new FakeGit();
        const fake = createFakeApp();
        const { service } = makeService(git, fake);
        git.unstaged = ["a.md"];

        // 让一次提交卡在半路（模拟网络慢的拉取 / 大仓库的提交）
        let release: (() => void) | undefined;
        git.waitBeforeStatus = new Promise<void>((resolve) => {
            release = resolve;
        });

        const slow = service.commitAll();
        const staged = service.stageFiles(["a.md"]);
        await Promise.resolve();

        // 提交还卡着 → 暂存必须还没发生
        expect(git.calls).not.toContain("stage:a.md");

        git.waitBeforeStatus = undefined;
        release?.();
        await slow;
        await staged;

        expect(git.calls).toContain("stage:a.md");
    });
});

/**
 * 状态栏的「正在…」必须**有始有终**。
 *
 * 这里锁的是一个真 bug：`activity` 是 `StatusBar` 的实例状态，而它的 render()
 * 在活动态下**只显示活动文案并直接返回** —— 所以只要没人把它改回 idle，
 * 状态栏就永远停在「正在推送…」，连分支 / ahead / behind / 脏文件数都不再显示，
 * 一直到重载插件。而在此之前 `setActivity("idle")` 在整个 src 里从没出现过。
 *
 * 用户报的原话：「尝试推送后一直看到正在推送」—— 他点的「推送」其实早就结束了
 * （本地与远端一致，没有任何需要推的东西），界面却还在说它正在进行。
 *
 * **这两条只能测服务层**：`statusBar.test.ts` 里那条「动作结束后能恢复」
 * 是手工调 `setActivity("idle")` 验的，也就是说它验的是「这个 API 能恢复」，
 * 而不是「服务真的会调它」—— 后者才是缺的那一环。
 */
describe("状态栏活动态：动作结束后必须恢复", () => {
    it("提交 / 拉取 / 推送 / 完整同步结束后都回到 idle", async () => {
        for (const run of [
            (service: SyncService) => service.commitAll(),
            (service: SyncService) => service.pull(),
            (service: SyncService) => service.push(),
            (service: SyncService) => service.sync(),
        ]) {
            const git = new FakeGit();
            const fake = createFakeApp();
            const { service, activities } = makeService(git, fake);
            git.unstaged = ["a.md"];

            await run(service);

            expect(activities[activities.length - 1]).toBe("idle");
        }
    });

    it("**出错时也要恢复** —— 失败更需要恢复，用户正盯着屏幕等结果", async () => {
        const git = new FakeGit();
        const fake = createFakeApp();
        const { service, activities } = makeService(git, fake);
        // 推送被远端拒绝：错误会上抛（由 UI 弹提示），但状态栏不能停在活动态
        git.ahead = 1;
        git.pushError = new PushRejectedError("push rejected (testing)");

        await expect(service.push()).rejects.toBeInstanceOf(PushRejectedError);

        expect(activities[activities.length - 1]).toBe("idle");
    });
});

/**
 * 「推送」到底是单纯的推送，还是提交 + 推送？
 *
 * 用户的提问原话：「推送按钮是单纯的推送还是提交全部加推送，如果是后者应该写清楚」。
 * 答案是**单纯的推送**（`git.push` 只把已有的提交送上去），所以这里钉住两件事：
 *
 * 1. 它的行为就是推送 —— 不留提交；
 * 2. 用户带着未提交的改动点它时，必须**说清楚**（否则他会以为改动已经上去了）。
 */
describe("推送：本地与远端一致时的反馈", () => {
    it("**已经与远端一致时，给的是那条醒目的「已同步」**（而不是「没有需要推送的内容」）", async () => {
        // 用户的要求：「当提交结束与远端一致时，给出醒目的反馈」。
        // 一致时那句「没有需要推送的内容」信息量太低 —— 它没说结论是「一切正常」。
        const git = new FakeGit();
        const fake = createFakeApp();
        const { service, notices } = makeService(git, fake);
        git.ahead = 0;

        const outcome = await service.push({ announceIfUpToDate: true });

        expect(outcome.kind).toBe("up-to-date");
        expect(notices).toContain(zhCN.sync.syncedInSync("12 MB"));
        expect(notices).not.toContain(zhCN.sync.pushUpToDate);
    });

    it("**落后远端时不说「与远端一致」**（原来那句话在这个状态下是假的）", async () => {
        // ahead === 0 只说明本地没有新提交，完全可能还落后远端（别人推过）。
        const git = new FakeGit();
        const fake = createFakeApp();
        const { service, notices } = makeService(git, fake);
        git.ahead = 0;
        git.behind = 3;

        await service.push({ announceIfUpToDate: true });

        expect(notices).toContain(zhCN.sync.pushUpToDate);
        expect(notices.some((message) => message.includes("与远端一致"))).toBe(false);
    });

    it("**有未提交的改动时，说清「推送只发送已提交的内容」并给出数量**", async () => {
        // 这才是最容易误会的那个状态：用户带着一堆改动点推送，
        // 等的是「我的改动上去了」，而推送一个字节都不会带上它们。
        const git = new FakeGit();
        const fake = createFakeApp();
        const { service, notices } = makeService(git, fake);
        git.ahead = 0;
        git.staged = ["a.md"];
        git.unstaged = ["b.md", "c.md"];

        await service.push({ announceIfUpToDate: true });

        expect(notices).toContain(zhCN.sync.pushNeedsCommit(3));
        // 而不是那句听起来像「一切正常」的
        expect(notices).not.toContain(zhCN.sync.pushUpToDate);
    });

    it("数量与仓库同步视图里的列表同一套规则（去重、排除冲突）", async () => {
        const git = new FakeGit();
        const fake = createFakeApp();
        const { service, notices } = makeService(git, fake);
        git.ahead = 0;
        git.staged = ["a.md"];
        git.unstaged = ["a.md"]; // 「改了又暂存」，只算一个
        git.conflicted = ["打架.md"]; // 冲突文件在面板里是单独一栏

        await service.push({ announceIfUpToDate: true });

        expect(notices).toContain(zhCN.sync.pushNeedsCommit(1));
    });

    it("推送成功后若仍有未提交的改动，也要说明（不能让人以为工作区一起上去了）", async () => {
        const git = new FakeGit();
        const fake = createFakeApp();
        const { service, notices } = makeService(git, fake);
        git.ahead = 2;
        git.unstaged = ["b.md"];

        const outcome = await service.push({ announceIfUpToDate: true });

        expect(outcome.kind).toBe("pushed");
        expect(notices).toContain(zhCN.sync.pushDonePending(1));
        expect(notices).not.toContain(zhCN.sync.pushDone);
    });

    it("推送成功且工作区干净时，同样给那条醒目的「已同步」", async () => {
        const git = new FakeGit();
        const fake = createFakeApp();
        const { service, notices } = makeService(git, fake);
        git.ahead = 2;

        const outcome = await service.push({ announceIfUpToDate: true });

        expect(outcome.kind).toBe("pushed");
        // 「已同步」比「已推送到远端」信息更全：它同时确认了没有遗留的改动。
        expect(notices).toContain(zhCN.sync.syncedInSync("12 MB"));
    });

    it("**推送不会顺手提交** —— 有未提交改动时也只调 push", async () => {
        const git = new FakeGit();
        const fake = createFakeApp();
        const { service } = makeService(git, fake);
        git.ahead = 2;
        git.unstaged = ["b.md"];

        await service.push({ announceIfUpToDate: true });

        expect(git.calls).toContain("push");
        expect(git.calls).not.toContain("stage-all");
        expect(git.calls.some((call) => call.startsWith("commit:"))).toBe(false);
    });

    it("自动定时器**不**说这些话（每 N 分钟弹一次是噪音）", async () => {
        const git = new FakeGit();
        const fake = createFakeApp();
        const { service, notices } = makeService(git, fake);
        git.ahead = 0;
        git.unstaged = ["b.md"];

        await service.push();

        expect(notices).not.toContain(zhCN.sync.pushUpToDate);
        expect(notices).not.toContain(zhCN.sync.pushNeedsCommit(1));
    });

    it("没有远端时只说「还没配置远端」，不叠加一句「无需推送」", async () => {
        // 两句一起说会让人以为远端一切正常。
        const git = new FakeGit();
        const fake = createFakeApp();
        const { service, notices } = makeService(git, fake);
        git.remoteUrl = undefined;

        await service.push({ announceIfUpToDate: true });

        expect(notices).toContain(zhCN.sync.noRemote);
        expect(notices).not.toContain(zhCN.sync.pushUpToDate);
        expect(notices).not.toContain(zhCN.sync.pushNeedsCommit(1));
    });

    it("真有提交要推时走真实推送，不说不该说的话", async () => {
        const git = new FakeGit();
        const fake = createFakeApp();
        const { service, notices } = makeService(git, fake);
        git.ahead = 2;

        const outcome = await service.push({ announceIfUpToDate: true });

        expect(outcome.kind).toBe("pushed");
        expect(notices).not.toContain(zhCN.sync.pushUpToDate);
    });
});

/**
 * 「提交/同步结束且与远端一致」时的**醒目**反馈。
 *
 * 用户的要求：「当提交结束与远端一致时，给出醒目的反馈」。它走
 * `Notifier.synced`（带对勾、停留更久），而不是一闪而过的普通提示；
 * 判据是 `isFullyInSync`（干净 + 不领先 + 不落后 + 无冲突 + 有 upstream）。
 */
describe("与远端一致时的醒目反馈", () => {
    it("立即同步（用户主动）结束且一致 → 说「已同步」并带上仓库体积", async () => {
        const git = new FakeGit();
        const fake = createFakeApp();
        const { service, notices } = makeService(git, fake);

        await service.sync({ announceInSync: true });

        expect(notices).toContain(zhCN.sync.syncedInSync("12 MB"));
    });

    it("**自动定时器不说**（每 N 分钟弹一次是噪音）", async () => {
        const git = new FakeGit();
        const fake = createFakeApp();
        const { service, notices } = makeService(git, fake);

        await service.sync();

        expect(notices).not.toContain(zhCN.sync.syncedInSync("12 MB"));
    });

    it("提交后有未推送的提交 → 说清「还没推上去」（不能说成已同步）", async () => {
        const git = new FakeGit();
        const fake = createFakeApp();
        const { service, notices } = makeService(git, fake);
        git.unstaged = ["a.md"];

        await service.commitAll({ announce: true });

        expect(notices).toContain(zhCN.sync.commitsNotPushed(1));
        expect(notices).not.toContain(zhCN.sync.syncedInSync("12 MB"));
    });

    it("没有更改可提交、而且本来就在远端一致 → 说「已同步」", async () => {
        const git = new FakeGit();
        const fake = createFakeApp();
        const { service, notices } = makeService(git, fake);

        await service.commitAll({ announce: true });

        expect(notices).toContain(zhCN.sync.syncedInSync("12 MB"));
    });

    it("**读不到体积时不编数字** —— 只说状态", async () => {
        const git = new FakeGit();
        const fake = createFakeApp();
        const { service, notices } = makeService(git, fake);
        git.sizeError = new Error("count-objects failed");

        await service.sync({ announceInSync: true });

        expect(notices).toContain(zhCN.sync.syncedInSync(undefined));
        expect(notices.some((message) => message.includes("0 B"))).toBe(false);
    });

    it("落后远端时不说「一致」（一致 = 不领先**且**不落后）", async () => {
        const git = new FakeGit();
        const fake = createFakeApp();
        const { service, notices } = makeService(git, fake);
        git.behind = 2;

        await service.sync({ announceInSync: true });

        expect(notices.some((message) => message.includes("已同步"))).toBe(false);
    });
});

describe("待提交改动的体积", () => {
    it("把有改动的文件大小加起来（删除的文件算 0）", async () => {
        const git = new FakeGit();
        // 「a.md」在库里且内容是 5 个字节；「gone.md」已被删除（stat 取不到）
        const fake = createFakeApp({ "a.md": "hello", "b.md": "world!" });
        const { service } = makeService(git, fake);
        const status = {
            branch: "main",
            staged: [],
            unstaged: [
                { path: "a.md", status: "modified" as const },
                { path: "gone.md", status: "deleted" as const },
            ],
            untracked: [{ path: "b.md", status: "untracked" as const }],
            conflicted: [],
            ahead: 0,
            behind: 0,
        };

        // 5 + 6 = 11（gone.md 取不到，按 0 计）
        await expect(service.pendingChangeBytes(status)).resolves.toBe(11);
    });

    it("与视图列表同一套规则：去重、排除冲突文件", async () => {
        const git = new FakeGit();
        const fake = createFakeApp({ "a.md": "hello" });
        const { service } = makeService(git, fake);
        const status = {
            branch: "main",
            staged: [{ path: "a.md", status: "modified" as const }],
            unstaged: [{ path: "a.md", status: "modified" as const }],
            untracked: [],
            conflicted: ["打架.md"],
            ahead: 0,
            behind: 0,
        };

        // a.md 只算一次；冲突文件在面板里是单独一栏，不算进「待提交改动」
        await expect(service.pendingChangeBytes(status)).resolves.toBe(5);
    });

    it("没有改动时是 0", async () => {
        const git = new FakeGit();
        const fake = createFakeApp();
        const { service } = makeService(git, fake);

        await expect(
            service.pendingChangeBytes({
                branch: "main",
                staged: [],
                unstaged: [],
                untracked: [],
                conflicted: [],
                ahead: 0,
                behind: 0,
            })
        ).resolves.toBe(0);
    });
});

describe("状态订阅（仓库同步视图）", () => {
    it("refresh 会把状态推给订阅者", async () => {
        const git = new FakeGit();
        const fake = createFakeApp();
        const { service } = makeService(git, fake);
        const seen: Array<RepoStatus | undefined> = [];
        service.onStatusChange((status) => seen.push(status));

        await service.refresh();

        expect(seen).toHaveLength(1);
        expect(seen[0]?.branch).toBe("main");
    });

    it("动作结束后也会推一次（视图不必自己轮询）", async () => {
        // 自动提交定时器到点时视图是关不掉的 —— 它得知道自己该重绘了。
        const git = new FakeGit();
        const fake = createFakeApp();
        const { service } = makeService(git, fake);
        git.unstaged = ["a.md"];
        let count = 0;
        service.onStatusChange(() => (count += 1));

        await service.commitAll();

        expect(count).toBeGreaterThan(0);
    });

    it("状态取不到时推 undefined（视图据此显示「不是仓库」）", async () => {
        const git = new FakeGit();
        const fake = createFakeApp();
        const { service } = makeService(git, fake);
        git.repo = false;
        const seen: Array<RepoStatus | undefined> = [];
        service.onStatusChange((status) => seen.push(status));

        await service.refresh();

        expect(seen).toEqual([undefined]);
    });

    it("退订之后不再收到（视图关闭时必须退订）", async () => {
        const git = new FakeGit();
        const fake = createFakeApp();
        const { service } = makeService(git, fake);
        let count = 0;
        const unsubscribe = service.onStatusChange(() => (count += 1));

        await service.refresh();
        unsubscribe();
        await service.refresh();

        expect(count).toBe(1);
    });

    it("订阅者抛错不影响同步本身", async () => {
        const git = new FakeGit();
        const fake = createFakeApp();
        const { service } = makeService(git, fake);
        service.onStatusChange(() => {
            throw new Error("界面炸了");
        });

        await expect(service.refresh()).resolves.toBeDefined();
    });
});
