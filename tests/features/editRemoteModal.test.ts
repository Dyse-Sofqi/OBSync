import { describe, expect, it } from "vitest";
import { classifyRemoteUrl } from "../../src/features/sync/ui/EditRemoteModal";

/**
 * 「编辑远端地址」的提示判定。
 *
 * ## 为什么把判定单独测
 *
 * `EditRemoteModal.ts` 此前**没有任何测试**，而这个弹窗里有一串顺序敏感的
 * 判断，每一处的顺序错了都会有具体症状：
 *
 * - 「不像 git 远端」排在「带凭据」之后 → 一句中文句子会被报成「里面有令牌」；
 * - 「带凭据」排在「认得出平台」之后 → `https://oauth2:TOKEN@gitee.com/…`
 *   能被平台认出来，于是**永远轮不到凭据那条**，用户毫无提示地
 *   把令牌写进 `.git/config`（那是明文，`git remote -v` 一眼可见）。
 *
 * 单独测判定而不是测弹窗渲染，是因为渲染需要 DOM 与 `Setting.addText` 的回调基建
 * （当前 stub 的 `addText` 只返回 `this`、不调回调），
 * 而判定本身是纯函数 —— 把逻辑抽出来就能测，也让 `updateHint()` 退化成一件事：
 * 按类型码取文案。
 *
 * 让用户"看见提示"只是提醒，不拦他；拦与不拦的边界也在这里定义。
 */

describe("classifyRemoteUrl", () => {
    it("空输入无提示 —— 清空远端是合法操作", () => {
        expect(classifyRemoteUrl("")).toBe("ok");
        expect(classifyRemoteUrl("   ")).toBe("ok");
    });

    it("普通地址无提示", () => {
        expect(classifyRemoteUrl("https://github.com/owner/repo.git")).toBe("ok");
        expect(classifyRemoteUrl("git@gitee.com:owner/repo.git")).toBe("ok");
    });

    it("SSH 地址不会被误判成「带凭据」", () => {
        // `git@` 是登录名，不是令牌。判错的话每一个正常 SSH 远端都会收到
        // 「你的令牌会被明文写进 .git/config」的警告 —— 而项目自己的输入提示
        // 就在推荐这种形态。警告变成噪音，真正该看的就没人看了。
        expect(classifyRemoteUrl("git@gitee.com:owner/repo.git")).toBe("ok");
        expect(classifyRemoteUrl("ssh://git@github.com/owner/repo.git")).toBe("ok");
        // 但 SSH 地址里**带冒号**的那段确实是密码，仍要拦
        expect(classifyRemoteUrl("ssh://user:pass@host/notes.git")).toBe("credentials");
    });

    it("不像 git 远端时拦住", () => {
        expect(classifyRemoteUrl("帮我同步一下笔记")).toBe("invalid");
        expect(classifyRemoteUrl("https://github.com/owner/repo with space")).toBe("invalid");
    });

    /**
     * 这组是本文件存在的理由：项目**刻意**不把令牌写进 remote URL
     * （见 `features/sync/auth.ts` 的方案取舍：会落进 `.git/config`、
     * `git remote -v` 可见、还会随配置文件泄漏），
     * 所以用户粘这样的地址进来时必须提醒。
     */
    describe("带凭据的地址", () => {
        it("userinfo 形式的令牌被认出来", () => {
            expect(classifyRemoteUrl("https://oauth2:ghp_abc@gitee.com/owner/repo.git")).toBe(
                "credentials"
            );
        });

        it("只有令牌没有用户名（userinfo 无冒号）也认得出", () => {
            expect(classifyRemoteUrl("https://ghp_abc@github.com/owner/repo.git")).toBe(
                "credentials"
            );
        });

        it("查询串里的 access_token 也认得出", () => {
            expect(
                classifyRemoteUrl("https://gitee.com/owner/repo.git?access_token=abc")
            ).toBe("credentials");
        });

        it("**认得出平台的地址也照样报凭据** —— 顺序不能反", () => {
            // 这一条专门锁顺序：`https://oauth2:TOKEN@gitee.com/…` 是能被
            // tryParseRepoRef 解析的。若把凭据判断排在平台判断之后，
            // 这类最常见的地址反而会被判成「一切正常」。
            expect(classifyRemoteUrl("https://oauth2:tok@gitee.com/o/r.git")).toBe(
                "credentials"
            );
        });

        it("整条 git clone 命令算无效输入（而不是算带凭据）", () => {
            // 带空格 → 先被「不像 git 远端」拦下。这时再说「里面有令牌」是噪音：
            // 用户手上的问题是格式不对，不是安全问题。
            expect(classifyRemoteUrl("git clone https://oauth2:tok@gitee.com/o/r.git")).toBe(
                "invalid"
            );
        });

        it("非凭据参数不会误报（否则提示会变成噪音）", () => {
            expect(
                classifyRemoteUrl("https://gitee.com/o/r.git?page=2&direction=desc")
            ).toBe("ok");
        });
    });

    it("非 GitHub / Gitee 但合法的远端 → 放行并提示", () => {
        expect(classifyRemoteUrl("https://gitlab.com/owner/repo.git")).toBe(
            "notGithubOrGitee"
        );
        expect(classifyRemoteUrl("ssh://git@internal.corp/git/notes.git")).toBe(
            "notGithubOrGitee"
        );
    });

    it("SSH 形态的 GitHub / Gitee 地址被认得出，无提示", () => {
        expect(classifyRemoteUrl("ssh://git@github.com/owner/repo.git")).toBe("ok");
    });

    it("带凭据的非 GitHub / Gitee 地址报凭据（安全提示优先于能力说明）", () => {
        expect(classifyRemoteUrl("https://user:tok@gitlab.com/o/r.git")).toBe("credentials");
    });

    /**
     * 本地路径这一组记录的是**既有行为**，不是设计意图 ——
     * 「认得出平台」是用 `tryParseRepoRef` 代理的，而它本意是解析仓库标识，
     * 于是对本地路径给出不一致的答案：
     *
     * - POSIX / 相对路径正好长得像 `owner/repo`，被判成「认识」→ 无提示；
     * - Windows 路径（`D:/…`）解析不了 → 收到「该平台不是 GitHub 或 Gitee」，
     *   可这句话里**根本没有平台**。
     *
     * 两者都不影响保存（都放行），所以没在这轮改 —— 但它是个真的不一致，
     * 改之前得先想清「认得出平台」到底该用什么判据（`parseGitRemoteUrl`
     * 处理 git 远端形态更对，只是行为面更大）。这里把现状钉住，
     * 免得将来有人顺手改了文案却不知道两边不一致。
     */
    it("本地路径的现状（已知不一致，未修）", () => {
        expect(classifyRemoteUrl("/srv/git/notes.git")).toBe("ok");
        expect(classifyRemoteUrl("./local-repo")).toBe("ok");
        expect(classifyRemoteUrl("D:/repos/notes")).toBe("notGithubOrGitee");
    });
});
