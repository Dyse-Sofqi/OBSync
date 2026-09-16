import { describe, expect, it } from "vitest";
import { ParseError, UnsupportedHostError } from "../../src/host/errors";
import {
    formatRemoteUrl,
    formatRepoId,
    isSameRepo,
    parseGitRemoteUrl,
    parseRepoRef,
    repoWebUrl,
    tryParseRepoRef,
} from "../../src/host/repoRef";

describe("parseRepoRef", () => {
    it("解析 owner/repo 简写并使用默认平台", () => {
        expect(parseRepoRef("Dyse-Sofqi/OBSync")).toEqual({
            host: "github",
            owner: "Dyse-Sofqi",
            repo: "OBSync",
        });
    });

    it("简写时尊重传入的默认平台", () => {
        expect(parseRepoRef("owner/repo", "gitee").host).toBe("gitee");
    });

    it.each([
        ["https://github.com/owner/repo", "github"],
        ["http://github.com/owner/repo", "github"],
        ["https://gitee.com/owner/repo", "gitee"],
        ["https://www.gitee.com/owner/repo", "gitee"],
        ["github.com/owner/repo", "github"],
        ["gitee.com/owner/repo", "gitee"],
    ])("解析 %s 并识别为 %s", (input, host) => {
        const ref = parseRepoRef(input);
        expect(ref.host).toBe(host);
        expect(formatRepoId(ref)).toBe("owner/repo");
    });

    it("去掉 .git 后缀与尾部斜杠", () => {
        expect(formatRepoId(parseRepoRef("https://github.com/owner/repo.git/"))).toBe(
            "owner/repo"
        );
        expect(formatRepoId(parseRepoRef("owner/repo.git"))).toBe("owner/repo");
    });

    it("容忍 URL 里的多余路径（树视图、release 页等）", () => {
        expect(
            formatRepoId(parseRepoRef("https://github.com/owner/repo/tree/main/src"))
        ).toBe("owner/repo");
        expect(
            formatRepoId(parseRepoRef("https://gitee.com/owner/repo/releases/tag/v1.0"))
        ).toBe("owner/repo");
    });

    it("去掉查询串与锚点", () => {
        expect(formatRepoId(parseRepoRef("https://github.com/owner/repo?tab=readme"))).toBe(
            "owner/repo"
        );
        expect(formatRepoId(parseRepoRef("https://github.com/owner/repo#install"))).toBe(
            "owner/repo"
        );
    });

    it("解析 scp 形式的远端地址", () => {
        expect(parseRepoRef("git@github.com:owner/repo.git")).toEqual({
            host: "github",
            owner: "owner",
            repo: "repo",
        });
        expect(parseRepoRef("git@gitee.com:owner/repo.git").host).toBe("gitee");
    });

    it("解析 ssh:// 形式", () => {
        expect(parseRepoRef("ssh://git@gitee.com/owner/repo.git")).toEqual({
            host: "gitee",
            owner: "owner",
            repo: "repo",
        });
    });

    it("容忍用户从网页复制时带上的引号与空白", () => {
        expect(formatRepoId(parseRepoRef('  "https://gitee.com/owner/repo"  '))).toBe(
            "owner/repo"
        );
        expect(formatRepoId(parseRepoRef("<owner/repo>"))).toBe("owner/repo");
    });

    it("支持带点的仓库名", () => {
        expect(parseRepoRef("owner/my.plugin")).toEqual({
            host: "github",
            owner: "owner",
            repo: "my.plugin",
        });
    });

    it("对不支持的平台抛出 UnsupportedHostError，而不是当成简写", () => {
        // 这是关键行为：把 gitlab.com/owner/repo 误当成 owner/repo 简写，
        // 会产生"仓库找不到"这种完全误导的报错。
        expect(() => parseRepoRef("https://gitlab.com/owner/repo")).toThrow(
            UnsupportedHostError
        );
        expect(() => parseRepoRef("bitbucket.org/owner/repo")).toThrow(UnsupportedHostError);
    });

    it("对残缺地址抛出 ParseError", () => {
        expect(() => parseRepoRef("")).toThrow(ParseError);
        expect(() => parseRepoRef("   ")).toThrow(ParseError);
        expect(() => parseRepoRef("just-a-name")).toThrow(ParseError);
        expect(() => parseRepoRef("https://github.com/owner")).toThrow(ParseError);
    });

    it("对非法字符抛出 ParseError", () => {
        expect(() => parseRepoRef("owner/re po")).toThrow(ParseError);
        expect(() => parseRepoRef("own er/repo")).toThrow(ParseError);
    });

    it("tryParseRepoRef 不抛异常", () => {
        expect(tryParseRepoRef("garbage")).toBeUndefined();
        expect(tryParseRepoRef("owner/repo")?.owner).toBe("owner");
    });
});

describe("isSameRepo", () => {
    it("平台与路径都相同才算同一个仓库", () => {
        const a = parseRepoRef("owner/repo");
        expect(isSameRepo(a, parseRepoRef("owner/repo"))).toBe(true);
        expect(isSameRepo(a, parseRepoRef("owner/repo", "gitee"))).toBe(false);
        expect(isSameRepo(a, parseRepoRef("other/repo"))).toBe(false);
    });

    it("owner 与 repo 大小写不敏感", () => {
        expect(isSameRepo(parseRepoRef("Owner/Repo"), parseRepoRef("owner/repo"))).toBe(true);
    });
});

describe("formatRemoteUrl", () => {
    it("给 GitHub 与 Gitee 的 HTTPS 地址补 .git", () => {
        expect(formatRemoteUrl("https://github.com/owner/repo")).toBe(
            "https://github.com/owner/repo.git"
        );
        // 参考项目只处理 github/gitlab，Gitee 会漏掉 —— 这条是防回归。
        expect(formatRemoteUrl("https://gitee.com/owner/repo")).toBe(
            "https://gitee.com/owner/repo.git"
        );
    });

    it("已有 .git 时不重复添加", () => {
        expect(formatRemoteUrl("https://gitee.com/owner/repo.git")).toBe(
            "https://gitee.com/owner/repo.git"
        );
    });

    it("不改动未知平台的地址", () => {
        expect(formatRemoteUrl("https://git.example.com/owner/repo")).toBe(
            "https://git.example.com/owner/repo"
        );
        expect(formatRemoteUrl("git@gitee.com:owner/repo.git")).toBe(
            "git@gitee.com:owner/repo.git"
        );
    });
});

describe("parseGitRemoteUrl", () => {
    it("从远端地址反推仓库引用", () => {
        expect(parseGitRemoteUrl("https://gitee.com/owner/repo.git")).toEqual({
            host: "gitee",
            owner: "owner",
            repo: "repo",
        });
    });

    it("认不出来时返回 undefined 而不是抛错", () => {
        expect(parseGitRemoteUrl("D:/local/path")).toBeUndefined();
    });
});

describe("repoWebUrl", () => {
    it("按平台生成仓库主页", () => {
        expect(repoWebUrl(parseRepoRef("owner/repo"))).toBe(
            "https://github.com/owner/repo"
        );
        expect(repoWebUrl(parseRepoRef("owner/repo", "gitee"))).toBe(
            "https://gitee.com/owner/repo"
        );
    });
});
