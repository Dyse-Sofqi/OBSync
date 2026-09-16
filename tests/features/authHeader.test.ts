import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { basicAuthHeader, withAuth } from "../../src/features/sync/auth";

/**
 * 鉴权链路的**上网**验证 —— config 之后的那一环。
 *
 * ## 这一环为什么必须单独测
 *
 * 完整的链路是四段：
 *
 *     我们构造 config 字符串 → simple-git 把它变成 git 的 -c →
 *     git 把它变成 HTTP 请求上的 Authorization 头 → 服务端接受
 *
 * - `auth.test.ts` 测第一段
 * - `authWire.test.ts` 测第二段（让 git 在同一次调用里把配置读回来）
 * - **本文件测第三段**（起一个本地 HTTP 服务器，看真实的请求头）
 * - `tests/live/giteeGitAuth.live.test.ts` 测第四段（要网络）
 *
 * 第三段曾经只存在于一个 gitignore 的临时探针里。它其实**不需要网络、
 * 不需要令牌**（本地服务器就行），所以没理由不做成正式用例 ——
 * 而它静默失效的症状是「私有仓库 401」，排查时会先怀疑令牌、再怀疑权限，绕很远。
 *
 * ## 关键性质：不等 401 挑战
 *
 * `http.extraheader` 是**主动**附带的：git 在**第一个请求**
 * （`/info/refs?service=git-upload-pack`）就该带上凭据，而不是先发一个
 * 匿名请求、收到 401 挑战再重发。所以断言落在 `seen[0]` 上，而不是
 * 「某个请求带过头」—— 后者在「先匿名再重试」的实现下也会通过，但那不是我们要的行为。
 *
 * ## 本地服务器要绕过的两个环境因素
 *
 * - **代理变量**：本机 `http_proxy` 指向一个本地代理，若让它转发到
 *   `127.0.0.1:<随机端口>` 会失败或串味。测试里剥掉 —— 产品不这么做，
 *   用户配了代理就该走代理，这只是为了让用例可重复。
 * - **凭据助手**：服务器返回 401 后 git 会去调凭据助手，而本机系统级的
 *   `credential.helper=helper-selector` 在非交互环境里会干等超时，
 *   表现为「用例卡满几十秒」。传空值重置助手链（见 RELEASE.md 同款说明）。
 */

interface SeenRequest {
    url: string | undefined;
    authorization: string | null;
}

interface RecordingServer {
    port: number;
    seen: SeenRequest[];
    close(): Promise<void>;
}

/**
 * 起一个只记录请求头的服务器。
 *
 * 不实现 git 协议 —— 一律回 401。我们只关心「第一个请求带没带凭据」，
 * 协议能不能跑通是另一回事（那归 live 测试）。
 */
async function startRecordingServer(): Promise<RecordingServer> {
    const seen: SeenRequest[] = [];
    const server = http.createServer((req, res) => {
        seen.push({ url: req.url, authorization: req.headers.authorization ?? null });
        res.writeHead(401, { "WWW-Authenticate": 'Basic realm="obsync-test"' });
        res.end("nope");
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    return {
        port,
        seen,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
}

/** 跑一次 `ls-remote`，只关心「跑没跑起来」和失败原因。 */
function lsRemote(args: string[]): Promise<{ stderr: string }> {
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
    // 401 之后别去等用户输入 —— 那会挂住而不是失败。
    env.GIT_TERMINAL_PROMPT = "0";

    return new Promise((resolve) => {
        execFile(
            "git",
            args,
            { timeout: 20_000, env, maxBuffer: 4 * 1024 * 1024 },
            (err, _stdout, stderr) => {
                resolve({
                    stderr: `${stderr ?? ""}${err && !stderr ? (err as Error).message : ""}`,
                });
            }
        );
    });
}

/** 每次调用都重新起服务器，且**保证关掉** —— 漏关会让 vitest 卡住不退。 */
let server: RecordingServer | undefined;
afterEach(async () => {
    await server?.close();
    server = undefined;
});

/** 把 `withAuth` 产出的 config 数组摊成 git 命令行的 `-c key=value`。 */
function configArgs(config: string[] | undefined): string[] {
    return (config ?? []).flatMap((entry) => ["-c", entry]);
}

describe("git 把 extraheader 发到网络上（config 之后的第三段）", () => {
    it("**第一个请求就带上 Authorization**，不等 401 挑战", async () => {
        server = await startRecordingServer();

        // config 由**生产代码**产出，而不是在测试里手写键名 ——
        // 否则 `http.extraheader` 改名了用例照样绿，这一环就白测了。
        // 也刻意用 Gitee + 不给账号名，因为**生产就是这样**：
        // credentialForRemote 不填 account，用户名由 host 层声明（Gitee → oauth2）。
        const options = withAuth({}, { host: "gitee", token: "tok-123" });

        await lsRemote([
            "-c",
            "credential.helper=",
            ...configArgs(options.config),
            "ls-remote",
            `http://127.0.0.1:${server.port}/x.git`,
        ]);

        expect(server.seen.length).toBeGreaterThan(0);

        const first = server.seen[0]!;
        // 第一个请求应当是 smart-http 的能力探测端点 —— 确认我们断言的是
        // 协议的第一个请求，而不是重试/重定向之后的某一个。
        expect(first.url).toContain("/info/refs");
        expect(first.url).toContain("service=git-upload-pack");

        // 期望值由 basicAuthHeader 产出（同样是生产代码）——
        // 「值的内容对不对」由下面第三条用例独立验证（解码回凭据），
        // 两条合起来才是完整的：这里锁「头真的发出去了」，那里锁「内容是对的」。
        const expected = basicAuthHeader("oauth2", "tok-123");
        expect(first.authorization).toBe(expected.slice("Authorization: ".length));
    });

    it("没有凭据时网络上不带 Authorization（匿名请求不该带空凭据）", async () => {
        server = await startRecordingServer();
        // 走 withAuth 的真实分支：没有凭据时它不该注入任何 config。
        const options = withAuth({}, undefined) as { config?: string[] };
        expect(options.config ?? []).toHaveLength(0);

        await lsRemote([
            "-c",
            "credential.helper=",
            "ls-remote",
            `http://127.0.0.1:${server.port}/x.git`,
        ]);

        expect(server.seen.length).toBeGreaterThan(0);
        // 断言「一个都没有」而不是「第一个没有」：git 可能在 401 之后重试，
        // 任何一次带上凭据都算失败。
        expect(server.seen.every((request) => request.authorization === null)).toBe(true);
    });

    it("凭据里的特殊字符能被原样送出（值里没有换行/空格污染）", async () => {
        // 头值里混进换行会让 git 拒绝该配置、或让服务端解析成畸形请求，
        // 症状是 400 而不是 401 —— 很难从错误信息联想到编码。
        // 账号名走 withAuth 的 account 分支（真实账号名可能含空格或中文）。
        server = await startRecordingServer();
        const header = basicAuthHeader("user with space", "tok");

        expect(header).not.toMatch(/[\r\n]/);

        const options = withAuth(
            {},
            { host: "gitee", account: "user with space", token: "tok" }
        );

        await lsRemote([
            "-c",
            "credential.helper=",
            ...configArgs(options.config),
            "ls-remote",
            `http://127.0.0.1:${server.port}/x.git`,
        ]);

        const sent = server.seen[0]?.authorization;
        expect(sent).toBe(header.slice("Authorization: ".length));
        // 解回来应当是我们传进去的那对凭据（Basic 是 base64，能原样还原）。
        // 注意要再剥掉 `Basic ` 前缀 —— 整个值解码会得到一堆乱码，
        // 那种失败看起来像「编码错了」，其实只是解码姿势不对。
        expect(Buffer.from(sent!.slice("Basic ".length), "base64").toString()).toBe(
            "user with space:tok"
        );
    });
});
