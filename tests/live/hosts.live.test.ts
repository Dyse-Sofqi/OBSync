/**
 * 真实 API 验证。
 *
 * 这些用例会真的访问 api.github.com / gitee.com，默认**不参与** `pnpm test`。
 * 用 `pnpm test:live` 运行。
 *
 * 它们存在的意义：单元测试只能证明「我们按预期拼了 URL」，
 * 证明不了「这个 URL 真的能用」。Gitee 的几处差异（默认升序、
 * API raw 端点需要登录）都是在这一层被发现的，不是靠读文档。
 */
import { beforeAll, describe, expect, it } from "vitest";
import { __setRequestUrlHandler } from "../stubs/obsidian";
import { GiteeHost } from "../../src/host/giteeHost";
import { GitHubHost } from "../../src/host/githubHost";
import { httpJson, httpRequest } from "../../src/host/http";
import { RateLimitError } from "../../src/host/errors";
import {
    fetchFiles,
    PLUGIN_SPEC,
} from "../../src/features/installer/installFiles";
import { parseRepoRef } from "../../src/host/repoRef";
import type { Release } from "../../src/host/types";

const LIVE_TIMEOUT = 30_000;

beforeAll(() => {
    // 把 stub 的 requestUrl 接到 Node 的 fetch 上，这样 host 层代码原样运行。
    __setRequestUrlHandler(async (request) => {
        const response = await fetch(request.url, {
            method: request.method ?? "GET",
            headers: request.headers,
            body: (request.body as BodyInit | undefined) ?? undefined,
            redirect: "follow",
        });
        const arrayBuffer = await response.arrayBuffer();
        const headers: Record<string, string> = {};
        response.headers.forEach((value, key) => {
            headers[key] = value;
        });
        return {
            status: response.status,
            headers,
            text: new TextDecoder().decode(arrayBuffer),
            arrayBuffer,
        };
    });
}, LIVE_TIMEOUT);

function newestFirst(releases: Release[]): boolean {
    const times = releases.map((release) => Date.parse(release.publishedAt));
    return times.every((time, index) => index === 0 || times[index - 1]! >= time);
}

/**
 * Gitee 令牌。有的话所有 Gitee API 调用都会带上，配额立刻宽裕。
 *
 * 用法：`OBSYNC_GITEE_TOKEN=xxx pnpm test:live`
 */
const GITEE_TOKEN = process.env.OBSYNC_GITEE_TOKEN || undefined;

/**
 * 跑一段依赖 Gitee **API** 的用例，遇到限流时跳过而不是判失败。
 *
 * 为什么这么处理：Gitee 的匿名 API 配额实测极低 —— 连续请求十几个之后
 * 直接 `403 Rate Limit Exceeded`，且一分钟内不恢复（见 HANDOVER 第七节第 13 条）。
 * 如果照原样判失败，`pnpm test:live` 在没有令牌的机器上**长期飘红**，
 * 而「预期会红的套件」比跳过更糟：它会训练人忽略失败，真有回归时也看不出来。
 *
 * 跳过会打印可行动的提示（配令牌），并且**只在没有令牌时**才跳过 ——
 * 配了令牌还被限流，那是真的有问题，必须暴露。
 *
 * 注意：走网页 raw 通道的用例**不要**用这个包装 —— 那条通道不吃 API 配额，
 * 任何情况下都该真跑。
 */
async function withGiteeApi<T>(
    ctx: { skip: () => void },
    run: (token: string | undefined) => Promise<T>
): Promise<T | undefined> {
    try {
        return await run(GITEE_TOKEN);
    } catch (err) {
        if (err instanceof RateLimitError && !GITEE_TOKEN) {
            console.warn(
                "  [skip] Gitee 匿名 API 已限流。" +
                    "设 OBSYNC_GITEE_TOKEN=<令牌> 后重跑可避免跳过。"
            );
            ctx.skip();
            return undefined;
        }
        throw err;
    }
}

describe("GitHub 真实链路", () => {
    const REF = parseRepoRef("Dyse-Sofqi/Glimpse");

    it("取仓库元信息", async () => {
        const meta = await new GitHubHost().getRepoMeta(REF);

        expect(meta.defaultBranch).toBe("main");
        expect(meta.isPrivate).toBe(false);
        expect(meta.webUrl).toBe("https://github.com/Dyse-Sofqi/Glimpse");
    }, LIVE_TIMEOUT);

    it("release 列表是降序的", async () => {
        const releases = await new GitHubHost().listReleases(REF, { limit: 5 });

        expect(releases.length).toBeGreaterThan(0);
        expect(newestFirst(releases)).toBe(true);
    }, LIVE_TIMEOUT);

    it("走完整的「安装前准备」流程：列版本 → 取齐文件 → 校验", async () => {
        const host = new GitHubHost();
        const releases = await host.listReleases(REF, { limit: 5 });
        const latest = releases[0]!;

        expect(latest.assets.map((asset) => asset.name)).toEqual(
            expect.arrayContaining(["main.js", "manifest.json"])
        );

        // 走**安装器真实的取文件路径**，而不是直接调 `downloadAsset`。
        // 后者只验证资产 CDN 这一条链路，而资产 CDN（github.com →
        // objects.githubusercontent.com）在本地实测 3 次里 2 次 21 秒超时 ——
        // 直接调它会让这条用例假失败。产品要保证的是「文件最终能取到」，
        // 至于是走资产还是走源码，是实现细节。
        const { files, manifest, channel } = await fetchFiles(
            host,
            REF,
            { kind: "release", tag: latest.tag, ref: latest.tag },
            undefined,
            PLUGIN_SPEC
        );

        expect(manifest.id).toBe("glimpse");
        expect(files.get("main.js")).toBeTruthy();
        // 资产可达时 channel 为 release，不可达时降级为 raw —— 两者都算成功。
        expect(["release", "raw"]).toContain(channel);
    }, LIVE_TIMEOUT);

    it("匿名 raw 通道可读文件", async () => {
        const content = await new GitHubHost().readFile(REF, "manifest.json");

        expect(content).toBeTruthy();
        expect((JSON.parse(content!) as { id: string }).id).toBe("glimpse");
    }, LIVE_TIMEOUT);

    it("读不存在的文件返回 undefined", async () => {
        await expect(
            new GitHubHost().readFile(REF, "definitely-not-here.json")
        ).resolves.toBeUndefined();
    }, LIVE_TIMEOUT);
});

describe("Gitee 真实链路", () => {
    const REF = parseRepoRef("mindspore/mindspore", "gitee");

    it("release 列表是降序的（Gitee 默认升序，必须显式纠正）", async (ctx) => {
        const releases = await withGiteeApi(ctx, (token) =>
            new GiteeHost().listReleases(REF, { token, limit: 10 })
        );
        if (!releases) return;

        expect(releases.length).toBeGreaterThan(0);
        expect(newestFirst(releases)).toBe(true);
    }, LIVE_TIMEOUT);

    it("对照实验：不传 direction 时 Gitee 返回的是最旧的版本", async (ctx) => {
        // 这条用例是「为什么必须传 direction=desc」的实证依据。
        // 它直接打平台接口，不经过 host 层 —— 故意如此。
        const query = GITEE_TOKEN ? `&access_token=${encodeURIComponent(GITEE_TOKEN)}` : "";
        const ascending = await httpJson<Array<{ created_at: string }>>({
            url: `https://gitee.com/api/v5/repos/mindspore/mindspore/releases?per_page=5${query}`,
        });
        const descending = await httpJson<Array<{ created_at: string }>>({
            url: `https://gitee.com/api/v5/repos/mindspore/mindspore/releases?per_page=5&direction=desc${query}`,
        });

        // httpJson 不因 4xx 抛错，所以这里要自己判断限流（否则会以"断言失败"的形式误报）。
        if (ascending.status === 403 || descending.status === 403) {
            if (!GITEE_TOKEN) {
                console.warn("  [skip] Gitee 匿名 API 已限流。");
                ctx.skip();
                return;
            }
        }

        expect(ascending.status).toBe(200);
        expect(descending.status).toBe(200);

        const firstAscending = Date.parse(ascending.data![0]!.created_at);
        const firstDescending = Date.parse(descending.data![0]!.created_at);

        // 默认顺序拿到的第一个是最旧的，desc 拿到的第一个是最新的。
        expect(firstAscending).toBeLessThan(firstDescending);
    }, LIVE_TIMEOUT);

    it("仓库元信息可读取，且 html_url 已去掉 .git 后缀", async (ctx) => {
        const meta = await withGiteeApi(ctx, (token) =>
            new GiteeHost().getRepoMeta(REF, token)
        );
        if (!meta) return;

        expect(meta.defaultBranch).toBe("master");
        expect(meta.webUrl).toBe("https://gitee.com/mindspore/mindspore");
        expect(meta.webUrl).not.toContain(".git");
    }, LIVE_TIMEOUT);

    it("匿名 raw 通道可读文件（API raw 端点对匿名请求是 401，必须走网页通道）", async () => {
        const content = await new GiteeHost().readFile(REF, "README.md", { ref: "master" });

        expect(content).toBeTruthy();
        expect(content!.length).toBeGreaterThan(100);
    }, LIVE_TIMEOUT);

    it("不指定 ref 时用 HEAD 也能读到文件（省掉一次 API 调用）", async () => {
        const content = await new GiteeHost().readFile(REF, "README.md");

        expect(content).toBeTruthy();
    }, LIVE_TIMEOUT);

    it("网页 raw 通道可零 API 配额探测仓库存在性（镜像发现的可行性依据）", async () => {
        // 镜像发现靠这条路：存在的仓库返回 manifest，不存在返回 404，
        // 全程不消耗 /api/v5 的配额 —— 在匿名配额极低的前提下这是唯一可行的做法。
        const existing = await httpRequest({
            url: "https://gitee.com/mindspore/mindspore/raw/HEAD/README.md",
        });
        const missingRepo = await httpRequest({
            url: "https://gitee.com/mindspore/definitely-not-a-repo-xyz/raw/HEAD/manifest.json",
        });

        expect(existing.status).toBe(200);
        expect(missingRepo.status).toBe(404);
    }, LIVE_TIMEOUT);

    it("读不存在的文件返回 undefined 而不是抛错", async () => {
        await expect(
            new GiteeHost().readFile(REF, "definitely-not-here.md", { ref: "master" })
        ).resolves.toBeUndefined();
    }, LIVE_TIMEOUT);
});
