/**
 * Gitee git 端点的 Basic 鉴权 —— 客户端机制的真实性验证。
 *
 * ## 为什么需要这组用例
 *
 * `HANDOVER` 里长期挂着一个「唯一待实测项」：对真实 Gitee 私有仓库 push 一次，
 * 确认 `http.extraheader` 的 Basic 认证被接受。没有令牌就做不了那个验证，
 * 但**可以做一半**，而且是有意义的一半：
 *
 * - 不带凭据读公开仓库 → 成功（对照组，证明网络与命令本身没问题）
 * - 带**伪造**的 Basic 头 → **被拒**（证明服务器真的读取并校验了这个头）
 *
 * 两条同时成立，说明「Basic 鉴权在这个服务端是有效的机制」。
 * 剩下的未知只有「有效的私人令牌是否被接受」—— 那是 Gitee 的账号策略，
 * 文档写明支持，但没有令牌就无法在此确认。
 *
 * ## 为什么这组用例放在 live
 *
 * 它要起真实 git 进程、访问真实 gitee.com。走的是 git 的 HTTPS 端点，
 * 不是 `/api/v5`，所以**不受那个极低的匿名 API 配额影响**。
 */
import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";

const LIVE_TIMEOUT = 60_000;

/**
 * 一个确定存在的公开 Gitee 仓库（只用只读的 ls-remote，不改动任何东西）。
 *
 * 刻意挑**引用很少**的仓库：`ls-remote` 会输出全部引用，
 * 而 Node 的 `execFile` 默认 `maxBuffer` 只有 1MB ——
 * 拿 `mindspore/mindspore`（实测 18 万个引用）跑会以
 * `stdout maxBuffer length exceeded` 失败，看起来像网络问题，实则不是。
 */
const PUBLIC_REPO = "https://gitee.com/oschina/git-osc.git";

interface GitResult {
    ok: boolean;
    stdout: string;
    stderr: string;
}

/**
 * 剥掉代理变量再交给 git。
 *
 * **这只是为了让测试能在本机跑** —— 本机环境变量里的代理（127.0.0.1:54305）
 * 访问 gitee.com 会返回 502，而直连是通的。
 * 产品本身**不**这么做：用户配了代理就该走代理，那是他的网络环境。
 */
function envWithoutProxy(): NodeJS.ProcessEnv {
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
    // 禁掉交互提示，否则 401 之后 git 会等用户输入而挂住。
    env.GIT_TERMINAL_PROMPT = "0";
    return env;
}

function lsRemote(extraHeader?: string): Promise<GitResult> {
    const args = [
        // **关掉凭据助手链。** 收到 401 之后 git 会去调凭据助手，
        // 而本机系统级的 `credential.helper=helper-selector`（PortableGit 自带）
        // 在非交互环境里会干等超时 —— 表现为「用例卡满 45 秒」，
        // 看起来像网络慢，实则是在等一个永远不会来的输入。
        // 传空值会重置助手链（这一点在 git 文档里很隐晦）。
        "-c",
        "credential.helper=",
        ...(extraHeader ? ["-c", `http.extraheader=${extraHeader}`] : []),
        "ls-remote",
        PUBLIC_REPO,
    ];

    return new Promise((resolve) => {
        execFile(
            "git",
            args,
            {
                timeout: 45_000,
                env: envWithoutProxy(),
                // 默认 1MB 对 ls-remote 不够（引用多的仓库会超）——
                // 见 PUBLIC_REPO 的说明。给足余量，免得失败原因看起来像网络问题。
                maxBuffer: 16 * 1024 * 1024,
            },
            (err, stdout, stderr) => {
                resolve({
                    ok: !err,
                    stdout: stdout ?? "",
                    // execFile 的某些失败（maxBuffer / 超时）只体现在 err.message 里，
                    // stderr 是空的 —— 把它并进去，否则断言失败时看不到原因。
                    stderr: `${stderr ?? ""}${err && !stderr ? (err as Error).message : ""}`,
                });
            }
        );
    });
}

describe("Gitee git 端点的 Basic 鉴权", () => {
    it("不带凭据可匿名读取公开仓库（对照组）", async () => {
        const result = await lsRemote();

        expect(result.ok, `ls-remote 失败：${result.stderr.slice(0, 200)}`).toBe(true);
        expect(result.stdout).toContain("refs/heads/");
    }, LIVE_TIMEOUT);

    it("**伪造凭据会被拒** —— 说明服务器真的读取并校验了这个头", async () => {
        // 若 Gitee 忽略 Authorization 头（当作匿名请求），公开仓库照样能读成功 ——
        // 那就说明这个机制在它这里不成立。被拒反而是好消息。
        const bogus = Buffer.from("fakeuser:definitely-not-a-valid-token").toString("base64");
        const result = await lsRemote(`Authorization: Basic ${bogus}`);

        expect(result.ok).toBe(false);
        // 401 之后 git 会尝试索要凭据；GIT_TERMINAL_PROMPT=0 下它直接失败。
        expect(result.stderr).toMatch(
            /could not read Username|Authentication failed|invalid|403|401/i
        );
    }, LIVE_TIMEOUT);

    it("鉴权头格式合法时不会被当成畸形请求（走到凭据校验而非协议错误）", async () => {
        // 这条区分「服务器拒绝了凭据」与「服务器看不懂这个头」——
        // 后者会表现为协议层面的错误（bad request / malformed），
        // 那意味着我们构造的格式有问题，而不是令牌不对。
        const bogus = Buffer.from("x:y").toString("base64");
        const result = await lsRemote(`Authorization: Basic ${bogus}`);

        expect(result.stderr).not.toMatch(/malformed|bad request|400/i);
    }, LIVE_TIMEOUT);
});
