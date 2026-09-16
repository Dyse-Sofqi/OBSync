import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __setApiVersion, __setRequestUrlHandler } from "../stubs/obsidian";
import { Notifier } from "../../src/core/notice";
import { SecretStore } from "../../src/core/secretStore";
import { normalizeSettings, type ObsyncSettings } from "../../src/core/settings";
import { zhCN } from "../../src/core/i18n/locales/zh-cn";
import { InstallerService, type InstallerHost } from "../../src/features/installer/installerService";
import { createFakeApp, readPluginFile, type FakeApp } from "../helpers/fakeApp";
import { expectInstallerError } from "../helpers/expectInstallerError";

/**
 * **用真实的 `GiteeHost` 驱动完整的安装流程。**
 *
 * ## 为什么单独写这一组
 *
 * PLAN 阶段二的验收标准之一是「能从 Gitee 装只有源码没有 release 的插件」，
 * 但这条路径一直没被真正走通过：
 * - `installerService.test.ts` 用的是 mock 的 host，验的是**编排**；
 * - `giteeHost.test.ts` / live 测试验的是 **host 单独工作**。
 *
 * 两者都对，但**组合起来**可能有缝隙（比如安装器按 GitHub 的形状调用、
 * 或者 Gitee 的 raw 回退在编排里没被触发）。而这正是用户实际会走的路。
 *
 * ## 为什么不用真实 Gitee 仓库
 *
 * 找过了：Gitee 上没有公开的 Obsidian 插件仓库（`mirrors` 组织也没有，
 * 网页搜索页对匿名请求返回 405，API 搜索要么空要么被限流）。
 * 所以这里用**真实的 GiteeHost + 按 Gitee 实际响应形状构造的 mock**。
 *
 * 它验证的是「GiteeHost 在安装器驱动下行为正确」，不验证「Gitee 服务端此刻可达」——
 * 后者由 live 测试负责。
 */

const MANIFEST = JSON.stringify({
    id: "gitee-demo",
    name: "Gitee Demo",
    version: "1.2.0",
    minAppVersion: "1.0.0",
});

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

function createService(fake: FakeApp): InstallerService {
    const settings: ObsyncSettings = normalizeSettings({});
    const host: InstallerHost = {
        app: fake.app,
        notifier: new Notifier({ getShowNotices: () => true, getT: () => zhCN }),
        secretStore: new SecretStore(fake.app),
        getSettings: () => settings,
        getT: () => zhCN,
        saveSettings: async () => undefined,
    };
    return new InstallerService(host);
}

describe("从 Gitee 安装「只有源码、没有 release」的插件", () => {
    /** 这类仓库在 Gitee 上是常态：一个 release 都没有。 */
    function setupSourcelessRoutes(): void {
        // 没有 latest release
        route(/gitee\.com\/api\/v5\/repos\/owner\/repo\/releases\/latest/, () => ({
            status: 404,
            text: '{"message":"Not Found"}',
        }));
        // release 列表为空 —— 注意 Gitee 默认升序，实现里必须传 direction=desc
        route(/gitee\.com\/api\/v5\/repos\/owner\/repo\/releases\?/, () => ({
            status: 200,
            text: "[]",
        }));
        // 匿名读文件走网页 raw 通道（API raw 端点对匿名请求是 401）
        route(/gitee\.com\/owner\/repo\/raw\/HEAD\/manifest\.json/, () => ({
            status: 200,
            text: MANIFEST,
        }));
        route(/gitee\.com\/owner\/repo\/raw\/HEAD\/main\.js/, () => ({
            status: 200,
            text: "// main from gitee source",
        }));
        route(/gitee\.com\/owner\/repo\/raw\/HEAD\/styles\.css/, () => ({
            status: 404,
            text: "not found",
        }));
    }

    it("装成功，并记录为 Gitee 的源码通道", async () => {
        const fake = createFakeApp();
        const service = createService(fake);
        setupSourcelessRoutes();

        const result = await service.install({
            repo: "https://gitee.com/owner/repo",
            enableAfterInstall: true,
        });

        expect(result.manifest.id).toBe("gitee-demo");
        expect(result.version).toBe("1.2.0");
        expect(result.channel).toBe("raw");
        expect(result.enabled).toBe(true);

        expect(readPluginFile(fake, "gitee-demo", "main.js")).toBe(
            "// main from gitee source"
        );
        // styles.css 在仓库里不存在 —— 它是可选文件，不该让安装失败
        expect(readPluginFile(fake, "gitee-demo", "styles.css")).toBeUndefined();

        const tracked = service.deps.getSettings().installer.tracked;
        expect(tracked).toHaveLength(1);
        expect(tracked[0]).toMatchObject({
            host: "gitee",
            owner: "owner",
            repo: "repo",
            channel: "raw",
        });
    });

    it("release 列表请求带上 direction=desc（Gitee 默认升序，不传会拿到最旧的）", async () => {
        const fake = createFakeApp();
        const service = createService(fake);
        setupSourcelessRoutes();

        await service.install({ repo: "gitee.com/owner/repo" });

        const releaseListCall = calls.find((url) => url.includes("/releases?"));
        expect(releaseListCall).toBeDefined();
        expect(releaseListCall).toContain("direction=desc");
    });

    it("**匿名读文件不走 API raw 端点**（那个端点对匿名请求一律 401）", async () => {
        const fake = createFakeApp();
        const service = createService(fake);
        setupSourcelessRoutes();

        await service.install({ repo: "gitee.com/owner/repo" });

        const apiRawCalls = calls.filter((url) => url.includes("/api/v5/") && url.includes("/raw/"));
        expect(apiRawCalls).toEqual([]);
        // 走的是网页通道
        expect(calls.some((url) => /gitee\.com\/owner\/repo\/raw\/HEAD\//.test(url))).toBe(true);
    });

    it("Gitee 的 html_url 带 .git 后缀也要能正确解析出仓库", async () => {
        // 这条不经过 installer，但锁的是同一个坑：Gitee 的仓库元信息里
        // html_url 是 https://gitee.com/o/r.git，而 GitHub 不带后缀。
        const fake = createFakeApp();
        const service = createService(fake);
        setupSourcelessRoutes();

        const resolved = await service.resolveRepo("https://gitee.com/owner/repo.git");

        expect(resolved.ref).toMatchObject({ host: "gitee", owner: "owner", repo: "repo" });
    });

    it("仓库里没有 manifest.json 时给出「可能不是插件仓库」而不是崩", async () => {
        const fake = createFakeApp();
        const service = createService(fake);

        route(/releases\/latest/, () => ({ status: 404, text: "{}" }));
        route(/releases\?/, () => ({ status: 200, text: "[]" }));
        route(/gitee\.com\/owner\/repo\/raw\/HEAD\/.*/, () => ({
            status: 404,
            text: "not found",
        }));

        // 断言类型码而不是消息文本 —— 文案来自 locale，改文案不该让测试变红。
        await expectInstallerError(
            () => service.install({ repo: "gitee.com/owner/repo" }),
            "missingManifest"
        );
    });
});
