import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __setRequestUrlHandler } from "../stubs/obsidian";
import { Notifier } from "../../src/core/notice";
import { SecretStore } from "../../src/core/secretStore";
import { normalizeSettings, type ObsyncSettings } from "../../src/core/settings";
import { zhCN } from "../../src/core/i18n/locales/zh-cn";
import { InstallerService } from "../../src/features/installer/installerService";
import {
    shouldCheckOnSettingsOpen,
    UpdateChecker,
} from "../../src/features/installer/updateChecker";
import type { TrackedPlugin } from "../../src/features/installer/types";
import { createFakeApp, type FakeApp } from "../helpers/fakeApp";

/**
 * UpdateChecker 的行为边界：
 * - 「检查」与「执行更新」是两个独立步骤，检查绝不自动安装。
 * - 冻结项不参与检查。
 * - 没有 release 的仓库（Gitee 常态）不算错误，报"无更新"。
 */

let routes: Array<{
    match: RegExp;
    respond: (request: {
        url: string;
        headers?: Record<string, string>;
    }) => { status: number; text?: string; headers?: Record<string, string> };
}>;

function route(
    match: RegExp,
    respond: (request: { url: string; headers?: Record<string, string> }) => {
        status: number;
        text?: string;
        headers?: Record<string, string>;
    }
): void {
    routes.push({ match, respond });
}

/**
 * release 的**对象**形态。
 *
 * 单独拆出来是因为列表接口返回的是数组 —— `JSON.stringify([releaseJson(tag)])`
 * 会得到「数组里装着一个字符串」，`mapRelease` 读不到 `tag_name`，
 * 于是 `latest.tag` 是 undefined（症状是 `isNewerVersion` 里 `.trim()` 报错）。
 */
function releaseObject(tag: string, prerelease = false) {
    return {
        id: 1,
        tag_name: tag,
        name: tag,
        prerelease,
        draft: false,
        created_at: "2026-01-01T00:00:00Z",
        assets: [],
    };
}

function releaseJson(tag: string, prerelease = false): string {
    return JSON.stringify(releaseObject(tag, prerelease));
}

/** 列表接口的响应体：一个 release 数组。 */
function releaseListJson(...tags: Array<string | [string, true]>): string {
    return JSON.stringify(
        tags.map((entry) =>
            Array.isArray(entry) ? releaseObject(entry[0], true) : releaseObject(entry)
        )
    );
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
    const secretStore = new SecretStore(fake.app);
    const service = new InstallerService({
        app: fake.app,
        notifier: new Notifier({ getShowNotices: () => true, getT: () => zhCN }),
        secretStore,
        getSettings: () => settings,
        getT: () => zhCN,
        saveSettings: async () => {},
    });
    return { checker: new UpdateChecker(service), settings, secretStore };
}

beforeEach(() => {
    routes = [];
    __setRequestUrlHandler(async (request) => {
        for (const candidate of routes) {
            if (candidate.match.test(request.url)) {
                const result = candidate.respond(request);
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
        route(/releases\?per_page=/, () => ({ status: 200, text: "[]" }));

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

describe("检查路径必须是安装路径的**完整**镜像", () => {
    /**
     * 这一组守的是一条不变式：**安装能得到的东西，检查必须能报出来**。
     *
     * 两条路径在同一件事上做了不同选择，而症状是同一个：
     * 用户看到「已是最新」，但其实有得更新 —— 他只能靠手动重装才发现。
     *
     * | | 安装（`resolveSource`） | 检查（`checkOne`） |
     * |---|---|---|
     * | 凭据 | 传 token | **不传** |
     * | 回退 | 正式版 → 预发布 → 源码 | **只认正式版** |
     *
     * 凭据那条还多一层代价：不带令牌走的是**匿名配额**。Gitee 的匿名配额极低
     * （超限后约一分钟不恢复），项目为此专门加了「进入设置页 10 分钟节流」——
     * 而这里白白把那些额度花掉了，正是它想避免的 403。
     */

    it("带上用户的令牌（GitHub）—— 私有仓库不带令牌会被当成 404", async () => {
        const fake = createFakeApp();
        const { checker, secretStore } = createContext(fake);
        secretStore.setToken("github", "ghp_seeded");

        // 真实行为：私有仓库在未鉴权时返回 404（而不是 403）——
        // 平台刻意不泄漏「这个仓库存在」。于是检查会把它读成「没有 release」。
        route(/releases\/latest$/, (request) => {
            const authorized = request.headers?.Authorization === "Bearer ghp_seeded";
            return authorized
                ? { status: 200, text: releaseJson("v2.0.0") }
                : { status: 404, text: '{"message":"Not Found"}' };
        });

        const result = await checker.checkOne(makeTracked({ installedVersion: "1.0.0" }));

        expect(result.hasUpdate).toBe(true);
        expect(result.latestVersion).toBe("v2.0.0");
    });

    it("带上用户的令牌（Gitee）—— 令牌走查询串", async () => {
        // Gitee 的令牌只能放查询串（见 IRepoHost.applyAuth），所以这条要单独验。
        const fake = createFakeApp();
        const { checker, secretStore } = createContext(fake);
        secretStore.setToken("gitee", "gitee_tok");

        route(/releases\/latest/, (request) =>
            request.url.includes("access_token=gitee_tok")
                ? { status: 200, text: releaseJson("v2.0.0") }
                : { status: 403, text: '{"message":"rate limit"}' }
        );

        const result = await checker.checkOne(
            makeTracked({ host: "gitee", installedVersion: "1.0.0" })
        );

        expect(result.hasUpdate).toBe(true);
        expect(result.error).toBeUndefined();
    });

    it("令牌按平台各走各的，不会串台", async () => {
        // 反向守卫：修「不带令牌」时最省事的错法是随手取一个令牌 ——
        // 那会把 GitHub 的令牌发给 Gitee（等于把凭据交给另一个平台）。
        const fake = createFakeApp();
        const { checker, secretStore } = createContext(fake);
        secretStore.setToken("github", "gh_token");
        secretStore.setToken("gitee", "gitee_token");

        const seen: Array<{ url: string; authorization?: string }> = [];
        route(/releases\/latest/, (request) => {
            seen.push({ url: request.url, authorization: request.headers?.Authorization });
            return { status: 200, text: releaseJson("v2.0.0") };
        });

        await checker.checkOne(makeTracked({ host: "github" }));
        await checker.checkOne(makeTracked({ host: "gitee" }));

        const [githubReq, giteeReq] = seen;
        expect(githubReq!.authorization).toBe("Bearer gh_token");
        expect(githubReq!.url).not.toContain("access_token");

        // Gitee 的令牌只能放查询串（见 IRepoHost.applyAuth）
        expect(giteeReq!.url).toContain("access_token=gitee_token");
        expect(giteeReq!.authorization).toBeUndefined();
    });

    it("没配令牌时不凭空造一个鉴权头", async () => {
        const fake = createFakeApp();
        const { checker } = createContext(fake);

        let authorization: string | undefined = "unset";
        route(/releases\/latest$/, (request) => {
            authorization = request.headers?.Authorization;
            return { status: 200, text: releaseJson("v2.0.0") };
        });

        await checker.checkOne(makeTracked({ host: "github" }));

        expect(authorization).toBeUndefined();
    });

    it("只有预发布版时也要报出来 —— 安装路径装得到它", async () => {
        // `/releases/latest` 只给正式版（GitHub 的定义：非 draft、非 prerelease）。
        // 全是预发布版时它返回 404，而 resolveSource 正是在这里往下走了
        // 「看看有没有预发布版」那一级 —— 检查路径也得走同一级。
        const fake = createFakeApp();
        const { checker } = createContext(fake);
        route(/releases\/latest$/, () => ({ status: 404, text: '{"message":"Not Found"}' }));
        route(/releases\?per_page=/, () => ({
            status: 200,
            text: releaseListJson(["v2.0.0-beta.1", true]),
        }));

        const result = await checker.checkOne(makeTracked({ installedVersion: "1.0.0" }));

        expect(result.hasUpdate).toBe(true);
        expect(result.latestVersion).toBe("v2.0.0-beta.1");
        expect(result.error).toBeUndefined();
    });

    it("有正式版时不会被预发布版抢走（只在 404 之后才回退）", async () => {
        // 回退条件的守卫：若哪天改成「先列 release 再挑」，就会把预发布版
        // 报给一个只想用正式版的用户。
        const fake = createFakeApp();
        const { checker } = createContext(fake);
        route(/releases\/latest$/, () => ({ status: 200, text: releaseJson("v2.0.0") }));
        route(/releases\?per_page=/, () => ({
            status: 200,
            text: releaseListJson(["v3.0.0-beta.1", true]),
        }));

        const result = await checker.checkOne(makeTracked({ installedVersion: "1.0.0" }));

        expect(result.latestVersion).toBe("v2.0.0");
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

    it("检查结果写入 availableUpdates：有更新记入、无更新清除、失败保留旧记录", async () => {
        // 徽标常驻在已跟踪列表里（Notice 一闪就错过），数据就来自这里。
        const fake = createFakeApp();
        const { checker, settings } = createContext(fake);

        // 预置旧记录：fresh 本已无更新（应被清除）、failing 上次报过更新（检查失败应保留）
        settings.installer.availableUpdates = {
            fresh: { latestVersion: "v9.9.9", checkedAt: 1 },
            failing: { latestVersion: "v9.9.9", checkedAt: 1 },
        };

        route(/repos\/owner\/updated\/releases\/latest$/, () => ({
            status: 200,
            text: releaseJson("v2.0.0"),
        }));
        route(/repos\/owner\/fresh\/releases\/latest$/, () => ({
            status: 200,
            text: releaseJson("v1.0.0"),
        }));
        route(/repos\/owner\/failing\/releases\/latest$/, () => ({
            status: 403,
            text: '{"message":"rate limit"}',
            headers: { "x-ratelimit-remaining": "0" },
        }));

        await checker.checkAll([
            makeTracked({ pluginId: "updated", repo: "updated" }),
            makeTracked({ pluginId: "fresh", repo: "fresh", installedVersion: "1.0.0" }),
            makeTracked({ pluginId: "failing", repo: "failing" }),
        ]);

        expect(settings.installer.availableUpdates["updated"]).toEqual({
            latestVersion: "v2.0.0",
            checkedAt: expect.any(Number),
        });
        expect(settings.installer.availableUpdates["fresh"]).toBeUndefined();
        // 检查失败不动旧记录：过期信息好过没有
        expect(settings.installer.availableUpdates["failing"]).toEqual({
            latestVersion: "v9.9.9",
            checkedAt: 1,
        });
    });
});

describe("shouldCheckOnSettingsOpen（进入设置页自动检查的判据）", () => {
    const base = {
        enabled: true,
        autoCheckOnSettingsOpen: true,
        trackedCount: 2,
        lastCheckAt: 0,
        now: 1_000_000_000,
    };

    it("条件齐备且从未检查过时放行", () => {
        expect(shouldCheckOnSettingsOpen(base)).toBe(true);
    });

    it("安装器关闭、开关关闭、无跟踪插件时都不检查", () => {
        expect(shouldCheckOnSettingsOpen({ ...base, enabled: false })).toBe(false);
        expect(
            shouldCheckOnSettingsOpen({ ...base, autoCheckOnSettingsOpen: false })
        ).toBe(false);
        expect(shouldCheckOnSettingsOpen({ ...base, trackedCount: 0 })).toBe(false);
    });

    it("距上次检查太近时跳过（防止反复开合设置页打光配额）", () => {
        const fiveMinutesAgo = base.now - 5 * 60 * 1000;
        expect(
            shouldCheckOnSettingsOpen({ ...base, lastCheckAt: fiveMinutesAgo })
        ).toBe(false);

        const fifteenMinutesAgo = base.now - 15 * 60 * 1000;
        expect(
            shouldCheckOnSettingsOpen({ ...base, lastCheckAt: fifteenMinutesAgo })
        ).toBe(true);
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
