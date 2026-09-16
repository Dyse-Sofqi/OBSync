import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __setRequestUrlHandler } from "../stubs/obsidian";
import { GitHubHost } from "../../src/host/githubHost";
import { AuthError, RateLimitError } from "../../src/host/errors";
import { parseRepoRef } from "../../src/host/repoRef";

interface RecordedRequest {
    url: string;
    method?: string;
    headers?: Record<string, string>;
}

const REF = parseRepoRef("owner/repo", "github");

let calls: RecordedRequest[] = [];
let respond: (request: RecordedRequest) => {
    status: number;
    text?: string;
    headers?: Record<string, string>;
};

beforeEach(() => {
    calls = [];
    respond = () => ({ status: 200, text: "{}" });
    __setRequestUrlHandler(async (request) => {
        calls.push({ url: request.url, method: request.method, headers: request.headers });
        return respond(request);
    });
});

afterEach(() => {
    __setRequestUrlHandler(undefined);
});

describe("GitHubHost.listReleases", () => {
    it("按页收集，直到取满 limit", async () => {
        // 参考项目 BRAT 只取一页（per_page=100，无翻页），
        // release 超过 100 个的仓库会漏掉旧版本 —— 这里补上。
        respond = (request) => {
            const page = Number(new URL(request.url).searchParams.get("page"));
            const items = Array.from({ length: 100 }, (_, i) => ({
                id: page * 1000 + i,
                tag_name: `v${page}.${i}`,
                name: null,
                prerelease: false,
                draft: false,
                published_at: "2026-01-01T00:00:00Z",
                created_at: "2026-01-01T00:00:00Z",
                assets: [],
            }));
            return { status: 200, text: JSON.stringify(items) };
        };

        const releases = await new GitHubHost().listReleases(REF, { limit: 150 });

        expect(releases).toHaveLength(150);
        expect(calls.map((c) => new URL(c.url).searchParams.get("page"))).toEqual(["1", "2"]);
    });

    it("跳过草稿；includePrerelease 为 false 时跳过预发布", async () => {
        respond = () => ({
            status: 200,
            text: JSON.stringify([
                { id: 1, tag_name: "draft", prerelease: false, draft: true, created_at: "a", assets: [] },
                { id: 2, tag_name: "beta", prerelease: true, draft: false, created_at: "b", assets: [] },
                { id: 3, tag_name: "stable", prerelease: false, draft: false, created_at: "c", assets: [] },
            ]),
        });

        const releases = await new GitHubHost().listReleases(REF, {
            includePrerelease: false,
        });

        expect(releases.map((r) => r.tag)).toEqual(["stable"]);
    });

    it("映射资产时同时保留下载地址与 API 地址", async () => {
        respond = () => ({
            status: 200,
            text: JSON.stringify([
                {
                    id: 1,
                    tag_name: "v1.0.0",
                    name: "v1.0.0",
                    prerelease: false,
                    draft: false,
                    created_at: "2026-01-01T00:00:00Z",
                    assets: [
                        {
                            id: 7,
                            name: "main.js",
                            size: 10,
                            browser_download_url: "https://github.com/o/r/releases/download/v1/main.js",
                            url: "https://api.github.com/repos/o/r/releases/assets/7",
                        },
                    ],
                },
            ]),
        });

        const [release] = await new GitHubHost().listReleases(REF);

        expect(release!.assets[0]).toEqual({
            id: "7",
            name: "main.js",
            size: 10,
            downloadUrl: "https://github.com/o/r/releases/download/v1/main.js",
            apiUrl: "https://api.github.com/repos/o/r/releases/assets/7",
        });
    });
});

describe("GitHubHost.readFile", () => {
    it("无令牌时走 raw 域名，避开 60 次/小时的 API 配额", async () => {
        respond = () => ({ status: 200, text: '{"id":"demo"}' });

        const content = await new GitHubHost().readFile(REF, "manifest.json");

        expect(content).toBe('{"id":"demo"}');
        expect(calls[0]!.url).toBe(
            "https://raw.githubusercontent.com/owner/repo/HEAD/manifest.json"
        );
    });

    it("有令牌时走 contents API 并请求 raw 内容（私有仓库唯一通道）", async () => {
        respond = () => ({ status: 200, text: '{"id":"demo"}' });

        await new GitHubHost().readFile(REF, "manifest.json", { token: "tok", ref: "main" });

        expect(calls[0]!.url).toBe(
            "https://api.github.com/repos/owner/repo/contents/manifest.json?ref=main"
        );
        expect(calls[0]!.headers?.Accept).toBe("application/vnd.github.raw");
        expect(calls[0]!.headers?.Authorization).toBe("Bearer tok");
    });

    it("文件不存在时返回 undefined，且不消耗 API 配额", async () => {
        respond = () => ({ status: 404, text: '{"message":"Not Found"}' });

        await expect(new GitHubHost().readFile(REF, "nope.json")).resolves.toBeUndefined();

        // 只发了一次请求 —— 404 是明确答案，不该再打一次 API。
        expect(calls).toHaveLength(1);
    });

    it("逐段编码路径与含斜杠的分支名", async () => {
        respond = () => ({ status: 200, text: "x" });

        await new GitHubHost().readFile(REF, "src/my file.ts", { ref: "feature/new ui" });

        expect(calls[0]!.url).toBe(
            "https://raw.githubusercontent.com/owner/repo/feature/new%20ui/src/my%20file.ts"
        );
    });

    it("raw 域名不可达时退回 contents API", async () => {
        // raw.githubusercontent.com 在国内网络下经常被阻断，而 api.github.com
        // 通常可达 —— 两个域名的可达性互不相关。没有这条回退，
        // 症状就是「网络一换就装不上插件」。
        respond = (request) => {
            if (request.url.includes("raw.githubusercontent.com")) {
                throw new Error("simulated raw domain unreachable");
            }
            return { status: 200, text: '{"id":"demo"}' };
        };

        const content = await new GitHubHost().readFile(REF, "manifest.json");

        expect(content).toBe('{"id":"demo"}');
        expect(
            calls.some((call) =>
                call.url.includes("api.github.com/repos/owner/repo/contents/manifest.json")
            )
        ).toBe(true);
    });
});

describe("GitHubHost.downloadAsset", () => {
    it("公开仓库直接下载 browser_download_url", async () => {
        respond = () => ({ status: 200, text: "" });

        await new GitHubHost().downloadAsset(REF, {
            name: "main.js",
            size: 1,
            downloadUrl: "https://example.com/main.js",
            apiUrl: "https://api.github.com/assets/1",
        });

        expect(calls[0]!.url).toBe("https://example.com/main.js");
    });

    it("有令牌时改走 API 资产地址并要求二进制内容", async () => {
        // 私有仓库的 browser_download_url 会 404，必须走 API + octet-stream。
        respond = () => ({ status: 200, text: "" });

        await new GitHubHost().downloadAsset(
            REF,
            {
                name: "main.js",
                size: 1,
                downloadUrl: "https://example.com/main.js",
                apiUrl: "https://api.github.com/assets/1",
            },
            { token: "tok" }
        );

        expect(calls[0]!.url).toBe("https://api.github.com/assets/1");
        expect(calls[0]!.headers?.Accept).toBe("application/octet-stream");
    });
});

describe("GitHubHost 鉴权与错误映射", () => {
    it("令牌走 Authorization 请求头", () => {
        const result = new GitHubHost().applyAuth("https://api.github.com/user", "tok");

        expect(result.url).toBe("https://api.github.com/user");
        expect(result.headers.Authorization).toBe("Bearer tok");
    });

    it("403 且 remaining 为 0 才判定为限流", async () => {
        respond = () => ({
            status: 403,
            text: '{"message":"API rate limit exceeded"}',
            headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1800000000" },
        });

        const error = await new GitHubHost()
            .listReleases(REF)
            .catch((err: unknown) => err);

        expect(error).toBeInstanceOf(RateLimitError);
        expect((error as RateLimitError).resetAt).toBe(1_800_000_000_000);
    });

    it("403 但 remaining 不为 0 时按权限错误处理，不误报限流", async () => {
        respond = () => ({
            status: 403,
            text: '{"message":"Resource not accessible"}',
            headers: { "x-ratelimit-remaining": "42" },
        });

        const error = await new GitHubHost()
            .listReleases(REF)
            .catch((err: unknown) => err);

        expect(error).toBeInstanceOf(AuthError);
        expect(error).not.toBeInstanceOf(RateLimitError);
    });

    it("401 抛 AuthError", async () => {
        respond = () => ({ status: 401, text: '{"message":"Bad credentials"}' });

        await expect(new GitHubHost().getRepoMeta(REF, "bad")).rejects.toBeInstanceOf(AuthError);
    });

    it("404 的 latest release 返回 undefined", async () => {
        respond = () => ({ status: 404, text: '{"message":"Not Found"}' });

        await expect(new GitHubHost().getLatestRelease(REF)).resolves.toBeUndefined();
    });
});
