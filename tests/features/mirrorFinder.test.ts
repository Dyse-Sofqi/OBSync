import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __setRequestUrlHandler } from "../stubs/obsidian";
import { findGiteeMirror } from "../../src/features/installer/mirrorFinder";

/**
 * 镜像发现的核心安全约束：**宁可找不到，不可装错**。
 *
 * 同名仓库在 Gitee 上很常见，唯一可信的判据是两边 manifest 的 `id` 一致。
 * 所以这里的每个用例都在验证：任何一步证据不足，都必须返回 undefined。
 */

const GITHUB_MANIFEST = JSON.stringify({
    id: "demo",
    name: "Demo",
    version: "1.0.0",
    minAppVersion: "1.5.0",
});

const GITEE_SAME_ID = JSON.stringify({
    id: "demo",
    name: "Demo（Gitee 镜像）",
    version: "1.0.0",
    minAppVersion: "1.5.0",
});

const GITEE_DIFFERENT_ID = JSON.stringify({
    id: "totally-other-plugin",
    name: "同名但不同项目",
    version: "9.9.9",
    minAppVersion: "1.5.0",
});

beforeEach(() => {
    __setRequestUrlHandler(async (request) => {
        // GitHub 匿名读文件走 raw 域名，Gitee 走网页 raw 通道（见 host 层文档）。
        if (/^https:\/\/raw\.githubusercontent\.com\/owner\/demo\/HEAD\/manifest\.json$/.test(request.url)) {
            return { status: 200, text: GITHUB_MANIFEST };
        }
        if (/^https:\/\/gitee\.com\/owner\/demo\/raw\/HEAD\/manifest\.json$/.test(request.url)) {
            return { status: 200, text: GITEE_SAME_ID };
        }
        throw new Error(`no route for ${request.url}`);
    });
});

afterEach(() => {
    __setRequestUrlHandler(undefined);
});

describe("findGiteeMirror", () => {
    it("Gitee 有同名仓库且 manifest id 一致时命中", async () => {
        const mirror = await findGiteeMirror({ host: "github", owner: "owner", repo: "demo" });
        expect(mirror).toEqual({ host: "gitee", owner: "owner", repo: "demo" });
    });

    it("Gitee 仓库不存在时返回 undefined", async () => {
        __setRequestUrlHandler(async (request) => {
            if (/raw\.githubusercontent\.com/.test(request.url)) {
                return { status: 200, text: GITHUB_MANIFEST };
            }
            // 网页 raw 通道对不存在的仓库返回 404
            return { status: 404, text: "not found" };
        });

        const mirror = await findGiteeMirror({ host: "github", owner: "owner", repo: "demo" });
        expect(mirror).toBeUndefined();
    });

    it("同名但 manifest id 不同（装错插件风险）时返回 undefined", async () => {
        __setRequestUrlHandler(async (request) => {
            if (/raw\.githubusercontent\.com/.test(request.url)) {
                return { status: 200, text: GITHUB_MANIFEST };
            }
            return { status: 200, text: GITEE_DIFFERENT_ID };
        });

        const mirror = await findGiteeMirror({ host: "github", owner: "owner", repo: "demo" });
        expect(mirror).toBeUndefined();
    });

    it("Gitee 的 manifest 不合法时返回 undefined", async () => {
        __setRequestUrlHandler(async (request) => {
            if (/raw\.githubusercontent\.com/.test(request.url)) {
                return { status: 200, text: GITHUB_MANIFEST };
            }
            // 同名仓库存在，但内容根本不是插件
            return { status: 200, text: "<html>这不是插件</html>" };
        });

        const mirror = await findGiteeMirror({ host: "github", owner: "owner", repo: "demo" });
        expect(mirror).toBeUndefined();
    });

    it("GitHub 侧 manifest 拿不到时不切换 —— 没法校验就不冒险", async () => {
        // 源仓库的 manifest 读不到（比如被限流）就无法确认两边是同一个插件，
        // 此时切换镜像等于盲装，必须放弃。
        __setRequestUrlHandler(async (request) => {
            if (/raw\.githubusercontent\.com/.test(request.url)) {
                return { status: 404, text: "not found" };
            }
            return { status: 200, text: GITEE_SAME_ID };
        });

        const mirror = await findGiteeMirror({ host: "github", owner: "owner", repo: "demo" });
        expect(mirror).toBeUndefined();
    });
});
