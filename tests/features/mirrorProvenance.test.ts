import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __setApiVersion, __setRequestUrlHandler } from "../stubs/obsidian";
import { Notifier } from "../../src/core/notice";
import { SecretStore } from "../../src/core/secretStore";
import { normalizeSettings, type ObsyncSettings } from "../../src/core/settings";
import { zhCN } from "../../src/core/i18n/locales/zh-cn";
import {
    InstallerService,
    type InstallerHost,
} from "../../src/features/installer/installerService";
import type { RepoRef } from "../../src/host/types";
import { createFakeApp, type FakeApp } from "../helpers/fakeApp";

/**
 * **源地址**在记录里的存续 —— 自动发现 Gitee 镜像之后，两个地址都要留下。
 *
 * ## 为什么单独立一组
 *
 * 镜像一旦命中，`host/owner/repo` 这三个位置就被镜像占了（下载与更新检查都得走它，
 * 那是镜像的意义所在）。源地址若不在别处另留一份，它会**当场消失**：
 * 用户装完之后看不到插件的家在 GitHub，也看不出 OBSync 到底在跟谁说话 ——
 * 而跟踪列表要把两个地址都摆出来，靠的就是这份记录。
 *
 * ## 三条用例对应三种不同的失效方式
 *
 * 1. **安装时记下**（写入侧）—— 丢了的话列表第二行永远不出现；
 * 2. **更新时继承**（读取侧的细节）—— 更新路径手里**没有**源地址：它传给
 *    `install()` 的 `repo` 就是记录里那个地址（已经是镜像了），而镜像发现不会再跑
 *    （`shouldLookForMirror` 要求 `ref.host === "github"`）。不继承的话，
 *    用户更新一次插件，GitHub 那一行就凭空消失 —— 而他什么都没做；
 * 3. **没走镜像时不编造** —— 编造出来的话列表会画出两行一模一样的地址。
 *
 * 这一组用**真实的 `GitHubHost` / `GiteeHost`** 跑完整安装（只 mock HTTP），
 * 因为出问题的地方正是「编排」：host 层各自都对，缝合处才会丢东西。
 */

const GITHUB_MANIFEST = JSON.stringify({
    id: "demo",
    name: "Demo Plugin",
    version: "2.0.0",
    minAppVersion: "1.0.0",
});

/** 镜像侧的 manifest：`id` 与源一致（不一致会被 `findGiteeMirror` 判掉）。 */
const MIRROR_MANIFEST = JSON.stringify({
    id: "demo",
    name: "Demo Plugin（Gitee 镜像）",
    version: "2.0.0",
    minAppVersion: "1.0.0",
});

const GITHUB: RepoRef = { host: "github", owner: "owner", repo: "demo" };
const GITEE: RepoRef = { host: "gitee", owner: "owner", repo: "demo" };

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
        // 无路由即抛错：这样「不该发出的请求」会让用例当场失败，
        // 而不是静默走到重试退避里（那还会白等 1.6 秒）。
        throw new Error(`no route for ${request.url}`);
    });
});

afterEach(() => {
    __setRequestUrlHandler(undefined);
});

function createService(fake: FakeApp, discoverGiteeMirrors: boolean) {
    const settings: ObsyncSettings = normalizeSettings({});
    settings.installer.discoverGiteeMirrors = discoverGiteeMirrors;
    const host: InstallerHost = {
        app: fake.app,
        notifier: new Notifier({ getShowNotices: () => true, getT: () => zhCN }),
        secretStore: new SecretStore(fake.app),
        getSettings: () => settings,
        getT: () => zhCN,
        saveSettings: async () => undefined,
    };
    return { service: new InstallerService(host), settings };
}

/** 源仓库的两个通道（GitHub raw）。 */
function routeGitHubSource(): void {
    route(/^https:\/\/raw\.githubusercontent\.com\/owner\/demo\/HEAD\/manifest\.json$/, () => ({
        status: 200,
        text: GITHUB_MANIFEST,
    }));
    route(/github\.com\/repos\/owner\/demo\/releases\/latest$/, () => ({
        status: 404,
        text: '{"message":"Not Found"}',
    }));
    route(/github\.com\/repos\/owner\/demo\/releases\?/, () => ({ status: 200, text: "[]" }));
    route(/^https:\/\/raw\.githubusercontent\.com\/owner\/demo\/HEAD\/main\.js$/, () => ({
        status: 200,
        text: "// main from github",
    }));
}

/** 镜像仓库（Gitee）：只有源码、没有 release —— Gitee 上这是常态。 */
function routeGiteeMirror(): void {
    route(/^https:\/\/gitee\.com\/owner\/demo\/raw\/HEAD\/manifest\.json$/, () => ({
        status: 200,
        text: MIRROR_MANIFEST,
    }));
    route(/gitee\.com\/api\/v5\/repos\/owner\/demo\/releases\/latest/, () => ({
        status: 404,
        text: '{"message":"Not Found"}',
    }));
    route(/gitee\.com\/api\/v5\/repos\/owner\/demo\/releases\?/, () => ({
        status: 200,
        text: "[]",
    }));
    route(/^https:\/\/gitee\.com\/owner\/demo\/raw\/HEAD\/main\.js$/, () => ({
        status: 200,
        text: "// main from gitee mirror",
    }));
    route(/^https:\/\/gitee\.com\/owner\/demo\/raw\/HEAD\/styles\.css$/, () => ({
        status: 404,
        text: "not found",
    }));
}

/** 给「另一个仓库」装好全套路由（源仓库那条通道）。 */
function routeGitHubRepo(owner: string, repo: string): void {
    const raw = (file: string) =>
        new RegExp(`^https://raw\\.githubusercontent\\.com/${owner}/${repo}/HEAD/${file}$`);
    route(raw("manifest\\.json"), () => ({ status: 200, text: GITHUB_MANIFEST }));
    route(raw("main\\.js"), () => ({ status: 200, text: "// main" }));
    route(raw("styles\\.css"), () => ({ status: 404, text: "not found" }));
    route(
        new RegExp(`github\\.com/repos/${owner}/${repo}/releases/latest$`),
        () => ({ status: 404, text: '{"message":"Not Found"}' })
    );
    route(new RegExp(`github\\.com/repos/${owner}/${repo}/releases\\?`), () => ({
        status: 200,
        text: "[]",
    }));
}

describe("自动发现 Gitee 镜像之后，两个地址都要留在记录里", () => {
    it("安装：主来源是镜像，源地址另存一份", async () => {
        const fake = createFakeApp();
        const { service, settings } = createService(fake, true);
        routeGitHubSource();
        routeGiteeMirror();

        const result = await service.install({ repo: "owner/demo", enableAfterInstall: true });

        const record = settings.installer.tracked[0]!;
        // 主来源是镜像 —— 下载与更新检查都按它走
        expect({ host: record.host, owner: record.owner, repo: record.repo }).toEqual(GITEE);
        expect(record.channel).toBe("raw");
        // 源地址也在。**这就是列表第二行要显示的东西**
        expect(record.origin).toEqual(GITHUB);
        // 返回结果里两个地址都要带出来：完成提示靠它报「这次是从哪拿的」
        expect(result.repoRef).toEqual(GITEE);
        expect(result.origin).toEqual(GITHUB);

        // 顺带确认文件真的来自镜像，而不只是记了个字段
        expect(calls.some((url) => url.startsWith("https://gitee.com/owner/demo/raw/"))).toBe(
            true
        );
    });

    it("更新：**源地址被继承**，不是每次都要重新发现", async () => {
        const fake = createFakeApp();
        const { service, settings } = createService(fake, true);
        routeGitHubSource();
        routeGiteeMirror();

        await service.install({ repo: "owner/demo" });
        expect(settings.installer.tracked[0]!.origin).toEqual(GITHUB);

        // 走「更新到最新」那条路：传进去的地址就是记录里那个（已经是镜像了），
        // 和 `ui/TrackedItemsList.ts` 的按钮、`updateChecker.updateAll` 完全一致。
        //
        // 这次**不会**再跑镜像发现（要求 `ref.host === "github"`），所以调用方手里
        // 没有源地址 —— 上面那几条 GitHub 路由此时用不上，一旦被请求就会抛
        // 「no route」，等于顺带钉住「不重复探测」。
        calls = [];
        await service.install({ repo: "owner/demo", defaultHost: "gitee" });

        expect(calls.some((url) => url.includes("github"))).toBe(false);
        expect(settings.installer.tracked[0]!.origin).toEqual(GITHUB);
    });

    it("没走镜像时不编造源地址（否则列表会画出两行同一个地址）", async () => {
        const fake = createFakeApp();
        const { service, settings } = createService(fake, false);
        routeGitHubSource();
        route(/^https:\/\/raw\.githubusercontent\.com\/owner\/demo\/HEAD\/styles\.css$/, () => ({
            status: 404,
            text: "not found",
        }));

        await service.install({ repo: "owner/demo" });

        const record = settings.installer.tracked[0]!;
        expect({ host: record.host, owner: record.owner, repo: record.repo }).toEqual(GITHUB);
        expect(record.origin).toBeUndefined();
    });

    it("弹窗已经识别过镜像时（`origin` 由调用方带进来）同样能记下", async () => {
        // 「添加插件仓库」弹窗在「识别」那一步就做过发现，安装时传
        // `allowMirror: false` 避免重复请求 —— 源地址只能由它交出来。
        const fake = createFakeApp();
        const { service, settings } = createService(fake, true);
        routeGiteeMirror();

        await service.install({
            repo: "owner/demo",
            allowMirror: false,
            defaultHost: "gitee",
            origin: GITHUB,
        });

        const record = settings.installer.tracked[0]!;
        expect({ host: record.host, owner: record.owner, repo: record.repo }).toEqual(GITEE);
        expect(record.origin).toEqual(GITHUB);
    });

    it("与主来源相同的 `origin` 不记（无意义的重复）", async () => {
        const fake = createFakeApp();
        const { service, settings } = createService(fake, false);
        routeGitHubSource();
        route(/^https:\/\/raw\.githubusercontent\.com\/owner\/demo\/HEAD\/styles\.css$/, () => ({
            status: 404,
            text: "not found",
        }));

        await service.install({ repo: "owner/demo", origin: GITHUB });

        expect(settings.installer.tracked[0]!.origin).toBeUndefined();
    });

    /**
     * **换了仓库来源之后，旧源地址必须跟着作废。**
     *
     * 身份是 `(kind, id)` —— 所以「同一个插件换个仓库装」会落在同一条记录上
     * （上游 ↔ 自己的 fork 之间切换，这是真会发生的事）。而 `origin` 说的是
     * **上一个仓库**的地址：继承下来的话，列表会显示一个早就不是它来源的地址，
     * 而用户正是来看「这个插件到底跟谁走」的。
     *
     * 与 `frozen` 的继承形成对照：冻结是**这个已安装的东西**的属性，换个仓库装
     * 它仍然成立；而 `origin` 是**关于仓库**的，仓库换了它就不成立了。
     */
    it("换成**另一个**仓库之后，旧源地址不留下来", async () => {
        const fake = createFakeApp();
        const { service, settings } = createService(fake, true);
        routeGitHubSource();
        routeGiteeMirror();

        // 先走镜像装：记录是 { host: gitee, origin: github/owner/demo }
        await service.install({ repo: "owner/demo" });
        expect(settings.installer.tracked[0]!.origin).toEqual(GITHUB);

        // 换成另一个 GitHub 仓库装**同一个插件**（manifest id 都是 demo）。
        // 这个仓库没有镜像，所以这次调用手里没有 origin —— 正好用来验「不会乱继承」。
        routeGitHubRepo("other", "demo");
        route(/^https:\/\/gitee\.com\/other\/demo\/raw\/HEAD\/manifest\.json$/, () => ({
            status: 404,
            text: "not found",
        }));

        await service.install({ repo: "other/demo" });

        const record = settings.installer.tracked[0]!;
        expect(record.owner).toBe("other");
        expect(record.origin).toBeUndefined();
    });
});

describe("resolveRepo 的返回", () => {
    it("命中镜像时同时给出两个地址，`ref` 是实际要用的那个", async () => {
        const fake = createFakeApp();
        const { service } = createService(fake, true);
        routeGitHubSource();
        routeGiteeMirror();

        const resolved = await service.resolveRepo("owner/demo");

        expect(resolved.ref).toEqual(GITEE);
        expect(resolved.origin).toEqual(GITHUB);
    });

    it("没命中镜像时只有 `ref`（来源就是它自己，没有第二个地址）", async () => {
        const fake = createFakeApp();
        const { service } = createService(fake, true);
        routeGitHubSource();

        const resolved = await service.resolveRepo("owner/demo");

        expect(resolved.ref).toEqual(GITHUB);
        expect(resolved.origin).toBeUndefined();
    });
});
