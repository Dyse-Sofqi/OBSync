import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __setRequestUrlHandler } from "../stubs/obsidian";
import { CommunityPluginIndex } from "../../src/features/installer/communityPlugins";
import { expectInstallerError } from "../helpers/expectInstallerError";

/**
 * 官方社区插件索引的解析与检索。
 *
 * 索引托管在 GitHub raw 上（7000+ 条目），统计文件是可选的 ——
 * 拿不到下载量不能影响浏览功能本身。
 */

const PLUGINS_JSON = JSON.stringify([
    { id: "alpha", name: "Alpha", author: "alice", description: "第一个插件", repo: "alice/alpha" },
    { id: "beta", name: "Beta Notes", author: "bob", description: "笔记增强", repo: "bob/beta" },
    { id: "gamma", name: "Gamma", author: "carol", description: "含 alpha 关键词的描述", repo: "carol/gamma" },
    // 缺 repo 的脏数据必须被跳过，不能让整份索引挂掉
    { id: "broken", name: "Broken" },
]);

const STATS_JSON = JSON.stringify({
    alpha: { downloads: 1500 },
    beta: { downloads: 2000000 },
});

beforeEach(() => {
    __setRequestUrlHandler(async (request) => {
        if (request.url.endsWith("community-plugins.json")) {
            return { status: 200, text: PLUGINS_JSON };
        }
        if (request.url.endsWith("community-plugin-stats.json")) {
            return { status: 200, text: STATS_JSON };
        }
        throw new Error(`no route for ${request.url}`);
    });
});

afterEach(() => {
    __setRequestUrlHandler(undefined);
});

describe("CommunityPluginIndex.load", () => {
    it("解析条目并合并下载量，跳过缺字段的脏数据", async () => {
        const index = new CommunityPluginIndex();
        const plugins = await index.load();

        expect(index.size).toBe(3);
        expect(plugins.map((plugin) => plugin.id)).toEqual(["alpha", "beta", "gamma"]);
        expect(plugins[0]!.downloads).toBe(1500);
        expect(plugins[1]!.downloads).toBe(2_000_000);
        expect(plugins[2]!.downloads).toBeUndefined();
    });

    it("统计文件拿不到时不影响索引本身", async () => {
        __setRequestUrlHandler(async (request) => {
            if (request.url.endsWith("community-plugins.json")) {
                return { status: 200, text: PLUGINS_JSON };
            }
            return { status: 404, text: "not found" };
        });

        const index = new CommunityPluginIndex();
        const plugins = await index.load();

        expect(index.size).toBe(3);
        expect(plugins[0]!.downloads).toBeUndefined();
    });

    it("索引本身拿不到时抛错", async () => {
        // 没有索引就没有这个功能，必须让调用方知道失败，
        // 而不是给用户一个空的搜索结果。
        __setRequestUrlHandler(async () => ({ status: 404, text: "not found" }));

        const index = new CommunityPluginIndex();
        // 断言类型码而不是消息文本 —— 文案来自 locale，改文案不该让测试变红。
        await expectInstallerError(() => index.load(), "communityIndexFailed");
    });

    it("并发 load 只发一轮请求", async () => {
        let fetchCount = 0;
        __setRequestUrlHandler(async (request) => {
            if (request.url.endsWith("community-plugins.json")) {
                fetchCount += 1;
                return { status: 200, text: PLUGINS_JSON };
            }
            return { status: 404, text: "not found" };
        });

        const index = new CommunityPluginIndex();
        await Promise.all([index.load(), index.load(), index.load()]);

        expect(fetchCount).toBe(1);
    });
});

describe("CommunityPluginIndex.search", () => {
    it("多关键词是与关系", async () => {
        const index = new CommunityPluginIndex();
        await index.load();

        const hits = index.search("alpha 描述");
        expect(hits.map((plugin) => plugin.id)).toEqual(["gamma"]);
    });

    it("名称命中的排在描述命中的前面", async () => {
        const index = new CommunityPluginIndex();
        await index.load();

        const hits = index.search("alpha");
        expect(hits[0]!.id).toBe("alpha");
        expect(hits[1]!.id).toBe("gamma");
    });

    it("空查询返回热门列表", async () => {
        const index = new CommunityPluginIndex();
        await index.load();

        const hits = index.search("");
        expect(hits[0]!.id).toBe("beta");
        expect(hits[1]!.id).toBe("alpha");
    });
});
