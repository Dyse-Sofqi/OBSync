import { describe, expect, it } from "vitest";
import { mapError } from "../../src/features/sync/simpleGitManager";
import {
    GitAuthError,
    GitBinaryMissingError,
    GitCredentialUsernameRejectedError,
    GitNotRepoError,
    GitTimeoutError,
    PushRejectedError,
} from "../../src/features/sync/errors";

/**
 * git 失败的**分类**。
 *
 * ## 为什么单独测这一层
 *
 * `mapError` 是一串正则，判定的是「这个失败该引导用户做什么」。
 * 这些正则只能靠**真实的 git 输出**校准 —— 而用真实仓库去触发每一条代价很高：
 * 有的要私有仓库和令牌，有的要制造 non-fast-forward，有的要卸载 git。
 * 所以这里直接拿真实输出的原文当 fixture 测分类，比等集成测试偶发覆盖可靠。
 *
 * 同理，正则写错（凭记忆写而不是照抄真实输出）会**静默**退化：
 * 错误类型对不上 → 文案退回原始 git 输出 → 用户看到一堆英文
 * （见 MEMORY.md 里 `HEAD_UNBORN_RE` 那条踩坑记录，同一个坑）。
 *
 * ## 分类的准则是「应对方式」，不是「像什么」
 *
 * 下面「用户名被拒」那条最能说明问题：它**看起来**像鉴权失败，
 * 但令牌是好的，让用户去查令牌等于指错方向。
 */

/** 把 git 的原始输出包成 `mapError` 的输入。 */
function gitFailed(output: string): Error {
    return new Error(output);
}

describe("mapError 的分类", () => {
    it("git 没装（spawn ENOENT）", () => {
        expect(mapError(gitFailed("spawn git ENOENT"), "checking")).toBeInstanceOf(
            GitBinaryMissingError
        );
    });

    it("不是 git 仓库", () => {
        // 真实输出原文
        expect(
            mapError(
                gitFailed("fatal: not a git repository (or any of the parent directories): .git"),
                "checking repository state"
            )
        ).toBeInstanceOf(GitNotRepoError);
    });

    it("**平台拒绝凭据里的用户名**（Gitee 服务端原文）", () => {
        // 这段是 Gitee 官方仓库 issue I1BGZG 里的原文，逐字照抄 ——
        // 凭记忆改写会让这条用例失去校准作用。
        const raw =
            'remote: Username, "oauth2" or "gitee.com" is supported as username when using access token to pull or push the repository\n' +
            "fatal: unable to access 'https://gitee.com/owner/repo.git/': The requested URL returned error: 403";

        const error = mapError(gitFailed(raw), "pushing");

        expect(error).toBeInstanceOf(GitCredentialUsernameRejectedError);
        // **不能**落进 GitAuthError：那会让用户去检查一个没问题的令牌。
        expect(error).not.toBeInstanceOf(GitAuthError);
    });

    it("**同时出现「用户名不被支持」和「认证失败」时，取更具体的那条**", () => {
        // 这条锁的是 mapError 里的**判断顺序**：某些平台会两行一起打，
        // 若鉴权判断排在前面，用户就会看到「请检查令牌」—— 而令牌是好的。
        const raw =
            'remote: Username, "oauth2" or "gitee.com" is supported as username when using access token to pull or push the repository\n' +
            "fatal: Authentication failed for 'https://gitee.com/owner/repo.git/'";

        expect(mapError(gitFailed(raw), "pushing")).toBeInstanceOf(
            GitCredentialUsernameRejectedError
        );
    });

    it("令牌无效 / 认证失败仍然是 GitAuthError", () => {
        expect(
            mapError(
                gitFailed("fatal: Authentication failed for 'https://gitee.com/o/r.git/'"),
                "pushing"
            )
        ).toBeInstanceOf(GitAuthError);

        // 无凭据时 git 想交互要用户名，非交互环境下报这句
        expect(
            mapError(
                gitFailed("fatal: could not read Username for 'https://github.com': terminal prompts disabled"),
                "testing remote access"
            )
        ).toBeInstanceOf(GitAuthError);
    });

    it("推送被拒（本地落后）是 PushRejectedError", () => {
        expect(
            mapError(
                gitFailed(
                    "! [rejected]        main -> main (non-fast-forward)\n" +
                        "error: failed to push some refs to 'https://gitee.com/o/r.git'"
                ),
                "pushing"
            )
        ).toBeInstanceOf(PushRejectedError);
    });

    it("**卡住被中止**是 GitTimeoutError（simple-git 超时插件 kill 后的原话）", () => {
        // 用户报的症状是「尝试推送后一直看到正在推送」—— 那种「什么都不发生」
        // 必须被说成「超时、已中止、去查网络」，而不是让他继续等。
        expect(
            mapError(
                gitFailed("block timeout reached"),
                "pushing"
            )
        ).toBeInstanceOf(GitTimeoutError);
    });

    it("git/curl 自己的网络超时也归到同一条（对用户是同一件事）", () => {
        expect(
            mapError(
                gitFailed(
                    "fatal: unable to access 'https://github.com/o/r.git/': " +
                        "Failed to connect to github.com port 443: Operation timed out"
                ),
                "pulling (merge)"
            )
        ).toBeInstanceOf(GitTimeoutError);
    });

    it("超时判断排在鉴权之前 —— 卡死时若还带了别的输出，别报成「令牌不对」", () => {
        // 超时插件 kill 进程后，某些 git 版本还会补一句鉴权/连接的话。
        // 那只是症状；报成鉴权失败会把用户指去查一个没问题的令牌。
        expect(
            mapError(
                gitFailed("block timeout reached\nfatal: Authentication failed"),
                "pushing"
            )
        ).toBeInstanceOf(GitTimeoutError);
    });

    it("认不出的失败原样透传（保留 git 的原话，便于排查）", () => {
        const original = gitFailed("fatal: something nobody has seen before");
        expect(mapError(original, "pushing")).toBe(original);
    });

    it("非 Error 的抛出物也能处理（不假设抛的是 Error）", () => {
        const mapped = mapError("plain string failure", "pushing");
        expect(mapped).toBeInstanceOf(Error);
        expect(mapped.message).toContain("plain string failure");
    });

    it("技术性描述里带上「在做什么时失败的」（日志排查要用）", () => {
        const mapped = mapError(gitFailed("fatal: Authentication failed"), "pulling (merge)");

        // 消息是**技术性**的（英文、进日志），用户文案由 describeSyncError 拼 ——
        // 早期版本把中文文案写进 message，导致英文界面冒出中文。
        expect(mapped.message).toContain("pulling (merge)");
        expect(mapped.message).not.toMatch(/[\u4e00-\u9fff]/);
    });
});
