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

    it("走完整的「安装前准备」流程：列版本 → 取 manifest → 校验", async () => {
        // 这是安装器在阶段二要走的路，现在先把它在 host 层跑通。
        const host = new GitHubHost();
        const releases = await host.listReleases(REF, { limit: 5 });
        const latest = releases[0]!;

        expect(latest.assets.map((asset) => asset.name)).toEqual(
            expect.arrayContaining(["main.js", "manifest.json"])
        );

        const manifestAsset = latest.assets.find((asset) => asset.name === "manifest.json")!;
        const bytes = await host.downloadAsset(REF, manifestAsset);
        const manifest = JSON.parse(new TextDecoder().decode(bytes)) as {
            id: string;
            version: string;
        };

        expect(manifest.id).toBe("glimpse");
        expect(manifest.version).toBe(latest.tag);
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

    it("release 列表是降序的（Gitee 默认升序，必须显式纠正）", async () => {
        const releases = await new GiteeHost().listReleases(REF, { limit: 10 });

        expect(releases.length).toBeGreaterThan(0);
        expect(newestFirst(releases)).toBe(true);
    }, LIVE_TIMEOUT);

    it("对照实验：不传 direction 时 Gitee 返回的是最旧的版本", async () => {
        // 这条用例是「为什么必须传 direction=desc」的实证依据。
        // 它直接打平台接口，不经过 host 层 —— 故意如此。
        const ascending = await httpJson<Array<{ created_at: string }>>({
            url: "https://gitee.com/api/v5/repos/mindspore/mindspore/releases?per_page=5",
        });
        const descending = await httpJson<Array<{ created_at: string }>>({
            url: "https://gitee.com/api/v5/repos/mindspore/mindspore/releases?per_page=5&direction=desc",
        });

        expect(ascending.status).toBe(200);
        expect(descending.status).toBe(200);

        const firstAscending = Date.parse(ascending.data![0]!.created_at);
        const firstDescending = Date.parse(descending.data![0]!.created_at);

        // 默认顺序拿到的第一个是最旧的，desc 拿到的第一个是最新的。
        expect(firstAscending).toBeLessThan(firstDescending);
    }, LIVE_TIMEOUT);

    it("仓库元信息可匿名读取，且 html_url 已去掉 .git 后缀", async () => {
        const meta = await new GiteeHost().getRepoMeta(REF);

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
