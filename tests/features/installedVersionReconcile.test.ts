import { beforeEach, describe, expect, it } from "vitest";
import { resetCreatedSettings } from "../stubs/obsidian";
import { normalizeSettings, type ObsyncSettings } from "../../src/core/settings";
import { zhCN } from "../../src/core/i18n/locales/zh-cn";
import { Notifier } from "../../src/core/notice";
import { SecretStore } from "../../src/core/secretStore";
import {
    InstallerService,
    type InstallerHost,
} from "../../src/features/installer/installerService";
import { UpdateChecker } from "../../src/features/installer/updateChecker";
import { resolvePluginFolderInfo } from "../../src/features/installer/pluginFolder";
import { createFakeApp, seedPlugin, type FakeApp } from "../helpers/fakeApp";

/**
 * 「记录说的」与「磁盘上真的」不一致时会发生什么 —— 全部来自实测。
 *
 * 实测场景（2026-09-19）：`plugins/` 里除了一份正常的 `md-razor/`（2.6.4），
 * 还躺着一份残留备份 `md-razor-backup-2.5.16-…/`（**manifest id 一样**）。
 * Obsidian 按 id 建索引，重启后加载了备份那份 2.5.16；而 OBSync 按 `md-razor/`
 * 记着 2.6.4 —— 于是更新检查拿 2.6.4 去比远端 2.6.4，**永远报「已是最新」**，
 * 用户卡在旧版本上且看不出原因。
 *
 * 三处修法对应三组用例：
 * 1. 目录定位优先听 Obsidian（它加载的那份才算数），并报出重复；
 * 2. 记录里的版本用磁盘校正（自愈），不再让谎话留在 data.json 里；
 * 3. 检查更新前先校正 —— 否则「已是最新」这个结论本身就是错的。
 */

/** 造一份 manifest —— **id 必须与目录要被认成的那一个一致**，否则根本不构成重复。 */
const MANIFEST = (id: string, version: string) =>
    JSON.stringify({ id, name: "Demo", version, minAppVersion: "1.0.0" });

function createService(fake: FakeApp) {
    const settings: ObsyncSettings = normalizeSettings({});
    const notifier = new Notifier({ getShowNotices: () => false, getT: () => zhCN });
    const host: InstallerHost = {
        app: fake.app,
        notifier,
        secretStore: new SecretStore(fake.app),
        getSettings: () => settings,
        getT: () => zhCN,
        saveSettings: async () => undefined,
    };
    return { service: new InstallerService(host), settings };
}

/** 造一个「两份目录抢同一个 id」的库：正常目录 + 残留备份。 */
function vaultWithDuplicate(): FakeApp {
    return createFakeApp({
        ...seedPlugin("md-razor", { "manifest.json": MANIFEST("md-razor", "2.6.4") }),
        ...seedPlugin("md-razor-backup-2.5.16-20260915", {
            "manifest.json": MANIFEST("md-razor", "2.5.16"),
        }),
    });
}

/** 让 Obsidian 认为「实际加载的是备份那一份」（实测就是这个状态）。 */
function obsidianLoaded(fake: FakeApp, id: string, dir: string): void {
    (fake.app as unknown as { plugins: Record<string, unknown> }).plugins = {
        enabledPlugins: new Set([id]),
        manifests: { [id]: { dir } },
    };
}

beforeEach(() => {
    resetCreatedSettings();
});

describe("目录定位：优先听 Obsidian，并报出重复 id", () => {
    it("**以 Obsidian 实际加载的目录为准** —— 那才是用户真正在跑的代码", async () => {
        const fake = vaultWithDuplicate();
        obsidianLoaded(fake, "md-razor", ".obsidian/plugins/md-razor-backup-2.5.16-20260915");

        const lookup = await resolvePluginFolderInfo(fake.app, "md-razor");

        expect(lookup.folder).toBe(".obsidian/plugins/md-razor-backup-2.5.16-20260915");
        expect(lookup.fromObsidian).toBe(true);
        // 另一份要报出来 —— 这是「显示的和跑的不一致」的病根
        expect(lookup.duplicates).toEqual([".obsidian/plugins/md-razor"]);
    });

    it("Obsidian 说是正常目录时，重复项反过来是那份备份", async () => {
        const fake = vaultWithDuplicate();
        obsidianLoaded(fake, "md-razor", ".obsidian/plugins/md-razor");

        const lookup = await resolvePluginFolderInfo(fake.app, "md-razor");

        expect(lookup.folder).toBe(".obsidian/plugins/md-razor");
        expect(lookup.duplicates).toEqual([
            ".obsidian/plugins/md-razor-backup-2.5.16-20260915",
        ]);
    });

    it("拿不到 Obsidian 的答案时退回「目录名 == id」（老行为，仍然可用）", async () => {
        const fake = vaultWithDuplicate();

        const lookup = await resolvePluginFolderInfo(fake.app, "md-razor");

        expect(lookup.folder).toBe(".obsidian/plugins/md-razor");
        expect(lookup.fromObsidian).toBe(false);
    });

    it("没有重复时不报重复（正常库里不该出现警告）", async () => {
        const fake = createFakeApp(seedPlugin("md-razor", { "manifest.json": MANIFEST("md-razor", "2.6.4") }));

        const lookup = await resolvePluginFolderInfo(fake.app, "md-razor");

        expect(lookup.duplicates).toEqual([]);
    });
});

describe("用磁盘校正记录里的版本（自愈）", () => {
    it("记录 2.6.4、磁盘 2.5.16（Obsidian 加载的是那份）→ 校正为 2.5.16", async () => {
        const fake = vaultWithDuplicate();
        obsidianLoaded(fake, "md-razor", ".obsidian/plugins/md-razor-backup-2.5.16-20260915");
        const { service, settings } = createService(fake);
        settings.installer.tracked = [
            {
                kind: "plugin",
                host: "github",
                owner: "dyse-sofqi",
                repo: "MDRazor",
                id: "md-razor",
                name: "MDRazor",
                installedVersion: "2.6.4", // ← 记录里的谎话
                requestedVersion: "latest",
                frozen: false,
                channel: "release",
                installedAt: 0,
            },
        ];

        const result = await service.reconcileInstalledVersions();

        expect(settings.installer.tracked[0]!.installedVersion).toBe("2.5.16");
        expect(result.corrected).toEqual(["MDRazor"]);
        expect(result.duplicated).toEqual([{ name: "MDRazor", count: 2 }]);
    });

    it("目录被删掉/读不到时记成空版本（于是更新检查会给出「可更新」，而不是卡死）", async () => {
        const fake = createFakeApp();
        const { service, settings } = createService(fake);
        settings.installer.tracked = [
            {
                kind: "plugin",
                host: "github",
                owner: "owner",
                repo: "demo",
                id: "demo",
                name: "Demo",
                installedVersion: "2.6.4",
                requestedVersion: "latest",
                frozen: false,
                installedAt: 0,
            },
        ];

        await service.reconcileInstalledVersions();

        expect(settings.installer.tracked[0]!.installedVersion).toBe("");
    });

    it("一致时不动记录（不制造无谓的写盘与提示）", async () => {
        const fake = createFakeApp(seedPlugin("demo", { "manifest.json": MANIFEST("demo", "2.6.4") }));
        const { service, settings } = createService(fake);
        settings.installer.tracked = [
            {
                kind: "plugin",
                host: "github",
                owner: "owner",
                repo: "demo",
                id: "demo",
                name: "Demo",
                installedVersion: "2.6.4",
                requestedVersion: "latest",
                frozen: false,
                installedAt: 0,
            },
        ];

        const result = await service.reconcileInstalledVersions();

        expect(result.corrected).toEqual([]);
        expect(settings.installer.tracked[0]!.installedVersion).toBe("2.6.4");
    });
});

describe("检查更新：拿磁盘上的版本去比，而不是记录里那个", () => {
    it("记录说 2.6.4（已是最新），磁盘是 2.5.16 → **必须报有更新**", async () => {
        const fake = vaultWithDuplicate();
        obsidianLoaded(fake, "md-razor", ".obsidian/plugins/md-razor-backup-2.5.16-20260915");
        const { service, settings } = createService(fake);
        settings.installer.tracked = [
            {
                kind: "plugin",
                host: "github",
                owner: "dyse-sofqi",
                repo: "MDRazor",
                id: "md-razor",
                name: "MDRazor",
                installedVersion: "2.6.4",
                requestedVersion: "latest",
                frozen: false,
                installedAt: 0,
            },
        ];
        const checker = new UpdateChecker(service);
        // 远端最新 = 2.6.4（与记录相同 —— 旧逻辑因此报「已是最新」）
        (checker as unknown as { latestReleaseTag: () => Promise<string> }).latestReleaseTag =
            async () => "2.6.4";
        (checker as unknown as { latestPluginTag: () => Promise<string> }).latestPluginTag =
            async () => "2.6.4";
        (service as unknown as { recordUpdateChecks: () => Promise<void> }).recordUpdateChecks =
            async () => undefined;

        const result = await checker.checkOne(settings.installer.tracked[0]!);

        expect(settings.installer.tracked[0]!.installedVersion).toBe("2.5.16");
        expect(result.hasUpdate).toBe(true);
        expect(result.latestVersion).toBe("2.6.4");
    });
});

/**
 * 「更新完还报可更新」的死循环 —— 实测踩过，两条路都要堵死。
 *
 * 现场：主题 Ethereal 记录里 `installedVersion` 被抹成了空串（旧代码用**插件**的
 * 解析器去读主题 manifest，读不出 `id` 就抛错，于是当成"没装"），而远端最新是 1.4.2。
 * `isNewerVersion("1.4.2", "")` 两边有一边解析不了 → 退化成「字符串不同即视为有更新」
 * → **永远报可更新**；点更新装完，目录里那个 manifest 仍然读不到版本 → 更完还报。
 */
/**
 * 用户报的那个死循环的**完整因果链**（实测）：
 *
 * 1. 记录里的 `installedVersion` 被抹成空串（旧代码用插件的解析器读主题 manifest）；
 * 2. 更新检查拿 `""` 去比远端 `1.4.2` —— `isNewerVersion` 两边有一边解析不了，
 *    退化成「字符串不同即视为有更新」→ **永远报可更新**；
 * 3. 点更新装完写回 1.4.2，可设置页一开又走一遍 ①，于是循环。
 *
 * 所以修的是 ①：读得出来就写对，读不出来就别动。这条用例从「记录是空的」开始，
 * 一路走到「检查结论是没有更新」——把整条链钉死。
 */
describe("空版本记录的完整因果链：对账 → 检查", () => {
    it("记录为空、磁盘上是 1.4.2 → 对账补回 1.4.2，检查报「无更新」", async () => {
        const fake = createFakeApp();
        fake.files.set(
            ".obsidian/themes/Ethereal/manifest.json",
            JSON.stringify({ name: "Ethereal", version: "1.4.2", minAppVersion: "1.0.0" })
        );
        fake.folders.add(".obsidian/themes/Ethereal");
        const { service, settings } = createService(fake);
        const record = {
            kind: "theme" as const,
            host: "github" as const,
            owner: "dyse-sofqi",
            repo: "Ethereal",
            id: "Ethereal",
            name: "Ethereal",
            installedVersion: "", // ← 被抹掉的那一种
            frozen: false,
            installedAt: 0,
        };
        settings.installer.tracked = [record];
        const checker = new UpdateChecker(service);
        (checker as unknown as { latestReleaseTag: () => Promise<string> }).latestReleaseTag =
            async () => "1.4.2";
        (service as unknown as { recordUpdateChecks: () => Promise<void> }).recordUpdateChecks =
            async () => undefined;

        // 检查前会先对账（checkOne 内部）—— 这正是用户点「检查更新」时走的路径
        const result = await checker.checkOne(settings.installer.tracked[0]!);

        expect(settings.installer.tracked[0]!.installedVersion).toBe("1.4.2");
        expect(result.hasUpdate).toBe(false);
    });
});

describe("reconcile 不碰读不出来的东西", () => {
    /** 一个「目录在、manifest 读不出主题版本」的主题（主题 manifest 没有 id）。 */
    const themeWithManifest = (manifest: string) => {
        const fake = createFakeApp();
        fake.files.set(".obsidian/themes/Ethereal/manifest.json", manifest);
        fake.folders.add(".obsidian/themes/Ethereal");
        return fake;
    };

    it("**主题用主题的解析器**：能读出 1.4.2（旧代码用插件解析器，把记录抹成了空）", async () => {
        const fake = themeWithManifest(
            JSON.stringify({ name: "Ethereal", version: "1.4.2", minAppVersion: "1.0.0" })
        );
        const { service, settings } = createService(fake);
        settings.installer.tracked = [
            {
                kind: "theme",
                host: "github",
                owner: "dyse-sofqi",
                repo: "Ethereal",
                id: "Ethereal",
                name: "Ethereal",
                installedVersion: "",
                frozen: false,
                installedAt: 0,
            },
        ];

        await service.reconcileInstalledVersions();

        expect(settings.installer.tracked[0]!.installedVersion).toBe("1.4.2");
    });

    it("读不出来（manifest 不合法）时**保持记录不动**，不抹成空", async () => {
        const fake = themeWithManifest("{ 这不是 JSON");
        const { service, settings } = createService(fake);
        settings.installer.tracked = [
            {
                kind: "theme",
                host: "github",
                owner: "dyse-sofqi",
                repo: "Ethereal",
                id: "Ethereal",
                name: "Ethereal",
                installedVersion: "1.4.2",
                frozen: false,
                installedAt: 0,
            },
        ];

        await service.reconcileInstalledVersions();

        expect(settings.installer.tracked[0]!.installedVersion).toBe("1.4.2");
    });

    it("目录真的不存在时才记成「未安装」（空版本 → 会给出可更新）", async () => {
        const fake = createFakeApp();
        const { service, settings } = createService(fake);
        settings.installer.tracked = [
            {
                kind: "theme",
                host: "github",
                owner: "dyse-sofqi",
                repo: "Ethereal",
                id: "Ethereal",
                name: "Ethereal",
                installedVersion: "1.4.2",
                frozen: false,
                installedAt: 0,
            },
        ];

        await service.reconcileInstalledVersions();

        expect(settings.installer.tracked[0]!.installedVersion).toBe("");
    });
});
