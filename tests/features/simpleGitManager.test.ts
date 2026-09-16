import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { simpleGit } from "simple-git";
import { SimpleGitManager } from "../../src/features/sync/simpleGitManager";
import {
    ConflictError,
    GitNotRepoError,
    PushRejectedError,
} from "../../src/features/sync/errors";

/**
 * 直接对**真实 git 仓库**做测试（临时目录 + 系统 git 二进制）。
 *
 * 理由：git 的行为面（合并、冲突标记、引用更新）远比 mock 能表达的真实；
 * 单测 mock 出来的 simpleGitManager 只能证明「我们按预期拼了参数」，
 * 证明不了参数拼对后 git 真的会按我们的语义动作。这一层等价于 host 层的
 * live 测试，但它跑的是本地 git，不碰网络、不依赖配额，可以进 `pnpm test`。
 */

let root: string;

beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "obsync-git-"));
});

afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
});

/** 建一个带初始提交的仓库，返回 manager 与目录。 */
async function makeReadyRepo(name: string): Promise<{ manager: SimpleGitManager; dir: string }> {
    const dir = path.join(root, name);
    await fs.mkdir(dir);
    const manager = new SimpleGitManager({ baseDir: dir });
    await manager.init();
    // 提交身份只设在仓库本地，不碰全局配置。
    await simpleGit(dir).addConfig("user.email", "test@example.com");
    await simpleGit(dir).addConfig("user.name", "OBSync Test");
    // 不同 git 版本的 init 默认分支名不同，统一成 main 让断言稳定。
    await simpleGit(dir).raw(["checkout", "-b", "main"]);
    return { manager, dir };
}

async function makeBareRepo(name: string): Promise<string> {
    const dir = path.join(root, name);
    await fs.mkdir(dir);
    await simpleGit(dir).raw(["init", "--bare"]);
    return dir;
}

async function write(dir: string, file: string, content: string): Promise<void> {
    const filePath = path.join(dir, file);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, "utf8");
}

async function read(dir: string, file: string): Promise<string> {
    const content = await fs.readFile(path.join(dir, file), "utf8");
    // 测试机的全局 core.autocrlf=true 会把检出的 \n 变成 \r\n，
    // 断言关心的是内容语义，统一归一掉。
    return content.replace(/\r\n/g, "\n");
}

describe("仓库判定", () => {
    it("非仓库目录 isRepo 为 false，status 抛 GitNotRepoError", async () => {
        const dir = path.join(root, "plain");
        await fs.mkdir(dir);
        const manager = new SimpleGitManager({ baseDir: dir });

        await expect(manager.isRepo()).resolves.toBe(false);
        await expect(manager.status()).rejects.toBeInstanceOf(GitNotRepoError);
    });

    it("init 后 isRepo 为 true，且可再次 init（幂等）", async () => {
        const { manager } = await makeReadyRepo("idempotent");
        await expect(manager.isRepo()).resolves.toBe(true);
        await expect(manager.init()).resolves.toBeUndefined();
    });
});

describe("状态与提交", () => {
    it("未跟踪/暂存/未暂存三类状态映射正确", async () => {
        const { manager, dir } = await makeReadyRepo("status");
        await manager.stage([]);
        await manager.commit("init");

        await write(dir, "new.md", "new"); // untracked
        await write(dir, "tracked.md", "v1");
        await manager.stage(["tracked.md"]);
        await manager.commit("add tracked");
        await write(dir, "tracked.md", "v2"); // modified（未暂存）

        const status = await manager.status();

        expect(status.branch).toBe("main");
        expect(status.untracked.map((change) => change.path)).toEqual(["new.md"]);
        expect(status.staged).toHaveLength(0);
        expect(status.unstaged.map((change) => change.path)).toEqual(["tracked.md"]);
    });

    it("stage 全部 → commit 成功；空提交返回 false", async () => {
        const { manager, dir } = await makeReadyRepo("commit");
        await write(dir, "a.md", "hello");

        await manager.stage([]);
        await expect(manager.commit("first")).resolves.toBe(true);

        // 工作区干净时 commit 是无操作
        await expect(manager.commit("second")).resolves.toBe(false);
    });

    it("unstage 把已跟踪文件的修改退回未暂存", async () => {
        const { manager, dir } = await makeReadyRepo("unstage");
        await write(dir, "base.md", "base");
        await manager.stage([]);
        await manager.commit("init");

        await write(dir, "x.md", "v1");
        await manager.stage(["x.md"]);
        await manager.commit("add x");

        await write(dir, "x.md", "v2");
        await manager.stage(["x.md"]);
        expect((await manager.status()).staged).toHaveLength(1);

        await manager.unstage(["x.md"]);
        const status = await manager.status();
        expect(status.staged).toHaveLength(0);
        expect(status.unstaged.map((change) => change.path)).toEqual(["x.md"]);
    });

    it("unstage 在 HEAD 未出生时（全新仓库）也能退回", async () => {
        // restore --staged 需要 HEAD 作基准；全新仓库还没有提交，
        // 此时等价做法是把文件从 index 摘掉（退回 untracked）。
        const { manager, dir } = await makeReadyRepo("unstage-unborn");
        await write(dir, "fresh.md", "new");

        await manager.stage(["fresh.md"]);
        expect((await manager.status()).staged).toHaveLength(1);

        await manager.unstage(["fresh.md"]);
        const status = await manager.status();
        expect(status.staged).toHaveLength(0);
        expect(status.untracked.map((change) => change.path)).toEqual(["fresh.md"]);
    });

    it("log 返回按时间倒序的提交，短 hash 可用", async () => {
        const { manager, dir } = await makeReadyRepo("log");
        await write(dir, "a.md", "1");
        await manager.stage([]);
        await manager.commit("first commit");
        await write(dir, "b.md", "2");
        await manager.stage([]);
        await manager.commit("second commit");

        const entries = await manager.log(2);

        expect(entries).toHaveLength(2);
        expect(entries[0]!.message).toBe("second commit");
        expect(entries[0]!.hash).toMatch(/^[0-9a-f]{40}$/);
        expect(entries[0]!.shortHash).toHaveLength(7);
        expect(entries[0]!.author).toBe("OBSync Test");
        expect(entries[1]!.message).toBe("first commit");
    });
});

describe("分支", () => {
    it("创建、切换、列出、删除", async () => {
        const { manager, dir } = await makeReadyRepo("branches");
        // 没有任何提交的仓库里 `git branch` 输出为空，先造一个提交。
        await write(dir, "seed.md", "seed");
        await manager.stage([]);
        await manager.commit("seed");

        await manager.createBranch("feature/x");
        let branches = await manager.listBranches();
        expect(branches.find((branch) => branch.current)?.name).toBe("feature/x");

        await manager.checkout("main");
        branches = await manager.listBranches();
        expect(branches.find((branch) => branch.current)?.name).toBe("main");
        expect(branches.some((branch) => branch.name === "feature/x")).toBe(true);

        await manager.deleteBranch("feature/x");
        branches = await manager.listBranches();
        expect(branches.some((branch) => branch.name === "feature/x")).toBe(false);
    });
});

describe("远端：push / pull / 冲突", () => {
    interface Cluster {
        origin: string;
        a: { manager: SimpleGitManager; dir: string };
        b: { manager: SimpleGitManager; dir: string };
    }

    /**
     * 建一套「远端 + 两个克隆」的最小同步环境。
     * A 先提交并推送（形成 origin 的初始历史），B 从 origin 克隆。
     */
    async function makeCluster(): Promise<Cluster> {
        const origin = await makeBareRepo("origin.git");
        const { manager: aManager, dir: aDir } = await makeReadyRepo("clone-a");
        await simpleGit(aDir).raw(["remote", "add", "origin", origin]);
        await write(aDir, "shared.md", "base\n");
        await aManager.stage([]);
        await aManager.commit("base");
        await aManager.push();
        // push 不会更新裸仓库的 HEAD（它仍指向 init 时的默认分支），
        // 不改的话 clone 出来的 b 会停在未出生的 master 上、没有 tracking。
        await simpleGit(origin).raw(["symbolic-ref", "HEAD", "refs/heads/main"]);

        const bDir = path.join(root, "clone-b");
        await simpleGit(root).clone(origin, bDir);
        await simpleGit(bDir).addConfig("user.email", "test@example.com");
        await simpleGit(bDir).addConfig("user.name", "OBSync Test");
        const bManager = new SimpleGitManager({ baseDir: bDir });

        return { origin, a: { manager: aManager, dir: aDir }, b: { manager: bManager, dir: bDir } };
    }

    it("push 设置 upstream，status 报告 ahead/behind", async () => {
        const { b } = await makeCluster();

        const status = await b.manager.status();
        expect(status.branch).toBe("main");
        // 克隆自带 tracking
        expect(status.ahead).toBe(0);
        expect(status.behind).toBe(0);

        await write(b.dir, "new.md", "x");
        await b.manager.stage([]);
        await b.manager.commit("b change");
        const after = await b.manager.status();
        expect(after.ahead).toBe(1);
    });

    it("pull merge 把远端提交带下来", async () => {
        const { a, b } = await makeCluster();

        await write(a.dir, "shared.md", "from A\n");
        await a.manager.stage([]);
        await a.manager.commit("a writes");
        await a.manager.push();

        const outcome = await b.manager.pull("merge");
        expect(outcome.kind).toBe("pulled");
        expect(outcome.files).toBe(1);
        await expect(read(b.dir, "shared.md")).resolves.toBe("from A\n");
    });

    it("没有新东西时 pull 返回 up-to-date", async () => {
        const { b } = await makeCluster();
        await expect(b.manager.pull("merge")).resolves.toEqual({ kind: "up-to-date" });
    });

    it("pull reset 丢弃本地提交、以远端为准", async () => {
        const { a, b } = await makeCluster();

        // 本地提交一个远端没有的文件
        await write(b.dir, "local-only.md", "will be dropped\n");
        await b.manager.stage([]);
        await b.manager.commit("local only");

        // 远端前进
        await write(a.dir, "shared.md", "remote truth\n");
        await a.manager.stage([]);
        await a.manager.commit("a writes");
        await a.manager.push();

        await b.manager.pull("reset");

        await expect(read(b.dir, "shared.md")).resolves.toBe("remote truth\n");
        // reset 语义「以远端为准」：本地提交被丢弃，其中新增的文件一并消失。
        const status = await b.manager.status();
        expect(status.ahead).toBe(0);
        await expect(fs.access(path.join(b.dir, "local-only.md"))).rejects.toThrow();
    });

    it("双方改同一行时 pull 抛 ConflictError，abortMerge 可恢复", async () => {
        const { a, b } = await makeCluster();

        await write(a.dir, "shared.md", "version A\n");
        await a.manager.stage([]);
        await a.manager.commit("a edits");
        await a.manager.push();

        await write(b.dir, "shared.md", "version B\n");
        await b.manager.stage([]);
        await b.manager.commit("b edits");

        await expect(b.manager.pull("merge")).rejects.toBeInstanceOf(ConflictError);

        // 冲突现场：文件在 conflicted 列表里
        const conflicted = await b.manager.status();
        expect(conflicted.conflicted).toContain("shared.md");

        // 恢复：回到 pull 之前，B 的内容还在，冲突清空
        await b.manager.abortMerge();
        const after = await b.manager.status();
        expect(after.conflicted).toHaveLength(0);
        await expect(read(b.dir, "shared.md")).resolves.toBe("version B\n");
    });

    it("本地落后时 push 被拒绝（PushRejectedError）", async () => {
        const { a, b } = await makeCluster();

        // A 先推，B 在旧历史上提交
        await write(a.dir, "shared.md", "a first\n");
        await a.manager.stage([]);
        await a.manager.commit("a writes");
        await a.manager.push();

        await write(b.dir, "b-file.md", "b\n");
        await b.manager.stage([]);
        await b.manager.commit("b writes");

        await expect(b.manager.push()).rejects.toBeInstanceOf(PushRejectedError);
    });

    it("getRemoteUrl / setRemoteUrl 往返", async () => {
        const { origin, b } = await makeCluster();

        await expect(b.manager.getRemoteUrl()).resolves.toBe(origin);

        const other = await makeBareRepo("other.git");
        await b.manager.setRemoteUrl(other);
        await expect(b.manager.getRemoteUrl()).resolves.toBe(other);
    });
});
