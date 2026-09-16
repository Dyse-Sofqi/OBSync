import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __setApiVersion, __setRequestUrlHandler } from "../stubs/obsidian";
import { Notifier } from "../../src/core/notice";
import { SecretStore } from "../../src/core/secretStore";
import { normalizeSettings, type ObsyncSettings } from "../../src/core/settings";
import { zhCN } from "../../src/core/i18n/locales/zh-cn";
import { InstallerService, type InstallerHost } from "../../src/features/installer/installerService";
import { createFakeApp, readPluginFile, seedPlugin, type FakeApp } from "../helpers/fakeApp";
import { expectInstallerError } from "../helpers/expectInstallerError";

/** 路由式 HTTP mock：按 URL 正则匹配，返回预设响应。 */
interface Route {
    match: RegExp;
    respond: () => { status: number; text?: string };
}

let routes: Route[] = [];
let calls: string[] = [];

function route(match: RegExp, respond: Route["respond"]): void {
    routes.push({ match, respond });
}

beforeEach(() => {
    routes = [];
    calls = [];
    __setApiVersion("1.13.1");
    __setRequestUrlHandler(async (request) => {
        calls.push(request.url);
        for (const candidate of routes) {
            if (candidate.match.test(request.url)) {
                const result = candidate.respond();
                return { status: result.status, text: result.text ?? "" };
            }
        }
        throw new Error(`no route for ${request.url}`);
    });
});

afterEach(() => {
    __setRequestUrlHandler(undefined);
});

const MANIFEST = JSON.stringify({
    id: "demo",
    name: "Demo Plugin",
    version: "2.0.0",
    minAppVersion: "1.5.0",
});

function releaseJson(assets: Array<{ name: string; url: string }>): string {
    return JSON.stringify({
        id: 1,
        tag_name: "v2.0.0",
        name: "v2.0.0",
        prerelease: false,
        draft: false,
        created_at: "2026-01-01T00:00:00Z",
        assets: assets.map((asset, index) => ({
            id: index + 1,
            name: asset.name,
            size: 10,
            browser_download_url: asset.url,
            url: `https://api.github.com/assets/${index + 1}`,
        })),
    });
}

function createService(fake: FakeApp, settings?: Partial<ObsyncSettings>): {
    service: InstallerService;
    host: InstallerHost;
    settings: ObsyncSettings;
} {
    const resolved = { ...normalizeSettings({}), ...settings };
    const notifier = new Notifier({ getShowNotices: () => true, getT: () => zhCN });
    const host: InstallerHost = {
        app: fake.app,
        notifier,
        secretStore: new SecretStore(fake.app),
        getSettings: () => resolved,
        getT: () => zhCN,
        saveSettings: async () => {},
    };
    return { service: new InstallerService(host), host, settings: resolved };
}

/** 装好「GitHub release 通道」的一组路由。 */
function setupReleaseChannel(): void {
    route(/releases\/latest$/, () => ({ status: 200, text: releaseJson([]) }));
    route(/releases\/tags\/v2\.0\.0$/, () => ({
        status: 200,
        text: releaseJson([
            { name: "manifest.json", url: "https://dl.test/manifest.json" },
            { name: "main.js", url: "https://dl.test/main.js" },
        ]),
    }));
    route(/^https:\/\/dl\.test\/manifest\.json$/, () => ({ status: 200, text: MANIFEST }));
    route(/^https:\/\/dl\.test\/main\.js$/, () => ({ status: 200, text: "// main v2" }));
    // styles.css 不在资产里，raw 也 404：可选文件应被静默跳过。
    // 不写这条路由的话，请求会走「无路由抛错 → 重试退避」，白耗 1.6 秒。
    route(/raw\.githubusercontent\.com\/owner\/demo\/v2\.0\.0\/styles\.css$/, () => ({
        status: 404,
        text: "not found",
    }));
}

describe("install —— release 通道", () => {
    it("全新安装：写入文件、记录到跟踪列表", async () => {
        const fake = createFakeApp();
        const { service, settings } = createService(fake);
        setupReleaseChannel();

        const result = await service.install({ repo: "owner/demo", enableAfterInstall: true });

        expect(result.version).toBe("2.0.0");
        expect(result.channel).toBe("release");
        expect(result.replaced).toBe(false);
        expect(result.enabled).toBe(true);

        expect(readPluginFile(fake, "demo", "manifest.json")).toBe(MANIFEST);
        expect(readPluginFile(fake, "demo", "main.js")).toBe("// main v2");

        expect(settings.installer.tracked).toHaveLength(1);
        expect(settings.installer.tracked[0]).toMatchObject({
            host: "github",
            owner: "owner",
            repo: "demo",
            pluginId: "demo",
            installedVersion: "2.0.0",
            requestedVersion: "latest",
            channel: "release",
            frozen: false,
        });
    });

    it("不勾选启用时只写文件", async () => {
        const fake = createFakeApp();
        const { service } = createService(fake);
        setupReleaseChannel();

        const result = await service.install({ repo: "owner/demo", enableAfterInstall: false });

        expect(result.enabled).toBe(false);
        expect(fake.plugins.enabledPlugins.has("demo")).toBe(false);
    });

    it("release 资产里缺 manifest.json 时，回到该 tag 的源码里找", async () => {
        // 有些作者只把 main.js 传成资产，manifest 留在仓库里。
        // BRAT 在这种仓库上会直接失败。
        const fake = createFakeApp();
        const { service } = createService(fake);

        route(/releases\/latest$/, () => ({ status: 200, text: releaseJson([]) }));
        route(/releases\/tags\/v2\.0\.0$/, () => ({
            status: 200,
            text: releaseJson([{ name: "main.js", url: "https://dl.test/main.js" }]),
        }));
        route(/^https:\/\/dl\.test\/main\.js$/, () => ({ status: 200, text: "// main v2" }));
        route(/raw\.githubusercontent\.com\/owner\/demo\/v2\.0\.0\/manifest\.json$/, () => ({
            status: 200,
            text: MANIFEST,
        }));
        route(/raw\.githubusercontent\.com\/owner\/demo\/v2\.0\.0\/styles\.css$/, () => ({
            status: 404,
            text: "not found",
        }));

        const result = await service.install({ repo: "owner/demo" });

        expect(result.version).toBe("2.0.0");
        expect(readPluginFile(fake, "demo", "manifest.json")).toBe(MANIFEST);
    });

    it("release 资产下载失败时回退到该 tag 的源码文件", async () => {
        // 资产下载走 github.com → objects.githubusercontent.com，这条链路
        // 在国内网络下经常不可达（本机实测 3 次里 2 次 21 秒超时 0 字节），
        // 而同一个文件在 raw 通道上现成可取。不回退的话症状是
        // 「网络稍差就完全装不上插件」。
        const fake = createFakeApp();
        const { service } = createService(fake);

        route(/releases\/latest$/, () => ({ status: 200, text: releaseJson([]) }));
        route(/releases\/tags\/v2\.0\.0$/, () => ({
            status: 200,
            text: releaseJson([
                { name: "manifest.json", url: "https://dl.test/manifest.json" },
                { name: "main.js", url: "https://dl.test/main.js" },
            ]),
        }));
        // 资产下载一律抛网络错误（会触发 http 层的重试退避）
        route(/^https:\/\/dl\.test\//, () => {
            throw new Error("simulated CDN unreachable");
        });
        // 源码通道正常
        route(/raw\.githubusercontent\.com\/owner\/demo\/v2\.0\.0\/manifest\.json$/, () => ({
            status: 200,
            text: MANIFEST,
        }));
        route(/raw\.githubusercontent\.com\/owner\/demo\/v2\.0\.0\/main\.js$/, () => ({
            status: 200,
            text: "// main from source",
        }));
        route(/raw\.githubusercontent\.com\/owner\/demo\/v2\.0\.0\/styles\.css$/, () => ({
            status: 404,
            text: "not found",
        }));

        const result = await service.install({ repo: "owner/demo" });

        expect(result.version).toBe("2.0.0");
        expect(readPluginFile(fake, "demo", "main.js")).toBe("// main from source");
        expect(readPluginFile(fake, "demo", "manifest.json")).toBe(MANIFEST);
    });

    it("更新已有插件时保留冻结状态", async () => {
        const fake = createFakeApp(seedPlugin("demo", { "manifest.json": MANIFEST }));
        const { service, settings } = createService(fake);
        settings.installer.tracked = [
            {
                host: "github",
                owner: "owner",
                repo: "demo",
                pluginId: "demo",
                name: "Demo Plugin",
                installedVersion: "1.0.0",
                requestedVersion: "latest",
                frozen: true,
                channel: "release",
                installedAt: 0,
            },
        ];
        setupReleaseChannel();

        const result = await service.install({ repo: "owner/demo" });

        expect(result.replaced).toBe(true);
        expect(settings.installer.tracked[0]!.frozen).toBe(true);
        expect(settings.installer.tracked[0]!.installedVersion).toBe("2.0.0");
    });
});

describe("install —— 降级到源码通道", () => {
    it("仓库没有 release 时走源码文件", async () => {
        // Gitee 上这是常态：绝大多数插件仓库不发 release。
        const fake = createFakeApp();
        const { service } = createService(fake);

        route(/releases\/latest$/, () => ({ status: 404, text: '{"message":"Not Found"}' }));
        route(/\/releases\?/, () => ({ status: 200, text: "[]" }));
        route(/raw\.githubusercontent\.com\/owner\/demo\/HEAD\/manifest\.json$/, () => ({
            status: 200,
            text: MANIFEST,
        }));
        route(/raw\.githubusercontent\.com\/owner\/demo\/HEAD\/main\.js$/, () => ({
            status: 200,
            text: "// main from source",
        }));
        route(/raw\.githubusercontent\.com\/owner\/demo\/HEAD\/styles\.css$/, () => ({
            status: 404,
            text: "not found",
        }));

        const result = await service.install({ repo: "owner/demo" });

        expect(result.channel).toBe("raw");
        expect(readPluginFile(fake, "demo", "main.js")).toBe("// main from source");
    });

    it("API 限流时降级并提示用户去配令牌", async () => {
        // Gitee 的匿名配额极低，实测会直接 403。没有这条降级路径就完全装不了。
        const fake = createFakeApp();
        const { service } = createService(fake);

        route(/releases\/latest$/, () => ({
            status: 403,
            text: '{"message":"API rate limit exceeded"}',
            // 限流判定需要这个头
        }));
        route(/raw\.githubusercontent\.com\/owner\/demo\/HEAD\/manifest\.json$/, () => ({
            status: 200,
            text: MANIFEST,
        }));
        route(/raw\.githubusercontent\.com\/owner\/demo\/HEAD\/main\.js$/, () => ({
            status: 200,
            text: "// main",
        }));
        route(/raw\.githubusercontent\.com\/owner\/demo\/HEAD\/styles\.css$/, () => ({
            status: 404,
            text: "not found",
        }));

        // 让 403 被识别为限流：需要 x-ratelimit-remaining: 0
        __setRequestUrlHandler(async (request) => {
            calls.push(request.url);
            if (/releases\/latest$/.test(request.url)) {
                return {
                    status: 403,
                    text: '{"message":"API rate limit exceeded"}',
                    headers: { "x-ratelimit-remaining": "0" },
                };
            }
            if (request.url.includes("raw.githubusercontent.com")) {
                return {
                    status: request.url.endsWith("styles.css") ? 404 : 200,
                    text: request.url.endsWith("manifest.json")
                        ? MANIFEST
                        : request.url.endsWith("main.js")
                          ? "// main"
                          : "not found",
                };
            }
            throw new Error(`no route for ${request.url}`);
        });

        const result = await service.install({ repo: "owner/demo" });

        expect(result.channel).toBe("raw");
        expect(readPluginFile(fake, "demo", "main.js")).toBe("// main");
    });
});

describe("install —— 校验与失败路径", () => {
    it("缺少 main.js 时中止，不留下半成品目录", async () => {
        const fake = createFakeApp();
        const { service } = createService(fake);

        route(/releases\/latest$/, () => ({ status: 200, text: releaseJson([]) }));
        route(/releases\/tags\/v2\.0\.0$/, () => ({
            status: 200,
            text: releaseJson([{ name: "manifest.json", url: "https://dl.test/manifest.json" }]),
        }));
        route(/^https:\/\/dl\.test\/manifest\.json$/, () => ({ status: 200, text: MANIFEST }));
        route(/raw\.githubusercontent\.com\/owner\/demo\/v2\.0\.0\/main\.js$/, () => ({
            status: 404,
            text: "not found",
        }));
        route(/raw\.githubusercontent\.com\/owner\/demo\/v2\.0\.0\/styles\.css$/, () => ({
            status: 404,
            text: "not found",
        }));

        await expectInstallerError(
            () => service.install({ repo: "owner/demo" }),
            "missingRequiredFiles"
        );
        expect(readPluginFile(fake, "demo", "manifest.json")).toBeUndefined();
    });

    it("Obsidian 版本过低时中止安装", async () => {
        __setApiVersion("1.4.0");
        const fake = createFakeApp();
        const { service } = createService(fake);
        setupReleaseChannel();

        await expectInstallerError(
            () => service.install({ repo: "owner/demo" }),
            "incompatibleApp"
        );
        // 兼容性检查必须在写盘之前 —— 写完才发现就得回滚了。
        expect(readPluginFile(fake, "demo", "main.js")).toBeUndefined();
    });

    it("地址无法解析时报错", async () => {
        const fake = createFakeApp();
        const { service } = createService(fake);

        await expect(service.install({ repo: "not a repo" })).rejects.toThrow();
    });
});

describe("uninstall", () => {
    it("禁用、删目录、移出跟踪列表", async () => {
        const fake = createFakeApp(seedPlugin("demo", { "manifest.json": MANIFEST }));
        const { service, settings } = createService(fake);
        await fake.plugins.enablePluginAndSave("demo");
        settings.installer.tracked = [
            {
                host: "github",
                owner: "owner",
                repo: "demo",
                pluginId: "demo",
                name: "Demo Plugin",
                installedVersion: "2.0.0",
                requestedVersion: "latest",
                frozen: false,
                channel: "release",
                installedAt: 0,
            },
        ];

        await service.uninstall(settings.installer.tracked[0]!);

        expect(fake.plugins.enabledPlugins.has("demo")).toBe(false);
        expect(readPluginFile(fake, "demo", "manifest.json")).toBeUndefined();
        expect(settings.installer.tracked).toHaveLength(0);
    });
});
