import { beforeEach, describe, expect, it } from "vitest";
import {
    getActiveTheme,
    readThemeManifestInFolder,
    requestThemeReload,
    resolveThemeFolder,
} from "../../src/features/installer/themeFolder";
import { createFakeApp, seedTheme, themeManifestRaw, type FakeApp } from "../helpers/fakeApp";

/**
 * 主题目录的定位，以及「当前主题」那一侧的非公开 API 守卫。
 *
 * 公开的 `obsidian.d.ts` 里 `customCss` 出现 **0 次** —— 这几个入口随时可能改名
 * 或消失，所以本文件的重点是**降级行为**：
 *
 * - 读不到当前主题时必须返回 `undefined`，而不是装作「默认主题」——
 *   把两者混为一谈，会让「移除正在使用的主题前先切回去」这道保护静默失效；
 * - 重载失败绝不能抛错：文件已经写好了，刷新观感只是锦上添花。
 */

let fake: FakeApp;

/** 直接摸到替身内部，用来模拟「某个入口在这个版本里不存在」。 */
function customCssOf(app: FakeApp["app"]): Record<string, unknown> {
    return (app as unknown as { customCss: Record<string, unknown> }).customCss;
}

beforeEach(() => {
    fake = createFakeApp();
});

describe("resolveThemeFolder", () => {
    it("目录名就是身份，直接命中", async () => {
        fake = createFakeApp(seedTheme("Minimal", { "theme.css": "/* x */" }));

        expect(await resolveThemeFolder(fake.app, "Minimal")).toBe(".obsidian/themes/Minimal");
    });

    it("大小写不同也认（macOS / Windows 的文件系统本就不区分大小写）", async () => {
        // 记录里是 Minimal、磁盘上是 minimal —— 只按记录拼路径会在 Linux 上
        // 找不到它，于是「更新」出一个第二份目录。
        fake = createFakeApp(seedTheme("minimal", { "theme.css": "/* x */" }));

        expect(await resolveThemeFolder(fake.app, "Minimal")).toBe(".obsidian/themes/minimal");
    });

    it("主题目录还不存在时回落到默认落点", async () => {
        expect(await resolveThemeFolder(fake.app, "Blue Topaz")).toBe(
            ".obsidian/themes/Blue Topaz"
        );
    });
});

describe("getActiveTheme", () => {
    it("从 customCss.getTheme() 读（首选入口）", () => {
        customCssOf(fake.app).theme = "Minimal";

        expect(getActiveTheme(fake.app)).toBe("Minimal");
    });

    it("没有 getTheme 时退到 customCss.theme 属性", () => {
        const css = customCssOf(fake.app);
        delete css.getTheme;
        css.theme = "Blue Topaz";

        expect(getActiveTheme(fake.app)).toBe("Blue Topaz");
    });

    it("整个 customCss 都没有时，退到 vault 配置里的 cssTheme", () => {
        delete (fake.app as unknown as { customCss?: unknown }).customCss;
        (fake.app.vault as unknown as { getConfig?: unknown }).getConfig = () => "AnuPpuccin";

        expect(getActiveTheme(fake.app)).toBe("AnuPpuccin");
    });

    it("**全都读不到时返回 undefined**，不是空串（空串表示「用的就是默认主题」）", () => {
        delete (fake.app as unknown as { customCss?: unknown }).customCss;

        expect(getActiveTheme(fake.app)).toBeUndefined();
    });

    it("用的是默认主题时返回空串（与 undefined 是两件事）", () => {
        expect(getActiveTheme(fake.app)).toBe("");
        // 空串 = 用户在用默认主题；undefined = 我们读不到。混为一谈会让
        // 「移除正在使用的主题前先切回去」那道保护静默失效。
        expect(getActiveTheme(fake.app)).not.toBeUndefined();
    });

    it("某个入口抛错时不向外炸（守卫要能撑住内部实现的变化）", () => {
        customCssOf(fake.app).getTheme = () => {
            throw new Error("internal API changed");
        };

        expect(getActiveTheme(fake.app)).toBeUndefined();
    });
});

describe("requestThemeReload", () => {
    it("调用一次 requestLoadTheme", () => {
        requestThemeReload(fake.app);

        expect(fake.customCss.reloadRequests).toBe(1);
    });

    it("**API 不可用时静默**（写入本身是成功的，不该因此报成失败）", () => {
        delete (fake.app as unknown as { customCss?: unknown }).customCss;

        expect(() => requestThemeReload(fake.app)).not.toThrow();
    });

    it("API 抛错也被吞掉（观感刷新不值得打断更新流程）", () => {
        customCssOf(fake.app).requestLoadTheme = () => {
            throw new Error("boom");
        };

        expect(() => requestThemeReload(fake.app)).not.toThrow();
    });
});

describe("主题 manifest 的读取（readThemeManifestInFolder 的间接覆盖）", () => {
    it("没有 manifest 的目录不是错误，解析路径照常返回", async () => {
        fake = createFakeApp(seedTheme("Bare", { "theme.css": "/* css */" }));

        expect(await resolveThemeFolder(fake.app, "Bare")).toBe(".obsidian/themes/Bare");
    });

    it("manifest 里有 version 时能被读到（供 existingThemes 使用）", async () => {
        fake = createFakeApp(
            seedTheme("Minimal", { "manifest.json": themeManifestRaw("Minimal", "9.1.0") })
        );

        const manifest = await readThemeManifestInFolder(fake.app, ".obsidian/themes/Minimal");

        expect(manifest?.version).toBe("9.1.0");
    });
});
