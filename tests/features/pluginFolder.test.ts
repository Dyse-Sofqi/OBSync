import { beforeEach, describe, expect, it } from "vitest";
import {
    disablePlugin,
    enablePlugin,
    isPluginEnabled,
    readInstalledManifest,
    reloadPlugin,
    resolvePluginFolder,
} from "../../src/features/installer/pluginFolder";
import { createFakeApp, seedPlugin, type FakeApp } from "../helpers/fakeApp";

/**
 * 插件目录的**定位**与生命周期（启用 / 禁用 / 重载）。
 *
 * 目录本身的读写（备份、写盘、回滚、删除）在 `itemFolder.test.ts` ——
 * 那部分是插件与主题共用的；这里只测插件独有的两件事：目录名与 id 的错位，
 * 以及 Obsidian 的插件管理 API。
 */

const MANIFEST = JSON.stringify({
    id: "demo",
    name: "Demo",
    version: "2.0.0",
    minAppVersion: "1.5.0",
});

const OLD_MANIFEST = JSON.stringify({
    id: "demo",
    name: "Demo",
    version: "1.0.0",
    minAppVersion: "1.5.0",
});

let fake: FakeApp;

beforeEach(() => {
    fake = createFakeApp();
});

describe("readInstalledManifest", () => {
    it("未安装时返回 undefined", async () => {
        expect(await readInstalledManifest(fake.app, "demo")).toBeUndefined();
    });

    it("已安装时读回 manifest", async () => {
        fake = createFakeApp(seedPlugin("demo", { "manifest.json": OLD_MANIFEST }));

        expect((await readInstalledManifest(fake.app, "demo"))?.version).toBe("1.0.0");
    });

    it("manifest 损坏时返回 undefined 而不是抛错", async () => {
        fake = createFakeApp(seedPlugin("demo", { "manifest.json": "{broken" }));

        expect(await readInstalledManifest(fake.app, "demo")).toBeUndefined();
    });
});

describe("目录名 ≠ manifest id（手动解压 / 别的安装器造成的错位）", () => {
    /** 目录叫 MDRazor，manifest id 是 md-razor —— 实测本机就有这种插件。 */
    const RAZOR_MANIFEST = JSON.stringify({
        id: "md-razor",
        name: "MDRazor",
        version: "1.0.0",
        minAppVersion: "1.5.0",
    });

    it("按 id 能找到目录名不同的那份安装", async () => {
        fake = createFakeApp(
            seedPlugin("MDRazor", {
                "manifest.json": RAZOR_MANIFEST,
                "main.js": "// old razor main",
            })
        );

        expect(await resolvePluginFolder(fake.app, "md-razor")).toBe(".obsidian/plugins/MDRazor");
        expect((await readInstalledManifest(fake.app, "md-razor"))?.name).toBe("MDRazor");
    });

    it("目录名就是 id 时走快路径（不读 manifest 也能定位）", async () => {
        fake = createFakeApp(seedPlugin("demo", { "manifest.json": MANIFEST }));

        expect(await resolvePluginFolder(fake.app, "demo")).toBe(".obsidian/plugins/demo");
    });

    it("全新安装（目录还不存在）回落到 plugins/{id}", async () => {
        expect(await resolvePluginFolder(fake.app, "brand-new")).toBe(
            ".obsidian/plugins/brand-new"
        );
    });
});

describe("插件启用状态", () => {
    it("启用 / 禁用 / 重载", async () => {
        fake = createFakeApp(seedPlugin("demo", { "manifest.json": MANIFEST }));

        expect(isPluginEnabled(fake.app, "demo")).toBe(false);

        await enablePlugin(fake.app, "demo");
        expect(isPluginEnabled(fake.app, "demo")).toBe(true);

        await disablePlugin(fake.app, "demo");
        expect(isPluginEnabled(fake.app, "demo")).toBe(false);
    });

    it("重载未启用的插件不会把它打开", async () => {
        fake = createFakeApp(seedPlugin("demo", { "manifest.json": MANIFEST }));

        await reloadPlugin(fake.app, "demo");

        expect(isPluginEnabled(fake.app, "demo")).toBe(false);
    });

    it("重载已启用的插件后仍是启用状态", async () => {
        fake = createFakeApp(seedPlugin("demo", { "manifest.json": MANIFEST }));
        await enablePlugin(fake.app, "demo");

        await reloadPlugin(fake.app, "demo");

        expect(isPluginEnabled(fake.app, "demo")).toBe(true);
    });
});

/**
 * 路径计算的那一半（**后果**那一半在 `itemFolder.test.ts` 里，
 * 因为真正发出 `rmdir` 的是 `removeItemFolder`）。
 *
 * `data.json` 里的 `tracked[].id` 会一路走到目录解析：找不到匹配目录时
 * `resolvePluginFolder` 回落到 `{configDir}/plugins/{id}`，
 * 紧接着就是一次**递归**删除。`id` 里只要出现 `..`，删的就不再是插件目录。
 *
 * 修法不在这里（`resolvePluginFolder` 只拿到一个 id 字符串，无从判断它从哪来），
 * 而在读取 `data.json` 时按 `manifest.ts` 的同一套规则校验 ——
 * 见 `tests/core/settings.test.ts` 的「tracked 里的 id 内容校验」。
 */
describe("越界的 id 会解析出 plugins/ 之外的路径", () => {
    it("`..` 不被消解，直接拼进返回值", async () => {
        expect(await resolvePluginFolder(fake.app, "../..")).toBe(".obsidian/plugins/../..");
        expect(await resolvePluginFolder(fake.app, "../../evil")).toBe(
            ".obsidian/plugins/../../evil"
        );
    });
});
