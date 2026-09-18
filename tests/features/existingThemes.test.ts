import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __setRequestUrlHandler } from "../stubs/obsidian";
import { CommunityThemeIndex } from "../../src/features/installer/communityThemes";
import {
    listInstalledThemes,
    resolveThemeBindCandidates,
} from "../../src/features/installer/existingThemes";
import { createFakeApp, seedTheme, themeManifestRaw, type FakeApp } from "../helpers/fakeApp";
import { expectInstallerError } from "../helpers/expectInstallerError";

/**
 * 「绑定库里已有的主题」这条链路：扫描已装主题 × 官方社区主题索引 → 来源。
 *
 * 与插件侧的三处不同都在这里钉住：
 * - **身份是目录名**（主题没有 id 字段）；
 * - **匹配靠名字**（索引里没有 id、没有 version），且要两级兜底 ——
 *   手动安装的主题常被改成自己认得的目录名；
 * - **没有 manifest 也算一个主题**（Obsidian 会照常加载它，版本按 0.0.0）。
 */

const THEMES_INDEX = JSON.stringify([
    { name: "Minimal", author: "kepano", repo: "kepano/obsidian-minimal", screenshot: "x" },
    { name: "Blue Topaz", author: "whyt-byte", repo: "whyt-byte/Blue-Topaz_Obsidian-css" },
    // 缺 repo 的脏数据必须被跳过，不能让整份索引挂掉
    { name: "Broken Theme" },
]);

let requests: string[] = [];

beforeEach(() => {
    requests = [];
    __setRequestUrlHandler(async (request) => {
        requests.push(request.url);
        if (request.url.endsWith("community-css-themes.json")) {
            return { status: 200, text: THEMES_INDEX };
        }
        throw new Error(`no route for ${request.url}`);
    });
});

afterEach(() => {
    __setRequestUrlHandler(undefined);
});

describe("CommunityThemeIndex", () => {
    it("解析条目并跳过缺 repo 的脏数据", async () => {
        const index = new CommunityThemeIndex();

        await index.load();

        expect(index.size).toBe(2);
        expect(index.byName("Blue Topaz")?.repo).toBe("whyt-byte/Blue-Topaz_Obsidian-css");
    });

    it("按名字查询**大小写不敏感**（主题名的写法没有统一约定）", async () => {
        const index = new CommunityThemeIndex();
        await index.load();

        expect(index.byName("minimal")?.repo).toBe("kepano/obsidian-minimal");
        expect(index.byName("BLUE TOPAZ")?.repo).toBe("whyt-byte/Blue-Topaz_Obsidian-css");
        expect(index.byName("  Minimal  ")?.repo).toBe("kepano/obsidian-minimal");
        expect(index.byName("No Such Theme")).toBeUndefined();
        expect(index.byName("   ")).toBeUndefined();
    });

    it("索引拿不到时抛错（不能给用户一个空的「未识别」结论）", async () => {
        __setRequestUrlHandler(async () => ({ status: 404, text: "not found" }));

        await expectInstallerError(
            () => new CommunityThemeIndex().load(),
            "communityIndexFailed"
        );
    });

    it("并发 load 只发一轮请求（与插件索引共用同一套缓存骨架）", async () => {
        const index = new CommunityThemeIndex();

        await Promise.all([index.load(), index.load(), index.load()]);

        expect(requests).toHaveLength(1);
    });
});

describe("listInstalledThemes", () => {
    it("读出目录名、manifest 名与版本", async () => {
        const fake = createFakeApp({
            ...seedTheme("Minimal", {
                "manifest.json": themeManifestRaw("Minimal", "9.1.0"),
                "theme.css": "/* x */",
            }),
            ...seedTheme("Blue Topaz", {
                "manifest.json": themeManifestRaw("Blue Topaz", "2.2.4"),
                "theme.css": "/* x */",
            }),
        });

        const themes = await listInstalledThemes(fake.app);

        expect(themes.map((theme) => [theme.id, theme.name, theme.version])).toEqual([
            ["Blue Topaz", "Blue Topaz", "2.2.4"],
            ["Minimal", "Minimal", "9.1.0"],
        ]);
    });

    it("**没有 manifest 也算一个主题**：名字回落目录名，版本留空表示未知", async () => {
        // Obsidian 自己会照常加载这种目录（版本按 0.0.0）——
        // 跳过它等于用户没法把这一个纳入跟踪。
        const fake = createFakeApp(seedTheme("Bare Theme", { "theme.css": "/* css */" }));

        const themes = await listInstalledThemes(fake.app);

        expect(themes).toEqual([
            { id: "Bare Theme", name: "Bare Theme", version: "", manifest: undefined },
        ]);
    });

    it("点开头的目录不是主题，跳过", async () => {
        const fake = createFakeApp({
            ...seedTheme(".git", { "config": "x" }),
            ...seedTheme("Minimal", { "manifest.json": themeManifestRaw("Minimal", "1.0.0") }),
        });

        const themes = await listInstalledThemes(fake.app);

        expect(themes.map((theme) => theme.id)).toEqual(["Minimal"]);
    });

    it("路径不安全的目录名跳过（绑定它等于给移除埋一颗路径逃逸的雷）", async () => {
        const fake = createFakeApp({
            // 结尾空格：Windows 会静默去掉，Linux 不会 —— 只在一边成立的名字
            ...seedTheme("trailing ", { "theme.css": "/* x */" }),
            ...seedTheme("Minimal", { "manifest.json": themeManifestRaw("Minimal", "1.0.0") }),
        });

        const themes = await listInstalledThemes(fake.app);

        expect(themes.map((theme) => theme.id)).toEqual(["Minimal"]);
    });

    it("大小写不同视为同一个主题，只保留一个", async () => {
        const fake = createFakeApp({
            ...seedTheme("Minimal", { "manifest.json": themeManifestRaw("Minimal", "9.1.0") }),
            ...seedTheme("minimal", { "manifest.json": themeManifestRaw("Minimal", "1.0.0") }),
        });

        const themes = await listInstalledThemes(fake.app);

        expect(themes).toHaveLength(1);
    });

    it("主题目录不存在时返回空数组（全新库不是错误）", async () => {
        const fake: FakeApp = createFakeApp();

        expect(await listInstalledThemes(fake.app)).toEqual([]);
    });
});

describe("resolveThemeBindCandidates", () => {
    async function resolve(fake: FakeApp) {
        const index = new CommunityThemeIndex();
        return resolveThemeBindCandidates(fake.app, index);
    }

    it("按 manifest 的名字对上来源", async () => {
        const fake = createFakeApp(
            seedTheme("Minimal", {
                "manifest.json": themeManifestRaw("Minimal", "9.1.0"),
                "theme.css": "/* x */",
            })
        );

        const { bindable, unresolved } = await resolve(fake);

        expect(unresolved).toEqual([]);
        expect(bindable).toEqual([
            {
                id: "Minimal",
                name: "Minimal",
                version: "9.1.0",
                repo: { host: "github", owner: "kepano", repo: "obsidian-minimal" },
            },
        ]);
    });

    it("manifest 名对不上时**退到目录名**（手动安装常改目录名）", async () => {
        const fake = createFakeApp(
            seedTheme("Minimal", {
                // 作者改过 manifest 里的名字，索引里没有 "Minimal Pro"
                "manifest.json": themeManifestRaw("Minimal Pro", "9.1.0"),
                "theme.css": "/* x */",
            })
        );

        const { bindable } = await resolve(fake);

        expect(bindable[0]?.repo).toEqual({
            host: "github",
            owner: "kepano",
            repo: "obsidian-minimal",
        });
        // 显示名仍用 manifest 里的那个
        expect(bindable[0]?.name).toBe("Minimal Pro");
    });

    it("索引里没有的归入「来源未识别」（两级名字都试过之后）", async () => {
        const fake = createFakeApp({
            ...seedTheme("My Private Theme", {
                "manifest.json": themeManifestRaw("My Private Theme", "1.0.0"),
            }),
            ...seedTheme("Blue Topaz", {
                "manifest.json": themeManifestRaw("Blue Topaz", "2.2.4"),
            }),
        });

        const { bindable, unresolved } = await resolve(fake);

        expect(bindable.map((candidate) => candidate.id)).toEqual(["Blue Topaz"]);
        expect(unresolved.map((theme) => theme.id)).toEqual(["My Private Theme"]);
    });

    it("没有 manifest 的主题按目录名匹配（也算可绑定）", async () => {
        const fake = createFakeApp(seedTheme("Minimal", { "theme.css": "/* x */" }));

        const { bindable, unresolved } = await resolve(fake);

        expect(unresolved).toEqual([]);
        expect(bindable[0]).toMatchObject({ id: "Minimal", version: "" });
    });
});
