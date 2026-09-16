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

    /**
     * 用户从 Gitee 界面复制的「带令牌的克隆地址」就是这个样子，
     * 而从教程里复制时常常连 `git clone` 一起粘进来。
     *
     * 这些错误消息会被 `Notifier` **原样弹在屏幕上**（`parseFailed` /
     * `unsupportedHost` 两条文案都是直接回显用户输入的），
     * 所以回显前必须去掉凭据 —— 否则用户截一张图就把令牌送出去了。
     */
    describe("回显用户输入时不带凭据", () => {
        const CLONE_URL = "https://oauth2:ghp_MUST_NOT_LEAK@gitee.com/owner/repo.git";

        it("不支持的平台：UnsupportedHostError 的 input 已脱敏", () => {
            const err = (() => {
                try {
                    parseRepoRef(CLONE_URL.replace("gitee.com", "gitlab.com"));
                    return undefined;
                } catch (e) {
                    return e as UnsupportedHostError;
                }
            })();

            expect(err).toBeInstanceOf(UnsupportedHostError);
            // input 是给用户看的那一份（i18n 文案直接内插它）
            expect(err!.input).not.toContain("ghp_MUST_NOT_LEAK");
            expect(err!.input).toContain("oauth2:***@gitlab.com");
            expect(err!.message).not.toContain("ghp_MUST_NOT_LEAK");
        });

        it("地址残缺时 ParseError 的消息也不带令牌", () => {
            // 少了 repo 段：`https://oauth2:TOKEN@gitee.com/owner`
            const err = (() => {
                try {
                    parseRepoRef(CLONE_URL.replace("/owner/repo.git", "/owner"));
                    return undefined;
                } catch (e) {
                    return e as ParseError;
                }
            })();

            expect(err).toBeInstanceOf(ParseError);
            expect(err!.message).not.toContain("ghp_MUST_NOT_LEAK");
        });

        it("把整条 git clone 命令粘进来时，ParseError 里也不带令牌", () => {
            // 这条走的是「认不出格式」的分支：整串都被当成 owner/repo 简写，
            // 于是原样回显 —— 正是最容易漏掉凭据的一条路径。
            const err = (() => {
                try {
                    parseRepoRef(`git clone ${CLONE_URL}`);
                    return undefined;
                } catch (e) {
                    return e as ParseError;
                }
            })();

            expect(err).toBeInstanceOf(ParseError);
            expect(err!.message).not.toContain("ghp_MUST_NOT_LEAK");
            expect(err!.message).toContain("oauth2:***@gitee.com");
        });

        it("正常地址的报错不受影响（不误改）", () => {
            expect(() => parseRepoRef("https://github.com/owner")).toThrow(
                /Repository "https:\/\/github\.com\/owner" is incomplete/
            );
        });
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
