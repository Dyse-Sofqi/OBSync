/**
 * 私有仓库鉴权的**端到端**验证：真实令牌 + 真实私有仓库。
 *
 * ## 为什么需要它（现有测试的缺口）
 *
 * `tests/live/giteeGitAuth.live.test.ts` 验的是**拒绝**方向：伪造凭据会被拒，
 * 说明服务端确实读取并校验了这个头。但它**验不了接受方向** ——
 * 「有效令牌能被接受」需要真的令牌，所以一直没被自动化过。
 * 结果是：整条链路里「最后一步真的成功」始终只有人工确认。
 *
 * 这个文件补上那一步。它是**可选启用**的（要令牌与私有仓库），
 * 未配置时整组跳过，不影响 `pnpm test:live` 的常规结果。
 *
 * ## 用法
 *
 * ```bash
 * # GitHub（用 gh 的令牌）
 * export OBSYNC_LIVE_PRIVATE_REPO="https://github.com/<你>/<私有仓库>.git"
 * pnpm test:live
 *
 * # Gitee
 * export OBSYNC_LIVE_PRIVATE_REPO="https://gitee.com/<你>/<私有仓库>.git"
 * export OBSYNC_LIVE_TOKEN="<你的 Gitee 私人令牌>"
 * pnpm test:live
 * ```
 *
 * 令牌也可以放在 `OBSYNC_LIVE_TOKEN`；不给的话回退到 `gh auth token`
 * （只对 GitHub 有意义）。**令牌只从环境读，不落盘、不进日志。**
 *
 * ## 三条用例的分工
 *
 * 1. **对照组**：不带凭据必须**失败** —— 否则说明这个仓库不需要鉴权，
 *    那么后面「成功」什么也证明不了。缺了这条，整个验证是空的。
 * 2. **接受**：用**生产代码声明的用户名**（`IRepoHost.gitAuthUsername`）+ 真实令牌
 *    必须成功。用户名从 `withAuth` 同一套代码推导，所以这条同时锁住了
 *    「用户名改错」这类回归。
 * 3. **push 路径**（需额外开 `OBSYNC_LIVE_ALLOW_PUSH_DRY_RUN=1`）：
 *    `git push --dry-run` 不得报「用户名不被支持」。
 *
 *    为什么单独需要这条：Gitee 的用户名白名单是在 **push 路径的服务端钩子**里
 *    执行的（报错带 `remote:` 前缀），**fetch 路径看不出来** ——
 *    实测用伪造令牌打 fetch 端点时，`git` / `oauth2` / 随机串返回的是
 *    完全相同的通用 401。所以「测试连接」这类只做 `ls-remote` 的诊断
 *    **无法发现用户名问题**，只有走一次 push 才能。
 *
 *    `--dry-run` 不发送任何对象、不更新任何引用（git 文档：do everything except
 *    actually send the updates），但仍然会建立 receive-pack 会话，
 *    所以能触发那道检查。即便如此它仍属**写路径**，故默认关闭、需显式开启。
 */
import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { basicAuthHeader } from "../../src/features/sync/auth";
import { getHost } from "../../src/host/hostRegistry";
import { parseGitRemoteUrl } from "../../src/host/repoRef";

const LIVE_TIMEOUT = 90_000;

const REPO = process.env.OBSYNC_LIVE_PRIVATE_REPO;
const ALLOW_DRY_RUN_PUSH = process.env.OBSYNC_LIVE_ALLOW_PUSH_DRY_RUN === "1";

/**
 * Gitee 在用户名不被接受时的报错（服务端原文，见 Gitee 官方仓库 issue I1BGZG）：
 *
 *     remote: Username, "oauth2" or "gitee.com" is supported as username
 *             when using access token to pull or push the repository
 *
 * 匹配得宽一点：只要提到「username」+「supported」，就按用户名问题处理。
 */
const USERNAME_REJECTED = /is supported as username|Username,\s*"oauth2"/i;

interface RunResult {
    ok: boolean;
    stdout: string;
    stderr: string;
}

/** 去掉代理变量并禁掉交互提示 —— 见 giteeGitAuth.live.test.ts 里的同款说明。 */
function cleanEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    for (const key of [
        "http_proxy",
        "https_proxy",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "all_proxy",
    ]) {
        delete env[key];
    }
    env.GIT_TERMINAL_PROMPT = "0";
    return env;
}

function runGit(args: string[], timeout = 45_000): Promise<RunResult> {
    return new Promise((resolve) => {
        execFile(
            "git",
            args,
            { timeout, env: cleanEnv(), maxBuffer: 16 * 1024 * 1024 },
            (err, stdout, stderr) => {
                resolve({
                    ok: !err,
                    stdout: stdout ?? "",
                    stderr: `${stderr ?? ""}${err && !stderr ? (err as Error).message : ""}`,
                });
            }
        );
    });
}

/** 取令牌：先看环境变量，再回退 `gh auth token`。取不到返回 undefined。 */
function readToken(): Promise<string | undefined> {
    const fromEnv = process.env.OBSYNC_LIVE_TOKEN?.trim();
    if (fromEnv) return Promise.resolve(fromEnv);

    return new Promise((resolve) => {
        execFile("gh", ["auth", "token"], { timeout: 20_000 }, (err, stdout) => {
            const value = stdout?.trim();
            resolve(!err && value ? value : undefined);
        });
    });
}

/**
 * 用**生产代码**推导鉴权参数，而不是在测试里手拼。
 *
 * 关键点：用户名来自 `IRepoHost.gitAuthUsername` —— 所以这条用例锁住了
 * 「用户名填错」这类回归（Gitee 只接受 账号名 / oauth2 / gitee.com）。
 */
function authArgs(remoteUrl: string, token: string): string[] | undefined {
    const ref = parseGitRemoteUrl(remoteUrl);
    if (!ref) return undefined;

    const header = basicAuthHeader(getHost(ref.host).gitAuthUsername, token);
    // 空值重置凭据助手链：401 之后 git 会去调系统助手，非交互环境下会干等超时。
    return ["-c", "credential.helper=", "-c", `http.extraheader=${header}`];
}

/** 未配置时跳过 —— 用 `describe.skipIf` 而不是在用例里 return，后者会显示成「通过」。 */
const configured = Boolean(REPO);

describe.skipIf(!configured)("私有仓库鉴权（端到端，需 OBSYNC_LIVE_PRIVATE_REPO）", () => {
    it("对照组：不带凭据必须失败（否则这个仓库不需要鉴权，后面的成功无意义）", async () => {
        const result = await runGit(["-c", "credential.helper=", "ls-remote", "--heads", REPO!]);

        expect(
            result.ok,
            `不带凭据竟然成功了 —— 说明 ${REPO} 是公开仓库或允许匿名读取，` +
                `请换一个真正的私有仓库，否则这组用例证明不了任何事。`
        ).toBe(false);
    }, LIVE_TIMEOUT);

    it("**有效令牌被接受**（用户名用 host 层声明的那个）", async () => {
        const token = await readToken();
        expect(token, "取不到令牌：设 OBSYNC_LIVE_TOKEN，或先 gh auth login").toBeDefined();

        const args = authArgs(REPO!, token!);
        expect(args, `无法从 ${REPO} 解析出平台（只支持 GitHub / Gitee）`).toBeDefined();

        const result = await runGit([...args!, "ls-remote", "--heads", REPO!]);

        expect(
            result.ok,
            `鉴权失败：${result.stderr.slice(0, 300)}\n` +
                `若提示用户名不被支持，检查 IRepoHost.gitAuthUsername。`
        ).toBe(true);
        expect(result.stdout).toContain("refs/heads/");
    }, LIVE_TIMEOUT);

    it("host 层声明的用户名与远端平台匹配（防止把 Gitee 填成 git）", async () => {
        const ref = parseGitRemoteUrl(REPO!);
        expect(ref).toBeDefined();

        const username = getHost(ref!.host).gitAuthUsername;
        expect(username).toBeTruthy();
        // Gitee 的三种合法值之一，或 GitHub 的约定值。写死断言是故意的：
        // 这个值改动必须是**有意为之**，不能悄悄变成 git / 空串。
        if (ref!.host === "gitee") {
            expect(["oauth2", "gitee.com", ref!.owner]).toContain(username);
        } else {
            expect(username).toBe("x-access-token");
        }
    });

    it.runIf(ALLOW_DRY_RUN_PUSH)(
        "push 路径不报「用户名不被支持」（Gitee 的白名单只在这条路径上执行）",
        async () => {
            const token = await readToken();
            expect(token).toBeDefined();

            const args = authArgs(REPO!, token!);
            // --dry-run：不发送对象、不更新引用，但会建立 receive-pack 会话，
            // 因此能触发服务端的用户名检查。见文件头的说明。
            const result = await runGit([
                ...args!,
                "push",
                "--dry-run",
                "--porcelain",
                REPO!,
                "HEAD:refs/heads/obsync-auth-probe",
            ]);

            expect(
                USERNAME_REJECTED.test(result.stderr),
                `服务端拒绝了用户名 —— IRepoHost.gitAuthUsername 填错了。\n${result.stderr.slice(0, 300)}`
            ).toBe(false);
        },
        LIVE_TIMEOUT
    );
});
