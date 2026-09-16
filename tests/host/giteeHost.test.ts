import { afterEach, beforeEach, describe, expect, it } from "vitest";
// 直接引 stub 文件而不是 "obsidian"：TS 会把 "obsidian" 解析到真实的类型包，
// 只有 vitest 运行时才走 alias。两边指向同一个模块实例，所以状态是共享的。
import { __setRequestUrlHandler } from "../stubs/obsidian";
import { GiteeHost } from "../../src/host/giteeHost";
import { RateLimitError } from "../../src/host/errors";
import { parseRepoRef } from "../../src/host/repoRef";

interface RecordedRequest {
    url: string;
    method?: string;
    headers?: Record<string, string>;
}

const REF = parseRepoRef("owner/repo", "gitee");

let calls: RecordedRequest[] = [];
let respond: (request: RecordedRequest) => {
    status: number;
    text?: string;
    headers?: Record<string, string>;
};

function useResponses(
    handler: (request: RecordedRequest) => {
        status: number;
        text?: string;
        headers?: Record<string, string>;
    }
): void {
    respond = handler;
}

beforeEach(() => {
    calls = [];
    respond = () => ({ status: 200, text: "{}" });
    __setRequestUrlHandler(async (request) => {
        calls.push({
            url: request.url,
            method: request.method,
            headers: request.headers,
        });
        return respond(request);
    });
});

afterEach(() => {
    __setRequestUrlHandler(undefined);
});

describe("GiteeHost.listReleases", () => {
    it("必须显式请求 direction=desc", async () => {
        // Gitee 的 releases 列表默认是**升序**（最旧在前），与 GitHub 相反。
        // 不传 direction=desc 会静默地拿到最旧的版本 —— 这是最容易埋的雷。
        useResponses(() => ({ status: 200, text: "[]" }));

        await new GiteeHost().listReleases(REF);

        expect(calls).toHaveLength(1);
        expect(calls[0]!.url).toContain("direction=desc");
        expect(calls[0]!.url).toContain("per_page=100");
        expect(calls[0]!.url).toContain("page=1");
    });

    it("把 Gitee 的 Release 结构映射成统一模型", async () => {
        useResponses(() => ({
            status: 200,
            text: JSON.stringify([
                {
                    id: 62730,
                    tag_name: "v1.2.0",
                    name: "v1.2.0",
                    prerelease: false,
                    created_at: "2026-03-27T21:13:11+08:00",
                    assets: [
                        {
                            id: 991,
                            name: "main.js",
                            size: 1234,
                            browser_download_url: "https://gitee.com/owner/repo/attach/1",
                        },
                    ],
                },
            ]),
        }));

        const releases = await new GiteeHost().listReleases(REF);

        expect(releases).toHaveLength(1);
        expect(releases[0]).toEqual({
            id: "62730",
            tag: "v1.2.0",
            name: "v1.2.0",
            prerelease: false,
            publishedAt: "2026-03-27T21:13:11+08:00",
            assets: [
                {
                    id: "991",
                    name: "main.js",
                    size: 1234,
                    downloadUrl: "https://gitee.com/owner/repo/attach/1",
                },
            ],
        });
    });

    it("includePrerelease 为 false 时过滤预发布版本", async () => {
        useResponses(() => ({
            status: 200,
            text: JSON.stringify([
                { id: 1, tag_name: "v2.0.0-beta", prerelease: true, created_at: "x", assets: [] },
                { id: 2, tag_name: "v1.0.0", prerelease: false, created_at: "y", assets: [] },
            ]),
        }));

        const releases = await new GiteeHost().listReleases(REF, {
            includePrerelease: false,
        });
        expect(releases.map((r) => r.tag)).toEqual(["v1.0.0"]);
    });

    it("跨页收集直到取满 limit", async () => {
        // per_page 上限是 100，所以 limit=120 会分成两页。
        // 服务端返回的条数少于请求的 per_page 时判定为末页 —— 这是标准做法。
        useResponses((request) => {
            const page = new URL(request.url).searchParams.get("page");
            const count = page === "1" ? 100 : 20;
            const base = page === "1" ? 0 : 100;
            return {
                status: 200,
                text: JSON.stringify(
                    Array.from({ length: count }, (_, i) => ({
                        id: base + i,
                        tag_name: `v${base + i}`,
                        prerelease: false,
                        created_at: "2026-01-01T00:00:00Z",
                        assets: [],
                    }))
                ),
            };
        });

        const releases = await new GiteeHost().listReleases(REF, { limit: 120 });

        expect(releases).toHaveLength(120);
        expect(releases[0]!.tag).toBe("v0");
        expect(releases[119]!.tag).toBe("v119");
        expect(calls.map((c) => new URL(c.url).searchParams.get("page"))).toEqual(["1", "2"]);
    });

    it("服务端返回空页时立即停止，不空转", async () => {
        useResponses(() => ({ status: 200, text: "[]" }));

        await new GiteeHost().listReleases(REF, { limit: 100 });

        expect(calls).toHaveLength(1);
    });
});

describe("GiteeHost 鉴权注入", () => {
    it("令牌走查询参数，不是请求头", () => {
        const result = new GiteeHost().applyAuth("https://gitee.com/api/v5/repos/a/b", "tok");

        expect(result.url).toBe(
            "https://gitee.com/api/v5/repos/a/b?access_token=tok"
        );
        expect(result.headers.Authorization).toBeUndefined();
    });

    it("已有查询串时用 & 拼接", () => {
        const result = new GiteeHost().applyAuth(
            "https://gitee.com/api/v5/repos/a/b?ref=main",
            "tok"
        );
        expect(result.url).toBe("https://gitee.com/api/v5/repos/a/b?ref=main&access_token=tok");
    });

    it("令牌会随请求实际发出", async () => {
        useResponses(() => ({ status: 200, text: JSON.stringify({ default_branch: "master" }) }));

        await new GiteeHost().getRepoMeta(REF, "secret");

        expect(calls[0]!.url).toContain("access_token=secret");
    });

    it("无令牌时不带 access_token", async () => {
        useResponses(() => ({ status: 200, text: JSON.stringify({ default_branch: "master" }) }));

        await new GiteeHost().getRepoMeta(REF);

        expect(calls[0]!.url).not.toContain("access_token");
    });
});

describe("GiteeHost.readFile", () => {
    it("无令牌时走网页 raw 通道（API raw 端点对匿名请求返回 401）", async () => {
        // 实测：/v5/repos/{o}/{r}/raw/{path} 即使对公开仓库也返回
        // 401「登录失效，无权限访问该资源」。所以匿名读文件只能走网页通道。
        useResponses(() => ({ status: 200, text: '{"id":"demo"}' }));

        const content = await new GiteeHost().readFile(REF, "manifest.json", { ref: "main" });

        expect(content).toBe('{"id":"demo"}');
        expect(calls).toHaveLength(1);
        expect(calls[0]!.url).toBe("https://gitee.com/owner/repo/raw/main/manifest.json");
        expect(calls[0]!.url).not.toContain("/api/v5/");
    });

    it("未指定 ref 时先查默认分支，再走网页通道", async () => {
        useResponses((request) =>
            request.url.includes("/api/v5/repos/owner/repo")
                ? { status: 200, text: JSON.stringify({ default_branch: "master" }) }
                : { status: 200, text: "// main.js" }
        );

        const content = await new GiteeHost().readFile(REF, "main.js");

        expect(content).toBe("// main.js");
        expect(calls).toHaveLength(2);
        expect(calls[0]!.url).toBe("https://gitee.com/api/v5/repos/owner/repo");
        expect(calls[1]!.url).toBe("https://gitee.com/owner/repo/raw/master/main.js");
    });

    it("默认分支只查一次，后续读取复用缓存", async () => {
        useResponses((request) =>
            request.url.includes("/api/v5/repos/owner/repo")
                ? { status: 200, text: JSON.stringify({ default_branch: "master" }) }
                : { status: 200, text: "x" }
        );

        const host = new GiteeHost();
        await host.readFile(REF, "manifest.json");
        await host.readFile(REF, "main.js");

        const metaCalls = calls.filter((c) => c.url === "https://gitee.com/api/v5/repos/owner/repo");
        expect(metaCalls).toHaveLength(1);
    });

    it("有令牌时走 API 通道（私有仓库唯一可行路径）", async () => {
        useResponses(() => ({ status: 200, text: '{"id":"demo"}' }));

        const content = await new GiteeHost().readFile(REF, "manifest.json", {
            token: "tok",
            ref: "main",
        });

        expect(content).toBe('{"id":"demo"}');
        expect(calls).toHaveLength(1);
        expect(calls[0]!.url).toBe(
            "https://gitee.com/api/v5/repos/owner/repo/raw/manifest.json?ref=main&access_token=tok"
        );
    });

    it("API 通道 404 时回退到网页通道再试一次", async () => {
        useResponses((request) =>
            request.url.includes("/api/v5/")
                ? { status: 404, text: '{"message":"Not Found"}' }
                : { status: 200, text: "// main.js" }
        );

        const content = await new GiteeHost().readFile(REF, "main.js", {
            token: "tok",
            ref: "master",
        });

        expect(content).toBe("// main.js");
        expect(calls).toHaveLength(2);
        expect(calls[1]!.url).toBe("https://gitee.com/owner/repo/raw/master/main.js");
    });

    it("两条通道都 404 时返回 undefined", async () => {
        useResponses(() => ({ status: 404, text: '{"message":"Not Found"}' }));

        await expect(
            new GiteeHost().readFile(REF, "nope.json", { ref: "main" })
        ).resolves.toBeUndefined();
    });

    it("拿不到默认分支时返回 undefined 而不是抛错", async () => {
        useResponses(() => ({ status: 404, text: '{"message":"Not Found"}' }));

        await expect(new GiteeHost().readFile(REF, "manifest.json")).resolves.toBeUndefined();
    });

    it("逐段编码路径，保留斜杠", async () => {
        useResponses(() => ({ status: 200, text: "x" }));

        await new GiteeHost().readFile(REF, "src/my file.ts", { ref: "main" });

        expect(calls[0]!.url).toBe("https://gitee.com/owner/repo/raw/main/src/my%20file.ts");
    });
});

describe("GiteeHost 错误映射", () => {
    it("404 的 latest release 返回 undefined（仓库没发过 release 是正常状态）", async () => {
        useResponses(() => ({ status: 404, text: '{"message":"Not Found"}' }));

        await expect(new GiteeHost().getLatestRelease(REF)).resolves.toBeUndefined();
    });

    it("403 带中文限流提示时抛 RateLimitError", async () => {
        useResponses(() => ({ status: 403, text: '{"message":"请求过于频繁，请稍后再试"}' }));

        await expect(new GiteeHost().listReleases(REF)).rejects.toBeInstanceOf(RateLimitError);
    });

    it("403 但不是限流时按权限错误处理", async () => {
        useResponses(() => ({ status: 403, text: '{"message":"Forbidden"}' }));

        const error = await new GiteeHost()
            .listReleases(REF)
            .catch((err: unknown) => err);
        expect(error).not.toBeInstanceOf(RateLimitError);
    });
});

describe("GiteeHost.validateToken", () => {
    it("成功时返回账号名", async () => {
        useResponses(() => ({ status: 200, text: JSON.stringify({ login: "sofqi" }) }));

        await expect(new GiteeHost().validateToken("tok")).resolves.toEqual({
            valid: true,
            account: "sofqi",
        });
    });

    it("401 时返回 valid: false", async () => {
        useResponses(() => ({ status: 401, text: '{"message":"Unauthorized"}' }));

        await expect(new GiteeHost().validateToken("bad")).resolves.toEqual({ valid: false });
    });
});
