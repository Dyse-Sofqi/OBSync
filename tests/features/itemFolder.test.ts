import { beforeEach, describe, expect, it } from "vitest";
import { isValidThemeName } from "../../src/core/themeName";
import {
    createBackup,
    removeItemFolder,
    restoreBackup,
    writeItemFiles,
} from "../../src/features/installer/itemFolder";
import { resolvePluginFolder } from "../../src/features/installer/pluginFolder";
import { resolveThemeFolder } from "../../src/features/installer/themeFolder";
import {
    createFakeApp,
    readPluginFile,
    readThemeFile,
    seedPlugin,
    seedTheme,
    themeManifestRaw,
    type FakeApp,
} from "../helpers/fakeApp";
import { expectInstallerError } from "../helpers/expectInstallerError";

/**
 * 目录读写的**通用那一层**：备份、写盘、失败回滚、递归删除。
 *
 * 参考项目 BRAT 没有回滚：它只做前置校验，`try/catch` 里直接返回 false，
 * 不备份不还原。这在「全新安装」时没问题，但在「更新已有插件」时，
 * 一旦写了一半失败，用户手上就只剩一个坏掉的插件 —— 而它可能正在被使用。
 *
 * 插件与主题共用这条路径（只有文件集不同），所以同一个文件里两种都要测：
 * 主题最容易漏的正是「必需文件里没有 main.js 而有 theme.css」。
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

const THEME_MANIFEST = themeManifestRaw("Minimal", "9.1.0");

function newPluginFiles(): Map<string, string> {
    return new Map<string, string>([
        ["manifest.json", MANIFEST],
        ["main.js", "// new main"],
        ["styles.css", "/* new styles */"],
    ]);
}

function newThemeFiles(): Map<string, string> {
    return new Map<string, string>([
        ["manifest.json", THEME_MANIFEST],
        ["theme.css", "/* new theme */"],
    ]);
}

let fake: FakeApp;

beforeEach(() => {
    fake = createFakeApp();
});

describe("writeItemFiles（插件）", () => {
    it("全新安装写入全部文件", async () => {
        const folder = await resolvePluginFolder(fake.app, "demo");
        const backup = await createBackup(fake.app, "plugin", "demo", folder);
        await writeItemFiles(fake.app, newPluginFiles(), backup);

        expect(readPluginFile(fake, "demo", "manifest.json")).toBe(MANIFEST);
        expect(readPluginFile(fake, "demo", "main.js")).toBe("// new main");
        expect(readPluginFile(fake, "demo", "styles.css")).toBe("/* new styles */");
    });

    it("缺少必需文件时直接抛错，不写任何东西（并带上 kind）", async () => {
        const folder = await resolvePluginFolder(fake.app, "demo");
        const backup = await createBackup(fake.app, "plugin", "demo", folder);
        const files = new Map<string, string>([["manifest.json", MANIFEST]]);

        await expectInstallerError(
            () => writeItemFiles(fake.app, files, backup),
            "folderMissingRequired"
        );
        expect(fake.writes).toEqual([]);
        expect(readPluginFile(fake, "demo", "manifest.json")).toBeUndefined();
    });

    it("没有 styles.css 也能装（它是可选的）", async () => {
        const folder = await resolvePluginFolder(fake.app, "demo");
        const backup = await createBackup(fake.app, "plugin", "demo", folder);
        const files = new Map<string, string>([
            ["manifest.json", MANIFEST],
            ["main.js", "// main"],
        ]);

        await writeItemFiles(fake.app, files, backup);
        expect(readPluginFile(fake, "demo", "main.js")).toBe("// main");
    });

    it("写入的是**已解析**的真实目录（目录名 ≠ id 时不另建一份）", async () => {
        const RAZOR = JSON.stringify({
            id: "md-razor",
            name: "MDRazor",
            version: "1.0.0",
            minAppVersion: "1.5.0",
        });
        fake = createFakeApp(
            seedPlugin("MDRazor", { "manifest.json": RAZOR, "main.js": "// old razor main" })
        );

        const folder = await resolvePluginFolder(fake.app, "md-razor");
        const backup = await createBackup(fake.app, "plugin", "md-razor", folder);
        await writeItemFiles(
            fake.app,
            new Map<string, string>([
                ["manifest.json", RAZOR],
                ["main.js", "// new razor main"],
            ]),
            backup
        );

        expect(readPluginFile(fake, "MDRazor", "main.js")).toBe("// new razor main");
        expect(fake.folders.has(".obsidian/plugins/md-razor")).toBe(false);
    });
});

describe("writeItemFiles（主题）", () => {
    it("写的是 manifest.json + theme.css，**不要求 main.js**", async () => {
        const folder = await resolveThemeFolder(fake.app, "Minimal");
        const backup = await createBackup(fake.app, "theme", "Minimal", folder);
        await writeItemFiles(fake.app, newThemeFiles(), backup);

        expect(readThemeFile(fake, "Minimal", "theme.css")).toBe("/* new theme */");
        expect(readThemeFile(fake, "Minimal", "manifest.json")).toBe(THEME_MANIFEST);
        expect(readThemeFile(fake, "Minimal", "main.js")).toBeUndefined();
    });

    it("有 theme.css 但缺 manifest.json 时不写任何东西", async () => {
        const folder = await resolveThemeFolder(fake.app, "Minimal");
        const backup = await createBackup(fake.app, "theme", "Minimal", folder);

        await expectInstallerError(
            () =>
                writeItemFiles(
                    fake.app,
                    new Map<string, string>([["theme.css", "/* only css */"]]),
                    backup
                ),
            "folderMissingRequired"
        );
        expect(readThemeFile(fake, "Minimal", "theme.css")).toBeUndefined();
    });

    it("主题目录名带空格 / 大写也原样写（身份就是目录名）", async () => {
        const folder = await resolveThemeFolder(fake.app, "Blue Topaz");
        const backup = await createBackup(fake.app, "theme", "Blue Topaz", folder);
        await writeItemFiles(fake.app, newThemeFiles(), backup);

        expect(readThemeFile(fake, "Blue Topaz", "theme.css")).toBe("/* new theme */");
    });
});

describe("更新失败时的回滚", () => {
    it("写到一半失败时，三个文件都还原到更新前的内容", async () => {
        fake = createFakeApp(
            seedPlugin("demo", {
                "manifest.json": OLD_MANIFEST,
                "main.js": "// old main",
                "styles.css": "/* old styles */",
            })
        );

        const folder = await resolvePluginFolder(fake.app, "demo");
        const backup = await createBackup(fake.app, "plugin", "demo", folder);
        // 让最后一个文件写入失败 —— 此时前两个已经被覆盖了。
        // 用一次性故障：真实场景里是瞬时 IO 错误，回滚本身应该能成功。
        fake.failWriteOnceOn = (path) => path.endsWith("styles.css");

        await expectInstallerError(
            () => writeItemFiles(fake.app, newPluginFiles(), backup),
            "writeFailedRolledBack"
        );

        // 三个文件都必须回到旧内容，不能留下「新 manifest + 旧 main.js」这种混合态。
        expect(readPluginFile(fake, "demo", "manifest.json")).toBe(OLD_MANIFEST);
        expect(readPluginFile(fake, "demo", "main.js")).toBe("// old main");
        expect(readPluginFile(fake, "demo", "styles.css")).toBe("/* old styles */");
    });

    it("主题更新写到一半失败时同样整体还原", async () => {
        fake = createFakeApp(
            seedTheme("Minimal", {
                "manifest.json": themeManifestRaw("Minimal", "8.0.0"),
                "theme.css": "/* old theme */",
            })
        );

        const folder = await resolveThemeFolder(fake.app, "Minimal");
        const backup = await createBackup(fake.app, "theme", "Minimal", folder);
        fake.failWriteOnceOn = (path) => path.endsWith("theme.css");

        await expectInstallerError(
            () => writeItemFiles(fake.app, newThemeFiles(), backup),
            "writeFailedRolledBack"
        );

        expect(readThemeFile(fake, "Minimal", "theme.css")).toBe("/* old theme */");
        expect(readThemeFile(fake, "Minimal", "manifest.json")).toBe(
            themeManifestRaw("Minimal", "8.0.0")
        );
    });

    it("全新安装失败时把整个目录删掉（不留半成品）", async () => {
        const folder = await resolvePluginFolder(fake.app, "demo");
        const backup = await createBackup(fake.app, "plugin", "demo", folder);
        fake.failWriteOnceOn = (path) => path.endsWith("main.js");

        await expect(writeItemFiles(fake.app, newPluginFiles(), backup)).rejects.toThrow();

        // 不能留下一个只有 manifest.json 的半成品目录 ——
        // Obsidian 会把它当成一个可加载但会崩的插件。
        expect(readPluginFile(fake, "demo", "manifest.json")).toBeUndefined();
        expect(fake.folders.has(".obsidian/plugins/demo")).toBe(false);
    });

    it("原本不存在的可选文件，回滚后也不该存在", async () => {
        fake = createFakeApp(
            seedPlugin("demo", { "manifest.json": OLD_MANIFEST, "main.js": "// old" })
        );

        const folder = await resolvePluginFolder(fake.app, "demo");
        const backup = await createBackup(fake.app, "plugin", "demo", folder);
        fake.failWriteOnceOn = (path) => path.endsWith("styles.css");

        await expect(writeItemFiles(fake.app, newPluginFiles(), backup)).rejects.toThrow();

        // 安装前没有 styles.css，回滚后它必须被删掉。
        expect(readPluginFile(fake, "demo", "styles.css")).toBeUndefined();
    });

    it("回滚本身也失败时，明确告诉用户需要手动处理", async () => {
        // 这是最坏情况：写盘失败 + 还原也失败，目录处于未知状态。
        // 此时**不能**假装"已还原"，必须把真相说出来。
        fake = createFakeApp(
            seedPlugin("demo", { "manifest.json": OLD_MANIFEST, "main.js": "// old main" })
        );

        const folder = await resolvePluginFolder(fake.app, "demo");
        const backup = await createBackup(fake.app, "plugin", "demo", folder);
        fake.failWriteOn = () => true;

        await expectInstallerError(
            () => writeItemFiles(fake.app, newPluginFiles(), backup),
            "writeFailedRollbackFailed"
        );
    });
});

describe("restoreBackup", () => {
    it("可以独立调用（回滚也失败后的兜底路径）", async () => {
        fake = createFakeApp(seedPlugin("demo", { "manifest.json": OLD_MANIFEST }));
        const folder = await resolvePluginFolder(fake.app, "demo");
        const backup = await createBackup(fake.app, "plugin", "demo", folder);

        await writeItemFiles(fake.app, newPluginFiles(), backup);
        expect(readPluginFile(fake, "demo", "manifest.json")).toBe(MANIFEST);

        await restoreBackup(fake.app, backup);
        expect(readPluginFile(fake, "demo", "manifest.json")).toBe(OLD_MANIFEST);
    });
});

describe("removeItemFolder", () => {
    it("递归删掉整个目录", async () => {
        fake = createFakeApp(
            seedPlugin("demo", { "manifest.json": MANIFEST, "main.js": "// main" })
        );
        fake.files.set(".obsidian/plugins/demo/extra/asset.bin", "x");

        await removeItemFolder(fake.app, await resolvePluginFolder(fake.app, "demo"));

        expect(readPluginFile(fake, "demo", "manifest.json")).toBeUndefined();
        expect(fake.files.has(".obsidian/plugins/demo/extra/asset.bin")).toBe(false);
    });

    it("目录不存在时不报错", async () => {
        await expect(
            removeItemFolder(fake.app, ".obsidian/plugins/nothing")
        ).resolves.toBeUndefined();
    });

    /**
     * 这两条是**后果的证明**：`data.json` 里的 id 一旦越界，删除真的会跑出目录。
     *
     * 拦截点在 `core/settings.ts` 的 sanitize（按 kind 分别校验）与
     * `core/themeName.ts`，不在这一层 —— 这里只拿到一个目录字符串。
     */
    it("插件：id 含 `..` 时解析出的路径会逃出 plugins/，且真的按递归发出删除", async () => {
        expect(await resolvePluginFolder(fake.app, "../..")).toBe(".obsidian/plugins/../..");

        // 假的 adapter 只做字符串前缀匹配、不解析路径（真机上是文件系统解析的），
        // 所以把「解析后的目标」直接标成存在，等价于库根目录确实在那儿。
        fake.folders.add(".obsidian/plugins/../..");

        const removed: Array<{ path: string; recursive: boolean }> = [];
        const originalRmdir = fake.app.vault.adapter.rmdir.bind(fake.app.vault.adapter);
        fake.app.vault.adapter.rmdir = async (path: string, recursive: boolean) => {
            removed.push({ path, recursive });
            return originalRmdir(path, recursive);
        };

        await removeItemFolder(fake.app, await resolvePluginFolder(fake.app, "../.."));

        expect(removed).toEqual([{ path: ".obsidian/plugins/../..", recursive: true }]);
    });

    it("主题：同样的越界 id 会逃出 themes/", async () => {
        expect(await resolveThemeFolder(fake.app, "../../evil")).toBe(
            ".obsidian/themes/../../evil"
        );

        // 但这条 id 根本进不了跟踪列表 —— 判据见 core/themeName.ts：
        // 含路径分隔符、`..`、首尾空白等等一律不合法。
        expect(isValidThemeName("../../evil")).toBe(false);
    });
});
