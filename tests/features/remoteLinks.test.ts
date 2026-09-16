import { describe, expect, it } from "vitest";
import {
    fileHistoryOnRemoteUrl,
    fileOnRemoteUrl,
    resolveRemoteContext,
} from "../../src/features/sync/remoteLinks";
import type { GitManager } from "../../src/features/sync/gitManager";

/**
 * 「在远端打开」的 URL 构造。
 *
 * 参考项目 obsidian-git 的对应能力把 github.com 硬编码在正则与模板里，
 * 加 Gitee 要改一遍；这里模板留在 host 层，所以两个平台共用同一段逻辑 ——
 * 这组用例就是用来锁住「两个平台都对」的。
 */

/** 只实现 remoteLinks 用到的两个方法。 */
function fakeGit(options: {
    remoteUrl?: string;
    branches?: Array<{ name: string; current: boolean }>;
}): GitManager {
    return {
        getRemoteUrl: async () => options.remoteUrl,
        listBranches: async () => options.branches ?? [],
    } as unknown as GitManager;
}

describe("resolveRemoteContext", () => {
    it("识别 Gitee 远端并取当前分支", async () => {
        const context = await resolveRemoteContext(
            fakeGit({
                remoteUrl: "https://gitee.com/owner/repo.git",
                branches: [
                    { name: "main", current: false },
                    { name: "master", current: true },
                ],
            })
        );

        expect(context).toEqual({
            ref: { host: "gitee", owner: "owner", repo: "repo" },
            branch: "master",
        });
    });

    it("识别 GitHub 的 SSH 远端", async () => {
        const context = await resolveRemoteContext(
            fakeGit({
                remoteUrl: "git@github.com:owner/repo.git",
                branches: [{ name: "main", current: true }],
            })
        );

        expect(context?.ref.host).toBe("github");
        expect(context?.branch).toBe("main");
    });

    it("没有远端时返回 undefined", async () => {
        const context = await resolveRemoteContext(
            fakeGit({ remoteUrl: undefined, branches: [{ name: "main", current: true }] })
        );

        expect(context).toBeUndefined();
    });

    it("远端不是 GitHub / Gitee 时返回 undefined（不拼一个必然 404 的地址）", async () => {
        const context = await resolveRemoteContext(
            fakeGit({
                remoteUrl: "https://gitlab.com/owner/repo.git",
                branches: [{ name: "main", current: true }],
            })
        );

        expect(context).toBeUndefined();
    });

    it("仓库还没有任何提交（没有当前分支）时返回 undefined", async () => {
        const context = await resolveRemoteContext(
            fakeGit({
                remoteUrl: "https://gitee.com/owner/repo.git",
                branches: [],
            })
        );

        expect(context).toBeUndefined();
    });
});

describe("fileOnRemoteUrl", () => {
    it("Gitee 与 GitHub 各生成正确的 blob 地址", () => {
        expect(
            fileOnRemoteUrl(
                { ref: { host: "gitee", owner: "o", repo: "r" }, branch: "master" },
                "notes/a.md"
            )
        ).toBe("https://gitee.com/o/r/blob/master/notes/a.md");

        expect(
            fileOnRemoteUrl(
                { ref: { host: "github", owner: "o", repo: "r" }, branch: "main" },
                "notes/a.md"
            )
        ).toBe("https://github.com/o/r/blob/main/notes/a.md");
    });

    it("编码中文文件名与空格（Obsidian 库里的常态）", () => {
        const url = fileOnRemoteUrl(
            { ref: { host: "gitee", owner: "o", repo: "r" }, branch: "master" },
            "笔记/我的 文件.md"
        );

        expect(url).toBe(
            "https://gitee.com/o/r/blob/master/" +
                "%E7%AC%94%E8%AE%B0/%E6%88%91%E7%9A%84%20%E6%96%87%E4%BB%B6.md"
        );
        // 不该出现裸空格或裸中文 —— 那会让浏览器把链接截断
        expect(url).not.toContain(" ");
    });

    it("保留分支名里的斜杠（feature/x 是合法分支名）", () => {
        const url = fileOnRemoteUrl(
            { ref: { host: "github", owner: "o", repo: "r" }, branch: "feature/new-ui" },
            "a.md"
        );

        expect(url).toBe("https://github.com/o/r/blob/feature/new-ui/a.md");
    });
});

describe("fileHistoryOnRemoteUrl", () => {
    it("两个平台都用 /commits/ 路径", () => {
        expect(
            fileHistoryOnRemoteUrl(
                { ref: { host: "github", owner: "o", repo: "r" }, branch: "main" },
                "a.md"
            )
        ).toBe("https://github.com/o/r/commits/main/a.md");

        expect(
            fileHistoryOnRemoteUrl(
                { ref: { host: "gitee", owner: "o", repo: "r" }, branch: "master" },
                "a.md"
            )
        ).toBe("https://gitee.com/o/r/commits/master/a.md");
    });
});
