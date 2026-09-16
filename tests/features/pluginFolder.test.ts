import { beforeEach, describe, expect, it } from "vitest";
import {
    createBackup,
    disablePlugin,
    enablePlugin,
    isPluginEnabled,
    isPluginInstalled,
    readInstalledManifest,
    reloadPlugin,
    removePluginFolder,
    restoreBackup,
    writePluginFiles,
} from "../../src/features/installer/pluginFolder";
import type { PluginFileName } from "../../src/features/installer/types";
import { createFakeApp, readPluginFile, seedPlugin, type FakeApp } from "../helpers/fakeApp";
import { expectInstallerError } from "../helpers/expectInstallerError";

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

function newFiles(): Map<PluginFileName, string> {
    return new Map<PluginFileName, string>([
        ["manifest.json", MANIFEST],
        ["main.js", "// new main"],
        ["styles.css", "/* new styles */"],
    ]);
}

let fake: FakeApp;

beforeEach(() => {
    fake = createFakeApp();
});

describe("isPluginInstalled / readInstalledManifest", () => {
    it("未安装时返回 false / undefined", async () => {
        expect(await isPluginInstalled(fake.app, "demo")).toBe(false);
        expect(await readInstalledManifest(fake.app, "demo")).toBeUndefined();
    });

    it("已安装时读回 manifest", async () => {
        fake = createFakeApp(seedPlugin("demo", { "manifest.json": OLD_MANIFEST }));

        expect(await isPluginInstalled(fake.app, "demo")).toBe(true);
        expect((await readInstalledManifest(fake.app, "demo"))?.version).toBe("1.0.0");
    });

    it("manifest 损坏时返回 undefined 而不是抛错", async () => {
        fake = createFakeApp(seedPlugin("demo", { "manifest.json": "{broken" }));

        expect(await readInstalledManifest(fake.app, "demo")).toBeUndefined();
    });
});

describe("writePluginFiles", () => {
    it("全新安装写入全部文件", async () => {
        const backup = await createBackup(fake.app, "demo");
        await writePluginFiles(fake.app, "demo", newFiles(), backup);

        expect(readPluginFile(fake, "demo", "manifest.json")).toBe(MANIFEST);
        expect(readPluginFile(fake, "demo", "main.js")).toBe("// new main");
        expect(readPluginFile(fake, "demo", "styles.css")).toBe("/* new styles */");
    });

    it("缺少必需文件时直接抛错，不写任何东西", async () => {
        const backup = await createBackup(fake.app, "demo");
        const files = new Map<PluginFileName, string>([["manifest.json", MANIFEST]]);

        await expectInstallerError(
            () => writePluginFiles(fake.app, "demo", files, backup),
            "folderMissingRequired"
        );
        expect(fake.writes).toEqual([]);
        expect(readPluginFile(fake, "demo", "manifest.json")).toBeUndefined();
    });

    it("没有 styles.css 也能装（它是可选的）", async () => {
        const backup = await createBackup(fake.app, "demo");
        const files = new Map<PluginFileName, string>([
            ["manifest.json", MANIFEST],
            ["main.js", "// main"],
        ]);

        await writePluginFiles(fake.app, "demo", files, backup);
        expect(readPluginFile(fake, "demo", "main.js")).toBe("// main");
    });
});

describe("目录名 ≠ manifest id（手动解压/别的安装器造成的错位）", () => {
    /** 目录叫 MDRazor，manifest id 是 md-razor —— 实测本机就有这种插件。 */
    const RAZOR_MANIFEST = JSON.stringify({
        id: "md-razor",
        name: "MDRazor",
        version: "1.0.0",
        minAppVersion: "1.5.0",
    });

    it("按 id 读写到真实目录，不新建同名 id 的第二份安装", async () => {
        fake = createFakeApp(
            seedPlugin("MDRazor", {
                "manifest.json": RAZOR_MANIFEST,
                "main.js": "// old razor main",
            })
        );

        // 身份用 id 就能找到目录名不同的那份安装
        expect(await isPluginInstalled(fake.app, "md-razor")).toBe(true);
        expect((await readInstalledManifest(fake.app, "md-razor"))?.name).toBe("MDRazor");

        const backup = await createBackup(fake.app, "md-razor");
        const files = new Map<PluginFileName, string>([
            ["manifest.json", RAZOR_MANIFEST],
            ["main.js", "// new razor main"],
        ]);
        await writePluginFiles(fake.app, "md-razor", files, backup);

        // 写进了 MDRazor/，且没有多出 md-razor/ 目录
        expect(readPluginFile(fake, "MDRazor", "main.js")).toBe("// new razor main");
        expect(fake.folders.has(".obsidian/plugins/md-razor")).toBe(false);
    });

    it("删除按 id 删掉真实目录", async () => {
        fake = createFakeApp(
            seedPlugin("MDRazor", { "manifest.json": RAZOR_MANIFEST, "main.js": "// x" })
        );

        await removePluginFolder(fake.app, "md-razor");

        expect(readPluginFile(fake, "MDRazor", "manifest.json")).toBeUndefined();
    });

    it("全新安装（目录还不存在）落在 plugins/{id}", async () => {
        const backup = await createBackup(fake.app, "brand-new");
        const files = new Map<PluginFileName, string>([
            ["manifest.json", RAZOR_MANIFEST],
            ["main.js", "// fresh"],
        ]);

        await writePluginFiles(fake.app, "brand-new", files, backup);

        expect(readPluginFile(fake, "brand-new", "main.js")).toBe("// fresh");
    });
});

describe("失败回滚（参考项目 BRAT 没有这个能力）", () => {
    it("更新已有插件写到一半失败时，还原到安装前的内容", async () => {
        fake = createFakeApp(
            seedPlugin("demo", {
                "manifest.json": OLD_MANIFEST,
                "main.js": "// old main",
                "styles.css": "/* old styles */",
            })
        );

        const backup = await createBackup(fake.app, "demo");
        // 让最后一个文件写入失败 —— 此时前两个已经被覆盖了。
        // 用一次性故障：真实场景里是瞬时 IO 错误，回滚本身应该能成功。
        fake.failWriteOnceOn = (path) => path.endsWith("styles.css");

        await expectInstallerError(
            () => writePluginFiles(fake.app, "demo", newFiles(), backup),
            "writeFailedRolledBack"
        );

        // 三个文件都必须回到旧内容，不能留下「新 manifest + 旧 main.js」这种混合态。
        expect(readPluginFile(fake, "demo", "manifest.json")).toBe(OLD_MANIFEST);
        expect(readPluginFile(fake, "demo", "main.js")).toBe("// old main");
        expect(readPluginFile(fake, "demo", "styles.css")).toBe("/* old styles */");
    });

    it("全新安装失败时把整个插件目录删掉", async () => {
        const backup = await createBackup(fake.app, "demo");
        fake.failWriteOnceOn = (path) => path.endsWith("main.js");

        await expect(
            writePluginFiles(fake.app, "demo", newFiles(), backup)
        ).rejects.toThrow();

        // 不能留下一个只有 manifest.json 的半成品目录 ——
        // Obsidian 会把它当成一个可加载但会崩的插件。
        expect(await isPluginInstalled(fake.app, "demo")).toBe(false);
        expect(fake.folders.has(".obsidian/plugins/demo")).toBe(false);
    });

    it("原本不存在的可选文件，回滚后也不该存在", async () => {
        fake = createFakeApp(
            seedPlugin("demo", { "manifest.json": OLD_MANIFEST, "main.js": "// old" })
        );

        const backup = await createBackup(fake.app, "demo");
        fake.failWriteOnceOn = (path) => path.endsWith("styles.css");

        await expect(writePluginFiles(fake.app, "demo", newFiles(), backup)).rejects.toThrow();

        // 安装前没有 styles.css，回滚后它必须被删掉。
        expect(readPluginFile(fake, "demo", "styles.css")).toBeUndefined();
    });

    it("回滚本身也失败时，明确告诉用户需要手动处理", async () => {
        // 这是最坏情况：写盘失败 + 还原也失败，插件目录处于未知状态。
        // 此时**不能**假装"已还原"，必须把真相说出来。
        fake = createFakeApp(
            seedPlugin("demo", { "manifest.json": OLD_MANIFEST, "main.js": "// old main" })
        );

        const backup = await createBackup(fake.app, "demo");
        fake.failWriteOn = () => true;

        await expectInstallerError(
            () => writePluginFiles(fake.app, "demo", newFiles(), backup),
            "writeFailedRollbackFailed"
        );
    });
});

describe("restoreBackup", () => {
    it("可以独立调用（回滚也失败后的兜底路径）", async () => {
        fake = createFakeApp(seedPlugin("demo", { "manifest.json": OLD_MANIFEST }));
        const backup = await createBackup(fake.app, "demo");

        await writePluginFiles(fake.app, "demo", newFiles(), backup);
        expect((await readInstalledManifest(fake.app, "demo"))?.version).toBe("2.0.0");

        await restoreBackup(fake.app, backup);
        expect((await readInstalledManifest(fake.app, "demo"))?.version).toBe("1.0.0");
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

describe("removePluginFolder", () => {
    it("递归删掉整个插件目录", async () => {
        fake = createFakeApp(
            seedPlugin("demo", { "manifest.json": MANIFEST, "main.js": "// main" })
        );
        fake.files.set(".obsidian/plugins/demo/extra/asset.bin", "x");

        await removePluginFolder(fake.app, "demo");

        expect(readPluginFile(fake, "demo", "manifest.json")).toBeUndefined();
        expect(fake.files.has(".obsidian/plugins/demo/extra/asset.bin")).toBe(false);
    });

    it("目录不存在时不报错", async () => {
        await expect(removePluginFolder(fake.app, "nothing")).resolves.toBeUndefined();
    });
});
