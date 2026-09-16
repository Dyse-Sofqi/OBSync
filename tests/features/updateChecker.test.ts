import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __setRequestUrlHandler } from "../stubs/obsidian";
import { Notifier } from "../../src/core/notice";
import { SecretStore } from "../../src/core/secretStore";
import { normalizeSettings, type ObsyncSettings } from "../../src/core/settings";
import { zhCN } from "../../src/core/i18n/locales/zh-cn";
import { InstallerService } from "../../src/features/installer/installerService";
import { UpdateChecker } from "../../src/features/installer/updateChecker";
import type { TrackedPlugin } from "../../src/features/installer/types";
import { createFakeApp, type FakeApp } from "../helpers/fakeApp";

/**
 * UpdateChecker 的行为边界：
 * - 「检查」与「执行更新」是两个独立步骤，检查绝不自动安装。
 * - 冻结项不参与检查。
 * - 没有 release 的仓库（Gitee 常态）不算错误，报"无更新"。
 */

let routes: Array<{ match: RegExp; respond: () => { status: number; text?: string; headers?: Record<string, string> } }>;

function route(match: RegExp, respond: () => { status: number; text?: string; headers?: Record<string, string> }): void {
    routes.push({ match, respond });
}

function releaseJson(tag: string): string {
    return JSON.stringify({
        id: 1,
        tag_name: tag,
        name: tag,
        prerelease: false,
        draft: false,
        created_at: "2026-01-01T00:00:00Z",
        assets: [],
    });
}

function makeTracked(overrides: Partial<TrackedPlugin> = {}): TrackedPlugin {
    return {
        host: "github",
        owner: "owner",
        repo: "demo",
        pluginId: "demo",
        name: "Demo Plugin",
        installedVersion: "1.0.0",
        requestedVersion: "latest",
        frozen: false,
        channel: "release",
        installedAt: 0,
        ...overrides,
    };
}

function createContext(fake: FakeApp) {
    const settings: ObsyncSettings = normalizeSettings({});
    const service = new InstallerService({
        app: fake.app,
        notifier: new Notifier({ getShowNotices: () => true, getT: () => zhCN }),
        secretStore: new SecretStore(fake.app),
        getSettings: () => settings,
        getT: () => zhCN,
        saveSettings: async () => {},
    });
    return { checker: new UpdateChecker(service), settings };
}

beforeEach(() => {
    routes = [];
    __setRequestUrlHandler(async (request) => {
        for (const candidate of routes) {
            if (candidate.match.test(request.url)) {
                const result = candidate.respond();
                return { status: result.status, text: result.text ?? "", headers: result.headers };
            }
        }
        throw new Error(`no route for ${request.url}`);
    });
});

afterEach(() => {
    __setRequestUrlHandler(undefined);
});

describe("checkOne", () => {
    it("远端 tag 更新时报告有更新", async () => {
        const fake = createFakeApp();
        const { checker } = createContext(fake);
        route(/releases\/latest$/, () => ({ status: 200, text: releaseJson("v2.0.0") }));

        const result = await checker.checkOne(makeTracked({ installedVersion: "1.0.0" }));

        expect(result.hasUpdate).toBe(true);
        expect(result.latestVersion).toBe("v2.0.0");
        expect(result.error).toBeUndefined();
    });

    it("版本相同或更旧时报告无更新", async () => {
        const fake = createFakeApp();
        const { checker } = createContext(fake);
        route(/releases\/latest$/, () => ({ status: 200, text: releaseJson("v1.0.0") }));

        const result = await checker.checkOne(makeTracked({ installedVersion: "1.0.0" }));

        expect(result.hasUpdate).toBe(false);
    });

    it("仓库没有 release 时不算错误", async () => {
        // Gitee 上绝大多数插件仓库不发 release，无从比较是常态。
        const fake = createFakeApp();
        const { checker } = createContext(fake);
        route(/releases\/latest$/, () => ({ status: 404, text: '{"message":"Not Found"}' }));

        const result = await checker.checkOne(makeTracked());

        expect(result.hasUpdate).toBe(false);
        expect(result.error).toBeUndefined();
    });

    it("限流时把原因放进 error 字段而不是抛出", async () => {
        // 逐项检查必须容错：一个插件限流不该中断其余插件的信息展示。
        const fake = createFakeApp();
        const { checker } = createContext(fake);
        route(/releases\/latest$/, () => ({
            status: 403,
            text: '{"message":"API rate limit exceeded"}',
            headers: { "x-ratelimit-remaining": "0" },
        }));

        const result = await checker.checkOne(makeTracked());

        expect(result.hasUpdate).toBe(false);
        expect(result.error).toContain("调用次数已达上限");
    });
});

describe("checkAll", () => {
    it("跳过冻结项", async () => {
        const fake = createFakeApp();
        const { checker } = createContext(fake);
        route(/releases\/latest$/, () => ({ status: 200, text: releaseJson("v2.0.0") }));

        const summary = await checker.checkAll([
            makeTracked({ pluginId: "a", frozen: true }),
            makeTracked({ pluginId: "b" }),
        ]);

        expect(summary.results).toHaveLength(1);
        expect(summary.results[0]!.tracked.pluginId).toBe("b");
        expect(summary.outdated).toBe(1);
    });
});

describe("updateAll", () => {
    it("只更新 hasUpdate 的条目，失败的继续往后走", async () => {
        // 两个待更新：第一个故意缺 main.js 让安装失败，第二个应该照常装完 ——
        // 批量更新不能因为一个失败就整体中止。
        const fake = createFakeApp();
        const { checker } = createContext(fake);

        route(/repos\/owner\/broken\/releases\/latest$/, () => ({
            status: 200,
            text: releaseJson("v2.0.0"),
        }));
        route(/repos\/owner\/broken\/releases\/tags\/v2\.0\.0$/, () => ({
            status: 200,
            text: JSON.stringify({
                id: 1,
                tag_name: "v2.0.0",
                name: "v2.0.0",
                prerelease: false,
                draft: false,
                assets: [
                    {
                        id: 1,
                        name: "manifest.json",
                        size: 10,
                        browser_download_url: "https://dl.test/broken/manifest.json",
                    },
                ],
            }),
        }));
        route(/^https:\/\/dl\.test\/broken\/manifest\.json$/, () => ({
            status: 200,
            text: JSON.stringify({
                id: "broken",
                name: "Broken",
                version: "2.0.0",
                minAppVersion: "1.5.0",
            }),
        }));
        route(/raw\.githubusercontent\.com\/owner\/broken\/v2\.0\.0\/main\.js$/, () => ({
            status: 404,
            text: "not found",
        }));
        route(/raw\.githubusercontent\.com\/owner\/broken\/v2\.0\.0\/styles\.css$/, () => ({
            status: 404,
            text: "not found",
        }));

        route(/repos\/owner\/working\/releases\/latest$/, () => ({
            status: 200,
            text: releaseJson("v2.0.0"),
        }));
        route(/repos\/owner\/working\/releases\/tags\/v2\.0\.0$/, () => ({
            status: 200,
            text: JSON.stringify({
                id: 2,
                tag_name: "v2.0.0",
                name: "v2.0.0",
                prerelease: false,
                draft: false,
                assets: [
                    {
                        id: 1,
                        name: "manifest.json",
                        size: 10,
                        browser_download_url: "https://dl.test/working/manifest.json",
                    },
                    {
                        id: 2,
                        name: "main.js",
                        size: 10,
                        browser_download_url: "https://dl.test/working/main.js",
                    },
                ],
            }),
        }));
        route(/^https:\/\/dl\.test\/working\/manifest\.json$/, () => ({
            status: 200,
            text: JSON.stringify({
                id: "working",
                name: "Working",
                version: "2.0.0",
                minAppVersion: "1.5.0",
            }),
        }));
        route(/^https:\/\/dl\.test\/working\/main\.js$/, () => ({
            status: 200,
            text: "// main v2",
        }));
        route(/raw\.githubusercontent\.com\/owner\/working\/v2\.0\.0\/styles\.css$/, () => ({
            status: 404,
            text: "not found",
        }));

        const { updated, failed } = await checker.updateAll([
            {
                tracked: makeTracked({ pluginId: "broken", repo: "broken", name: "Broken" }),
                latestVersion: "v2.0.0",
                hasUpdate: true,
            },
            {
                tracked: makeTracked({ pluginId: "working", repo: "working", name: "Working" }),
                latestVersion: "v2.0.0",
                hasUpdate: true,
            },
            {
                tracked: makeTracked({ pluginId: "skipped" }),
                latestVersion: "1.0.0",
                hasUpdate: false,
            },
        ]);

        expect(updated.map((item) => item.pluginId)).toEqual(["working"]);
        expect(failed).toHaveLength(1);
        expect(failed[0]!.tracked.pluginId).toBe("broken");
        expect(fake.plugins.enabledPlugins.has("working")).toBe(true);
        expect(fake.plugins.enabledPlugins.has("broken")).toBe(false);
    });
});
