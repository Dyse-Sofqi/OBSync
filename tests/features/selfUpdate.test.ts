import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __setApiVersion, __setRequestUrlHandler } from "../stubs/obsidian";
import { Notifier } from "../../src/core/notice";
import { SecretStore } from "../../src/core/secretStore";
import { normalizeSettings, type ObsyncSettings } from "../../src/core/settings";
import { zhCN } from "../../src/core/i18n/locales/zh-cn";
import { en } from "../../src/core/i18n/locales/en";
import {
    InstallerService,
    type InstallerHost,
} from "../../src/features/installer/installerService";
import {
    clearPendingRestart,
    describeSelfState,
    readPendingRestart,
    resolveSelfRepo,
    SELF_REPO,
} from "../../src/features/installer/selfUpdate";
import {
    createFakeApp,
    readPluginFile,
    seedPlugin,
    type FakeApp,
} from "../helpers/fakeApp";
import { expectInstallerError } from "../helpers/expectInstallerError";

/**
 * OBSync 更新自己这条链路。
 *
 * 要守的东西按重要性排：
 *
 * 1. **不重载自己**。别的插件更新完 disable → enable；对自己是先卸载正在执行
 *    这段代码的实例 —— 能成也是靠副作用成功，失败就停在「已禁用」。所以这里
 *    只写文件 + 记「待重启」。这条如果被谁改回 reload，本文件会红。
 * 2. **不把自己记进跟踪列表**（那张表是「用户装了什么」）。
 * 3. 两道守卫：远端 id 必须是 `obsync`（常量写错时会覆盖别的插件）、不允许降级。
 * 4. 「待重启」标记与写盘同生共死：写失败回滚了就不能留下标记。
 */

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

function createService(fake: FakeApp): {
    service: InstallerService;
    settings: ObsyncSettings;
} {
    const settings = normalizeSettings({});
    const notifier = new Notifier({ getShowNotices: () => true, getT: () => zhCN });
    const host: InstallerHost = {
        app: fake.app,
        notifier,
        secretStore: new SecretStore(fake.app),
        getSettings: () => settings,
        getT: () => zhCN,
        saveSettings: async () => {},
    };
    return { service: new InstallerService(host), settings };
}

const OLD_MANIFEST = JSON.stringify({
    id: "obsync",
    name: "OBSync",
    version: "0.1.0",
    minAppVersion: "1.8.7",
});

function releaseJson(input: { version: string; id?: string; mainJs?: string }): string {
    const id = input.id ?? "obsync";
    const assets = [
        { name: "manifest.json", url: "https://dl.test/manifest.json" },
        { name: "main.js", url: "https://dl.test/main.js" },
    ];

    // manifest 的资产内容要跟着参数走（id 变了是守卫用例）
    route(/^https:\/\/dl\.test\/manifest\.json$/, () => ({
        status: 200,
        text: JSON.stringify({
            id,
            name: "OBSync",
            version: input.version,
            minAppVersion: "1.8.7",
        }),
    }));
    route(/^https:\/\/dl\.test\/main\.js$/, () => ({
        status: 200,
        text: input.mainJs ?? `// main ${input.version}`,
    }));
    // styles.css 不在资产里，raw 也 404 —— 可选文件应被静默跳过
    route(/raw\.githubusercontent\.com\/Dyse-Sofqi\/OBSync\/[^/]+\/styles\.css$/, () => ({
        status: 404,
        text: "not found",
    }));

    return JSON.stringify({
        id: 1,
        tag_name: input.version,
        name: input.version,
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

/** 装好「OBSync 自己发了新版本」的一组路由。 */
function setupSelfRelease(input: { version: string; id?: string; mainJs?: string }): void {
    const body = releaseJson(input);
    route(/releases\/latest$/, () => ({ status: 200, text: body }));
    route(new RegExp(`releases\\/tags\\/${input.version.replace(/\./g, "\\.")}$`), () => ({
        status: 200,
        text: body,
    }));
}

function installedObsync(): Record<string, string> {
    return seedPlugin("obsync", {
        "manifest.json": OLD_MANIFEST,
        "main.js": "// old main",
    });
}

describe("updateSelf（更新自己）", () => {
    it("写入新文件、记下待重启，且**不重载、不记入跟踪列表**", async () => {
        const fake = createFakeApp(installedObsync());
        const { service, settings } = createService(fake);
        await fake.plugins.enablePluginAndSave("obsync"); // 运行中
        setupSelfRelease({ version: "0.2.0" });

        const result = await service.updateSelf("0.1.0");

        expect(result).toEqual({ version: "0.2.0", replaced: true });
        expect(readPluginFile(fake, "obsync", "main.js")).toBe("// main 0.2.0");

        // 磁盘上已是新版本，运行中的还是旧的 —— 标记是这段时间的唯一凭据
        expect(settings.installer.pendingRestartVersion).toBe("0.2.0");

        // **没有**被禁用/重载（`reloadPlugin` 会先 disable 再 enable）
        expect(fake.plugins.enabledPlugins.has("obsync")).toBe(true);

        // 不把自己塞进跟踪列表
        expect(settings.installer.tracked).toEqual([]);
    });

    it("来源取设置里的地址 —— 填了 Gitee 镜像就从 Gitee 拉，不碰官方仓库", async () => {
        const fake = createFakeApp(installedObsync());
        const { service, settings } = createService(fake);
        settings.installer.selfUpdateSource = "https://gitee.com/sofqi/OBSync";
        setupSelfRelease({ version: "0.2.0" });

        await service.updateSelf("0.1.0");

        expect(calls.some((url) => url.includes("gitee.com/api/v5/repos/sofqi/OBSync"))).toBe(true);
        // 关键：**没有**任何请求打到官方仓库 —— 否则「我指定了来源」就是句空话
        expect(
            calls.some((url) => url.includes("api.github.com/repos/Dyse-Sofqi/OBSync"))
        ).toBe(false);
    });

    it("**可以重装同一个版本**（把一个坏掉的安装修回来是合理需求）", async () => {
        const fake = createFakeApp(installedObsync());
        const { service, settings } = createService(fake);
        setupSelfRelease({ version: "0.1.0", mainJs: "// same version, rebuilt" });

        await service.updateSelf("0.1.0");

        expect(readPluginFile(fake, "obsync", "main.js")).toBe("// same version, rebuilt");
        expect(settings.installer.pendingRestartVersion).toBe("0.1.0");
    });

    it("**远端 id 不是 obsync 就中止**（常量写错时不能覆盖别的插件）", async () => {
        const fake = createFakeApp(installedObsync());
        const { service, settings } = createService(fake);
        setupSelfRelease({ version: "0.2.0", id: "some-other-plugin" });

        await expectInstallerError(() => service.updateSelf("0.1.0"), "selfIdMismatch");

        expect(fake.writes).toEqual([]);
        expect(readPluginFile(fake, "obsync", "main.js")).toBe("// old main");
        expect(settings.installer.pendingRestartVersion).toBe("");
    });

    it("**不允许降级**（远端比当前旧时中止）", async () => {
        const fake = createFakeApp(installedObsync());
        const { service, settings } = createService(fake);
        setupSelfRelease({ version: "0.1.0" });

        await expectInstallerError(
            () => service.updateSelf("0.3.0"),
            "selfUpdateDowngrade"
        );

        expect(fake.writes).toEqual([]);
        expect(settings.installer.pendingRestartVersion).toBe("");
    });

    it("写盘失败时回滚，且**不留待重启标记**", async () => {
        const fake = createFakeApp(installedObsync());
        const { service, settings } = createService(fake);
        setupSelfRelease({ version: "0.2.0" });
        fake.failWriteOnceOn = (path) => path.endsWith("main.js");

        await expectInstallerError(() => service.updateSelf("0.1.0"), "writeFailedRolledBack");

        expect(readPluginFile(fake, "obsync", "main.js")).toBe("// old main");
        // 标记与写盘同生共死：标记在而磁盘是旧的，就成了假话
        expect(settings.installer.pendingRestartVersion).toBe("");
    });
});

describe("待重启标记", () => {
    it("记下之后读得回来，清掉返回 true", () => {
        const settings = normalizeSettings({});

        expect(readPendingRestart(settings)).toBe("");
        settings.installer.pendingRestartVersion = "0.2.0";
        expect(readPendingRestart(settings)).toBe("0.2.0");

        expect(clearPendingRestart(settings)).toBe(true);
        expect(readPendingRestart(settings)).toBe("");
    });

    it("没有标记时清它什么也不做（返回 false，调用方据此不做多余的保存）", () => {
        const settings = normalizeSettings({});

        expect(clearPendingRestart(settings)).toBe(false);
    });

    it("非字符串的脏值在加载时被纠正为空串", () => {
        const settings = normalizeSettings({
            installer: { pendingRestartVersion: { version: "0.2.0" } },
        });

        expect(settings.installer.pendingRestartVersion).toBe("");
    });
});

describe("describeSelfState（设置页那一行状态）", () => {
    const base = { currentVersion: "0.1.0", pendingRestartVersion: "" };

    it("没查过时显示当前版本", () => {
        expect(describeSelfState(base, zhCN)).toBe(zhCN.installer.selfNotChecked("0.1.0"));
    });

    it("检查中 / 下载中让位给进度提示", () => {
        expect(describeSelfState({ ...base, busy: "checking" }, zhCN)).toBe(
            zhCN.installer.checking
        );
        expect(describeSelfState({ ...base, busy: "updating" }, zhCN)).toBe(
            zhCN.installer.selfUpdating
        );
    });

    it("有新版本 / 已是最新", () => {
        expect(
            describeSelfState(
                { ...base, check: { currentVersion: "0.1.0", latestVersion: "0.2.0", hasUpdate: true } },
                zhCN
            )
        ).toBe(zhCN.installer.selfUpdateAvailable("0.1.0", "0.2.0"));

        expect(
            describeSelfState(
                { ...base, check: { currentVersion: "0.1.0", latestVersion: "0.1.0", hasUpdate: false } },
                zhCN
            )
        ).toBe(zhCN.installer.selfUpToDate("0.1.0"));
    });

    it("失败时把原因写出来", () => {
        expect(
            describeSelfState(
                {
                    ...base,
                    check: {
                        currentVersion: "0.1.0",
                        latestVersion: "0.1.0",
                        hasUpdate: false,
                        error: "网络不可达",
                    },
                },
                zhCN
            )
        ).toBe(zhCN.installer.selfCheckFailed("网络不可达"));
    });

    it("**「待重启」压在检查结果之上** —— 它讲的是现在跑的不是最新那份", () => {
        const text = describeSelfState(
            {
                currentVersion: "0.1.0",
                pendingRestartVersion: "0.2.0",
                check: { currentVersion: "0.1.0", latestVersion: "0.3.0", hasUpdate: true },
            },
            zhCN
        );

        expect(text).toBe(zhCN.installer.selfPendingRestart("0.2.0"));
        expect(text).toContain("重启");
    });

    it("英文侧也有对应文案（这条链路存在的理由）", () => {
        const text = describeSelfState({ ...base, pendingRestartVersion: "0.2.0" }, en);

        expect(text).toBe(en.installer.selfPendingRestart("0.2.0"));
        expect(text).not.toMatch(/[\u4e00-\u9fff]/);
    });
});

/**
 * 「自身更新来源」的解析。
 *
 * 存在的理由：`github.com` 在本机会被时段性阻断，而 Gitee 镜像能直连。用户填一次就该
 * 一直用它 —— 所以这是个**纯函数**，不需要探测，也不受「自动发现 Gitee 镜像」开关影响
 * （那套是给用户装的插件用的：自动探测、只提议、要确认）。
 */
describe("resolveSelfRepo（自身更新来源）", () => {
    it("留空 / 全空白 → 官方仓库", () => {
        expect(resolveSelfRepo("")).toEqual(SELF_REPO);
        expect(resolveSelfRepo("   ")).toEqual(SELF_REPO);
    });

    it("Gitee 完整地址 → host 是 gitee（**不是** GitHub 上的同名仓库）", () => {
        expect(resolveSelfRepo("https://gitee.com/sofqi/OBSync")).toEqual({
            host: "gitee",
            owner: "sofqi",
            repo: "OBSync",
        });
    });

    it("简写按 GitHub 解释 —— 要 Gitee 就写全地址", () => {
        expect(resolveSelfRepo("sofqi/OBSync")).toEqual({
            host: "github",
            owner: "sofqi",
            repo: "OBSync",
        });
    });

    it("地址非法时**抛错**，不静默回退到官方", () => {
        // 静默回退会让用户以为在走镜像、实际走官方（或反过来）——
        // 而「到底从哪更新」必须是他能确定的。错误由调用方按错误路径报出来。
        expect(() => resolveSelfRepo("这不是一个仓库地址")).toThrow();
    });
});
