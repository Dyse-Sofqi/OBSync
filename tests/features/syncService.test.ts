import { describe, expect, it } from "vitest";
import { __setApiVersion } from "../stubs/obsidian";
import { Notifier } from "../../src/core/notice";
import { normalizeSettings } from "../../src/core/settings";
import { zhCN } from "../../src/core/i18n/locales/zh-cn";
import { SyncService } from "../../src/features/sync/syncService";
import { StatusBar } from "../../src/features/sync/statusBar";
import { SecretStore } from "../../src/core/secretStore";
import type { GitManager } from "../../src/features/sync/gitManager";
import { ConflictError, GitAuthError } from "../../src/features/sync/errors";
import type { CommitInfo, FileChange, RepoStatus, SyncOutcome, SyncStrategy } from "../../src/features/sync/types";
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
    remoteUrl: string | undefined = "https://github.com/owner/repo.git";

    /** pull 的脚本：默认 up-to-date；设为 "conflict" 时抛 ConflictError；设为 "pulled" 时正常拉取。 */
    pullScript: "up-to-date" | "conflict" | "pulled" = "up-to-date";

    async isRepo(): Promise<boolean> {
        return this.repo;
    }
    async init(): Promise<void> {
        this.calls.push("init");
        this.repo = true;
    }
    async status(): Promise<RepoStatus> {
        this.calls.push("status");
        if (!this.repo) throw new ConflictError("not repo", []);
        return {
            branch: "main",
            staged: this.staged.map((path) => ({ path, status: "added" as const })),
            unstaged: this.unstaged.map((path) => ({ path, status: "modified" as const })),
            untracked: this.untracked.map((path) => ({ path, status: "untracked" as const })),
            conflicted: [...this.conflicted],
            ahead: this.remoteUrl ? this.ahead : null,
            behind: null,
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

    // 状态栏元素直接给个假 DOM 节点 —— StatusBar 只会调 setText。
    const fakeItem = { setText: () => {} } as unknown as HTMLElement;

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

        expect(activities).toEqual(["committing", "pulling", "committing", "pushing"]);
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
