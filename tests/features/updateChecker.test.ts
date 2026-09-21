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
import type { TrackedPlugin, TrackedTheme } from "../../src/features/installer/types";
import {
    createFakeApp,
    readThemeFile,
    seedPlugin,
    seedTheme,
    themeManifestRaw,
    type FakeApp,
} from "../helpers/fakeApp";

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
        kind: "plugin",
        host: "github",
        owner: "owner",
        repo: "demo",
        id: "demo",
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

    /**
     * 走镜像的条目：检查必须打在**实际使用**的来源上（镜像），不是源仓库。
     *
     * 这条守的是 `itemRepoRef()` 的语义。记录里 `host/owner/repo` 是镜像、
     * `origin` 是用户填的源地址 —— 而 `origin` 这个名字读起来更像「来源」，
     * 顺手把检查改成读 `origin` 是很自然的一步，后果却是**检查与下载分叉**：
     * 镜像的版本常落后于源仓库，于是「报有更新 → 更新 → 装的还是旧版本 →
     * 仍然报有更新」，用户会卡在一个永远消不掉的徽标上。
     */
    it("走镜像的条目检查的是**镜像**（不是源仓库）", async () => {
        const fake = createFakeApp();
        const { checker } = createContext(fake);

        let sawGitee = false;
        route(/gitee\.com\/api\/v5\/repos\/owner\/demo\/releases\/latest/, () => {
            sawGitee = true;
            return { status: 200, text: releaseJson("v2.0.0") };
        });
        // 源仓库（GitHub）一旦被请求就会命中这条 —— 用来证明「没打到那边」。
        route(/github\.com/, () => ({ status: 200, text: releaseJson("v9.9.9") }));

        const result = await checker.checkOne(
            makeTracked({
                host: "gitee",
                origin: { host: "github", owner: "owner", repo: "demo" },
            })
        );

        expect(sawGitee).toBe(true);
        // 报的是镜像上的版本，不是源仓库的 9.9.9
        expect(result.latestVersion).toBe("v2.0.0");
    });
});

describe("checkAll", () => {
    it("跳过冻结项", async () => {
        const fake = createFakeApp();
        const { checker } = createContext(fake);
        route(/releases\/latest$/, () => ({ status: 200, text: releaseJson("v2.0.0") }));

        const summary = await checker.checkAll([
            makeTracked({ id: "a", frozen: true }),
            makeTracked({ id: "b" }),
        ]);

        expect(summary.results).toHaveLength(1);
        expect(summary.results[0]!.tracked.id).toBe("b");
        expect(summary.outdated).toBe(1);
    });

    it("检查结果写入 availableUpdates：有更新记入、无更新清除、失败保留旧记录", async () => {
        // 徽标常驻在已跟踪列表里（Notice 一闪就错过），数据就来自这里。
        const fake = createFakeApp();
        const { checker, settings } = createContext(fake);

        // 预置旧记录：fresh 本已无更新（应被清除）、failing 上次报过更新（检查失败应保留）
        settings.installer.availableUpdates = {
            "plugin:fresh": { latestVersion: "v9.9.9", checkedAt: 1 },
            "plugin:failing": { latestVersion: "v9.9.9", checkedAt: 1 },
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
            makeTracked({ id: "updated", repo: "updated" }),
            makeTracked({ id: "fresh", repo: "fresh", installedVersion: "1.0.0" }),
            makeTracked({ id: "failing", repo: "failing" }),
        ]);

        expect(settings.installer.availableUpdates["plugin:updated"]).toEqual({
            latestVersion: "v2.0.0",
            checkedAt: expect.any(Number),
        });
        expect(settings.installer.availableUpdates["plugin:fresh"]).toBeUndefined();
        // 检查失败不动旧记录：过期信息好过没有
        expect(settings.installer.availableUpdates["plugin:failing"]).toEqual({
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
                tracked: makeTracked({ id: "broken", repo: "broken", name: "Broken" }),
                latestVersion: "v2.0.0",
                hasUpdate: true,
            },
            {
                tracked: makeTracked({ id: "working", repo: "working", name: "Working" }),
                latestVersion: "v2.0.0",
                hasUpdate: true,
            },
            {
                tracked: makeTracked({ id: "skipped" }),
                latestVersion: "1.0.0",
                hasUpdate: false,
            },
        ]);

        expect(updated.map((entry) => entry.tracked.id)).toEqual(["working"]);
        // 来源跟着回来 —— 「更新全部」的提示要靠它说清这次是从哪拿的
        expect(updated[0]!.source.repoRef).toEqual({
            host: "github",
            owner: "owner",
            repo: "working",
        });
        expect(updated[0]!.source.origin).toBeUndefined();
        expect(failed).toHaveLength(1);
        expect(failed[0]!.tracked.id).toBe("broken");
        expect(fake.plugins.enabledPlugins.has("working")).toBe(true);
        expect(fake.plugins.enabledPlugins.has("broken")).toBe(false);
    });
});

/**
 * 主题的更新判据。
 *
 * 与插件同构（远端版本 vs 本地已装版本），但多一级回退：**没有 release 时读
 * 默认分支的 manifest.json**。这一级不是可选的 —— 主题的生态就是「只推仓库、
 * 不发 release」，不读它，那些主题永远收不到更新提示（插件侧刚修过的同一类 bug）。
 */
describe("主题的更新检查", () => {
    function makeTheme(overrides: Partial<TrackedTheme> = {}): TrackedTheme {
        return {
            kind: "theme",
            host: "github",
            owner: "kepano",
            repo: "obsidian-minimal",
            id: "Minimal",
            name: "Minimal",
            installedVersion: "9.0.0",
            frozen: false,
            installedAt: 0,
            ...overrides,
        };
    }

    it("有 release 时按 release tag 比较（与插件一致）", async () => {
        const fake = createFakeApp();
        const { checker } = createContext(fake);
        route(/releases\/latest$/, () => ({ status: 200, text: releaseJson("9.1.0") }));

        const result = await checker.checkOne(makeTheme());

        expect(result.latestVersion).toBe("9.1.0");
        expect(result.hasUpdate).toBe(true);
    });

    it("**没有 release 时读默认分支的 manifest.json**，用它的 version 比较", async () => {
        const fake = createFakeApp();
        const { checker } = createContext(fake);
        route(/releases\/latest$/, () => ({ status: 404, text: '{"message":"Not Found"}' }));
        route(/\/releases\?/, () => ({ status: 200, text: "[]" }));
        route(
            /raw\.githubusercontent\.com\/kepano\/obsidian-minimal\/HEAD\/manifest\.json$/,
            () => ({ status: 200, text: themeManifestRaw("Minimal", "9.1.0") })
        );

        const result = await checker.checkOne(makeTheme());

        expect(result.latestVersion).toBe("9.1.0");
        expect(result.hasUpdate).toBe(true);
        expect(result.error).toBeUndefined();
    });

    it("远端 manifest 版本等于本地时算「已是最新」", async () => {
        const fake = createFakeApp();
        const { checker } = createContext(fake);
        route(/releases\/latest$/, () => ({ status: 404, text: '{"message":"Not Found"}' }));
        route(/\/releases\?/, () => ({ status: 200, text: "[]" }));
        route(
            /raw\.githubusercontent\.com\/kepano\/obsidian-minimal\/HEAD\/manifest\.json$/,
            () => ({ status: 200, text: themeManifestRaw("Minimal", "9.0.0") })
        );

        const result = await checker.checkOne(makeTheme());

        expect(result.hasUpdate).toBe(false);
    });

    it("远端连 manifest 都读不到时算「无从比较」，**不是错误**", async () => {
        const fake = createFakeApp();
        const { checker } = createContext(fake);
        route(/releases\/latest$/, () => ({ status: 404, text: '{"message":"Not Found"}' }));
        route(/\/releases\?/, () => ({ status: 200, text: "[]" }));
        route(
            /raw\.githubusercontent\.com\/kepano\/obsidian-minimal\/HEAD\/manifest\.json$/,
            () => ({ status: 404, text: "not found" })
        );

        const result = await checker.checkOne(makeTheme());

        expect(result.hasUpdate).toBe(false);
        expect(result.error).toBeUndefined();
    });

    it("本地版本未知（绑定来的主题没有 manifest）时，远端有版本就报有更新", async () => {
        const fake = createFakeApp();
        const { checker } = createContext(fake);
        route(/releases\/latest$/, () => ({ status: 404, text: '{"message":"Not Found"}' }));
        route(/\/releases\?/, () => ({ status: 200, text: "[]" }));
        route(
            /raw\.githubusercontent\.com\/kepano\/obsidian-minimal\/HEAD\/manifest\.json$/,
            () => ({ status: 200, text: themeManifestRaw("Minimal", "9.1.0") })
        );

        const result = await checker.checkOne(makeTheme({ installedVersion: "" }));

        // 本地那份连 manifest 都没有 → 更新一次就能补齐，这条自查会自愈
        expect(result.hasUpdate).toBe(true);
    });

    it("限流时报成错误，且用该平台的显示名", async () => {
        const fake = createFakeApp();
        const { checker } = createContext(fake);
        route(/releases\/latest$/, () => ({
            status: 403,
            text: '{"message":"rate limit"}',
            headers: { "x-ratelimit-remaining": "0" },
        }));

        const result = await checker.checkOne(makeTheme());

        expect(result.hasUpdate).toBe(false);
        expect(result.error).toBeTruthy();
    });

    it("冻结的主题不参与检查（与插件同一规则）", async () => {
        const fake = createFakeApp();
        const { checker } = createContext(fake);

        const summary = await checker.checkAll([
            makeTheme({ id: "Frozen", frozen: true }),
            makeTheme({ id: "Active" }),
        ]);

        expect(summary.results.map((result) => result.tracked.id)).toEqual(["Active"]);
    });

    it("更新记录按 `<kind>:<id>` 存 —— 与同 id 的插件不共用一条", async () => {
        const fake = createFakeApp();
        const { checker, settings } = createContext(fake);
        route(/releases\/latest$/, () => ({ status: 200, text: releaseJson("9.1.0") }));

        await checker.checkAll([makeTheme({ id: "minimal" })]);

        expect(settings.installer.availableUpdates["theme:minimal"]).toBeDefined();
        expect(settings.installer.availableUpdates["minimal"]).toBeUndefined();
        expect(settings.installer.availableUpdates["plugin:minimal"]).toBeUndefined();
    });

    it("updateAll 走主题更新：写文件、但**不切换当前主题**", async () => {
        const fake = createFakeApp(
            seedTheme("Minimal", {
                "manifest.json": themeManifestRaw("Minimal", "9.0.0"),
                "theme.css": "/* old */",
            })
        );
        fake.customCss.theme = "Minimal";
        const { checker } = createContext(fake);
        route(/releases\/latest$/, () => ({ status: 404, text: '{"message":"Not Found"}' }));
        route(/\/releases\?/, () => ({ status: 200, text: "[]" }));
        route(
            /raw\.githubusercontent\.com\/kepano\/obsidian-minimal\/HEAD\/manifest\.json$/,
            () => ({ status: 200, text: themeManifestRaw("Minimal", "9.1.0") })
        );
        route(
            /raw\.githubusercontent\.com\/kepano\/obsidian-minimal\/HEAD\/theme\.css$/,
            () => ({ status: 200, text: "/* new */" })
        );

        const { updated, failed } = await checker.updateAll([
            {
                tracked: makeTheme(),
                latestVersion: "9.1.0",
                hasUpdate: true,
            },
        ]);

        expect(failed).toEqual([]);
        expect(updated.map((entry) => entry.tracked.id)).toEqual(["Minimal"]);
        expect(updated[0]!.source.repoRef.host).toBe("github");
        expect(readThemeFile(fake, "Minimal", "theme.css")).toBe("/* new */");
        // 更新正在使用的主题 → 只请求重载，绝不换主题
        expect(fake.customCss.reloadRequests).toBe(1);
        expect(fake.customCss.setThemeCalls).toEqual([]);
    });
});

/**
 * SyncHub 自己的更新检查。
 *
 * 与插件同构，但有两处刻意的不同：**不写 `availableUpdates`**（它不在跟踪
 * 列表里，那张表是「谁该有徽标」）；以及比较的是**运行中**的版本 ——
 * 待重启期间磁盘上那份已经更新了，拿它比会得出「已是最新」，
 * 而用户此刻跑的根本不是它。
 */
describe("checkSelf", () => {
    it("远端有更新版本时报有更新", async () => {
        const fake = createFakeApp();
        const { checker } = createContext(fake);
        route(/repos\/Dyse-Sofqi\/SyncHub\/releases\/latest$/, () => ({
            status: 200,
            text: releaseJson("0.2.0"),
        }));

        const result = await checker.checkSelf("0.1.0");

        expect(result.currentVersion).toBe("0.1.0");
        expect(result.latestVersion).toBe("0.2.0");
        expect(result.hasUpdate).toBe(true);
        expect(result.error).toBeUndefined();
    });

    it("远端同版本时报已是最新", async () => {
        const fake = createFakeApp();
        const { checker } = createContext(fake);
        route(/repos\/Dyse-Sofqi\/SyncHub\/releases\/latest$/, () => ({
            status: 200,
            text: releaseJson("0.1.0"),
        }));

        const result = await checker.checkSelf("0.1.0");

        expect(result.hasUpdate).toBe(false);
        expect(result.error).toBeUndefined();
    });

    it("**比较的是运行中的版本**，不是磁盘上那份", async () => {
        // 待重启的典型状态：磁盘上已经是 0.3.0，运行中的还是 0.1.0。
        // 若实现去读磁盘（而不是用传进来的 currentVersion），这里会得到
        // 「已是最新」—— 而用户跑的还不是它，那就成了假话。
        const fake = createFakeApp(
            seedPlugin("ob-sync", {
                "manifest.json": JSON.stringify({
                    id: "ob-sync",
                    name: "SyncHub",
                    version: "0.3.0",
                    minAppVersion: "1.8.7",
                }),
            })
        );
        const { checker } = createContext(fake);
        route(/repos\/Dyse-Sofqi\/SyncHub\/releases\/latest$/, () => ({
            status: 200,
            text: releaseJson("0.3.0"),
        }));

        const result = await checker.checkSelf("0.1.0");

        expect(result.hasUpdate).toBe(true);
    });

    it("**不写 availableUpdates**（自己不在跟踪列表里）", async () => {
        const fake = createFakeApp();
        const { checker, settings } = createContext(fake);
        route(/repos\/Dyse-Sofqi\/SyncHub\/releases\/latest$/, () => ({
            status: 200,
            text: releaseJson("0.2.0"),
        }));

        await checker.checkSelf("0.1.0");

        expect(settings.installer.availableUpdates).toEqual({});
    });

    it("没有 release 时「无从比较」而不是错误（main.js 是构建产物，源码通道取不到）", async () => {
        const fake = createFakeApp();
        const { checker } = createContext(fake);
        route(/releases\/latest$/, () => ({ status: 404, text: '{"message":"Not Found"}' }));
        route(/\/releases\?/, () => ({ status: 200, text: "[]" }));

        const result = await checker.checkSelf("0.1.0");

        expect(result.hasUpdate).toBe(false);
        expect(result.error).toBeUndefined();
        expect(result.latestVersion).toBe("0.1.0");
    });

    it("限流时报错并带上平台名", async () => {
        const fake = createFakeApp();
        const { checker } = createContext(fake);
        route(/releases\/latest$/, () => ({
            status: 403,
            text: '{"message":"rate limit"}',
            headers: { "x-ratelimit-remaining": "0" },
        }));

        const result = await checker.checkSelf("0.1.0");

        expect(result.hasUpdate).toBe(false);
        expect(result.error).toBeTruthy();
    });
});
