import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __setRequestUrlHandler } from "../stubs/obsidian";
import { Notifier } from "../../src/core/notice";
import { SecretStore } from "../../src/core/secretStore";
import { normalizeSettings, type ObsyncSettings } from "../../src/core/settings";
import { zhCN } from "../../src/core/i18n/locales/zh-cn";
import { CommunityPluginIndex } from "../../src/features/installer/communityPlugins";
import {
    listInstalledPlugins,
    resolveBindCandidates,
} from "../../src/features/installer/existingPlugins";
import { InstallerService } from "../../src/features/installer/installerService";
import { createFakeApp, seedPlugin, type FakeApp } from "../helpers/fakeApp";

/**
 * 绑定已有插件：扫描（以磁盘为准）→ 社区索引反查来源 → 加入跟踪列表。
 */

const DEMO_MANIFEST = JSON.stringify({
    id: "demo",
    name: "Demo Plugin",
    version: "1.2.3",
    minAppVersion: "1.5.0",
});

const INDEX_JSON = JSON.stringify([
    { id: "demo", name: "Demo", author: "alice", description: "", repo: "alice/demo-repo" },
    { id: "other", name: "Other", author: "bob", description: "", repo: "bob/other-repo" },
]);

beforeEach(() => {
    __setRequestUrlHandler(async (request) => {
        if (request.url.endsWith("community-plugins.json")) {
            return { status: 200, text: INDEX_JSON };
        }
        // 统计文件 404 不影响扫描
        return { status: 404, text: "not found" };
    });
});

afterEach(() => {
    __setRequestUrlHandler(undefined);
});

function makeService(fake: FakeApp) {
    let saves = 0;
    const settings: ObsyncSettings = normalizeSettings({});
    const service = new InstallerService({
        app: fake.app,
        notifier: new Notifier({ getShowNotices: () => true, getT: () => zhCN }),
        secretStore: new SecretStore(fake.app),
        getSettings: () => settings,
        getT: () => zhCN,
        saveSettings: async () => {
            saves += 1;
        },
    });
    return { service, settings, getSaves: () => saves };
}

describe("listInstalledPlugins", () => {
    it("以磁盘为准扫描：合法 manifest 收录，损坏/缺失的跳过", async () => {
        const fake = createFakeApp({
            ...seedPlugin("demo", { "manifest.json": DEMO_MANIFEST, "main.js": "// x" }),
            ...seedPlugin("broken", { "manifest.json": "{not json" }),
            ...seedPlugin("empty-dir", { "main.js": "// no manifest" }),
        });
        await fake.plugins.enablePluginAndSave("demo");

        const installed = await listInstalledPlugins(fake.app);

        expect(installed).toHaveLength(1);
        expect(installed[0]!.id).toBe("demo");
        expect(installed[0]!.manifest.version).toBe("1.2.3");
        expect(installed[0]!.enabled).toBe(true);
    });

    it("库里没有任何插件时返回空数组", async () => {
        const fake = createFakeApp();
        await expect(listInstalledPlugins(fake.app)).resolves.toEqual([]);
    });
});

describe("resolveBindCandidates", () => {
    it("官方索引里的插件可绑定，索引外的进未识别组", async () => {
        const fake = createFakeApp({
            ...seedPlugin("demo", { "manifest.json": DEMO_MANIFEST }),
            ...seedPlugin("offline-plugin", {
                "manifest.json": JSON.stringify({
                    id: "offline-plugin",
                    name: "Offline",
                    version: "0.1.0",
                    minAppVersion: "1.5.0",
                }),
            }),
        });
        const index = new CommunityPluginIndex();

        const { bindable, unresolved } = await resolveBindCandidates(fake.app, index);

        expect(bindable).toEqual([
            {
                id: "demo",
                name: "Demo Plugin",
                version: "1.2.3",
                repo: { host: "github", owner: "alice", repo: "demo-repo" },
            },
        ]);
        expect(unresolved.map((plugin) => plugin.id)).toEqual(["offline-plugin"]);
    });

    it("目录名 ≠ manifest id 时按 id 查索引（实测本机 5 个插件如此）", async () => {
        // 回归用例：早先用目录名查索引，「明明上了官方市场」的插件被误判成未识别。
        const fake = createFakeApp({
            ...seedPlugin("MDRazor", {
                "manifest.json": JSON.stringify({
                    id: "md-razor",
                    name: "MDRazor",
                    version: "0.1.0",
                    minAppVersion: "1.5.0",
                }),
            }),
        });
        __setRequestUrlHandler(async (request) => {
            if (request.url.endsWith("community-plugins.json")) {
                return {
                    status: 200,
                    text: JSON.stringify([
                        { id: "md-razor", name: "MDRazor", author: "", description: "", repo: "dyse-sofqi/MDRazor" },
                    ]),
                };
            }
            return { status: 404, text: "not found" };
        });
        const index = new CommunityPluginIndex();

        const { bindable, unresolved } = await resolveBindCandidates(fake.app, index);

        expect(unresolved).toHaveLength(0);
        expect(bindable).toEqual([
            {
                id: "md-razor",
                name: "MDRazor",
                version: "0.1.0",
                repo: { host: "github", owner: "dyse-sofqi", repo: "MDRazor" },
            },
        ]);
    });

    it("同一 manifest id 出现在多个目录时只保留一个，且排除 OBSync 自身", async () => {
        const fake = createFakeApp({
            // 旧 id 的重复安装（实测有这种：obsidian-regex-replace/ 与 regex-replace/）
            ...seedPlugin("obsidian-regex-replace", {
                "manifest.json": JSON.stringify({
                    id: "regex-replace",
                    name: "Regex Find/Replace",
                    version: "1.0.0",
                    minAppVersion: "1.5.0",
                }),
            }),
            ...seedPlugin("regex-replace", {
                "manifest.json": JSON.stringify({
                    id: "regex-replace",
                    name: "Regex Find/Replace",
                    version: "2.0.0",
                    minAppVersion: "1.5.0",
                }),
            }),
            ...seedPlugin("ob-sync", {
                "manifest.json": JSON.stringify({
                    id: "ob-sync",
                    name: "OBSync",
                    version: "0.1.0",
                    minAppVersion: "1.5.0",
                }),
            }),
        });

        const installed = await listInstalledPlugins(fake.app);

        expect(installed.map((plugin) => plugin.id)).toEqual(["regex-replace"]);
    });
});

describe("InstallerService.bindExisting", () => {
    it("写入跟踪列表并保存；已跟踪的跳过", async () => {
        const fake = createFakeApp(
            seedPlugin("demo", { "manifest.json": DEMO_MANIFEST })
        );
        const { service, settings, getSaves } = makeService(fake);

        const added = await service.bindExisting([
            {
                id: "demo",
                name: "Demo Plugin",
                version: "1.2.3",
                repo: { host: "github", owner: "alice", repo: "demo-repo" },
            },
            {
                id: "second",
                name: "Second",
                version: "2.0.0",
                repo: { host: "github", owner: "bob", repo: "second" },
            },
        ]);

        expect(added).toBe(2);
        expect(getSaves()).toBe(1);
        expect(settings.installer.tracked).toHaveLength(2);

        const record = settings.installer.tracked[0]!;
        expect(record).toMatchObject({
            host: "github",
            owner: "alice",
            repo: "demo-repo",
            id: "demo",
            name: "Demo Plugin",
            installedVersion: "1.2.3",
            requestedVersion: "latest",
            frozen: false,
            channel: "release",
        });

        // 重复绑定：全部跳过，不落盘
        const again = await service.bindExisting([
            {
                id: "demo",
                name: "Demo Plugin",
                version: "1.2.3",
                repo: { host: "github", owner: "alice", repo: "demo-repo" },
            },
        ]);
        expect(again).toBe(0);
        expect(getSaves()).toBe(1);
        expect(settings.installer.tracked).toHaveLength(2);
    });

    it("没有新增时不写设置", async () => {
        const fake = createFakeApp();
        const { service, getSaves } = makeService(fake);

        const added = await service.bindExisting([]);

        expect(added).toBe(0);
        expect(getSaves()).toBe(0);
    });
});
