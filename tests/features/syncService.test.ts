import { describe, expect, it } from "vitest";
import type { App } from "obsidian";
import { __setApiVersion } from "../stubs/obsidian";
import { Notifier } from "../../src/core/notice";
import { normalizeSettings } from "../../src/core/settings";
import { zhCN } from "../../src/core/i18n/locales/zh-cn";
import { SyncService } from "../../src/features/sync/syncService";
import { StatusBar } from "../../src/features/sync/statusBar";
import type { GitManager } from "../../src/features/sync/gitManager";
import { ConflictError } from "../../src/features/sync/errors";
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
}

function makeService(git: FakeGit, fake: FakeApp) {
    const notices: string[] = [];
    const notifier = new Notifier({ getShowNotices: () => true, getT: () => zhCN });
    notifier.error = (message: string) => notices.push(message);
    notifier.warn = (message: string) => notices.push(message);

    const app = {
        vault: fake.app.vault,
        workspace: {
            addStatusBarItem: () => ({ setText: () => {} }),
        },
    } as unknown as App;

    const settings = normalizeSettings({});
    settings.sync.commitMessage = "backup {{numFiles}}";

    const service = new SyncService(git, {
        app,
        notifier,
        getT: () => zhCN,
        getCommitTemplate: () => settings.sync.commitMessage,
        getStrategy: () => "merge",
        getConflictGuideName: () => zhCN.sync.conflictGuideFile,
    }, new StatusBar({ app, t: zhCN }));

    return { service, notices };
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
