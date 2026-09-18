import { describe, expect, it } from "vitest";
import { NetworkError, NotFoundError } from "../../src/host/errors";
import type { IRepoHost } from "../../src/host/IRepoHost";
import type { Release, RepoRef } from "../../src/host/types";
import {
    fetchFiles,
    PLUGIN_SPEC,
    THEME_SPEC,
    type FetchSpec,
} from "../../src/features/installer/installFiles";
import { expectInstallerError } from "../helpers/expectInstallerError";
import { themeManifestRaw } from "../helpers/fakeApp";
import type { InstallSource } from "../../src/features/installer/types";

/**
 * 取文件的**通道选择与回退**（插件与主题同一条链路）。
 *
 * ## 为什么这个文件值得单独测
 *
 * 这段逻辑此前只被一个 live 测试碰过（要联网、要真实仓库），
 * 而它承载的是两条**只有在本机网络下才显得关键**的行为：
 *
 * - 资产通道（`releases/download/...` → `objects.githubusercontent.com`）在国内
 *   经常不可达，所以要逐文件回退到源码通道；
 * - 资产通道整体不通时要**记住**，否则每个文件各等一次超时（白等三次）。
 *
 * 用假 host 直接测，既快又不需要网络，而且能把「哪个文件试了哪条通道」记清楚 ——
 * 这类「试了没试」的性质靠读代码很难确认。
 *
 * ## 为什么主题也在这个文件里
 *
 * 两者用的是同一个 `fetchFiles`，只有文件集与 manifest 解析器不同 ——
 * 分两个文件会让「回退逻辑对主题是不是也成立」这种问题没人回答：
 * 主题的必需文件里有 `theme.css` 而没有 `main.js`，正是最容易漏配的地方。
 */

const REF: RepoRef = { host: "github", owner: "owner", repo: "demo" };

const PLUGIN_MANIFEST = JSON.stringify({
    id: "demo",
    name: "Demo",
    version: "1.0.0",
    minAppVersion: "1.8.7",
});

const THEME_MANIFEST = themeManifestRaw("Demo Theme", "3.1.0");

/** 资产下载的行为。`absent` 表示 release 里根本没有这个资产。 */
type AssetOutcome = "ok" | "network" | "not-found" | "absent";

interface Scenario {
    /** false 模拟「这个 tag 取不到 release」。 */
    hasRelease?: boolean;
    assets?: Record<string, AssetOutcome>;
    /** 源码通道能提供哪些文件（缺失即读不到）。 */
    source?: Record<string, string>;
    /** 源码通道对某些文件**抛错**（模拟网络失败，而非「文件不存在」）。 */
    sourceError?: Record<string, boolean>;
    /** 资产通道返回的内容（按文件名）。默认按插件三件套给。 */
    content?: (name: string) => string;
}

function pluginAssetContent(name: string): string {
    if (name === "manifest.json") return PLUGIN_MANIFEST;
    if (name === "main.js") return "// from asset";
    return "/* from asset */";
}

function themeAssetContent(name: string): string {
    if (name === "manifest.json") return THEME_MANIFEST;
    return "/* theme from asset */";
}

function createHost(scenario: Scenario, content = pluginAssetContent) {
    /** 记录**尝试**下载的资产名（无论成败）—— 「有没有试过」是本文件的重点。 */
    const downloads: string[] = [];
    const reads: string[] = [];

    const release: Release = {
        tag: "1.0.0",
        name: "1.0.0",
        prerelease: false,
        publishedAt: "2026-01-01T00:00:00Z",
        assets: Object.entries(scenario.assets ?? {})
            .filter(([, outcome]) => outcome !== "absent")
            .map(([name]) => ({
                name,
                size: 1,
                downloadUrl: `https://example.invalid/${name}`,
            })),
    };

    const host = {
        getReleaseByTag: async () => (scenario.hasRelease === false ? undefined : release),

        downloadAsset: async (_ref: RepoRef, asset: { name: string }) => {
            downloads.push(asset.name);
            const outcome = scenario.assets?.[asset.name] ?? "ok";
            if (outcome === "network") throw new NetworkError("asset CDN unreachable");
            if (outcome === "not-found") throw new NotFoundError("asset gone");
            return new TextEncoder().encode(content(asset.name)).buffer;
        },

        readFile: async (_ref: RepoRef, path: string) => {
            reads.push(path);
            if (scenario.sourceError?.[path]) {
                throw new NetworkError(`readFile failed for ${path}`);
            }
            return scenario.source?.[path];
        },
    } as unknown as IRepoHost;

    return { host, downloads, reads };
}

/** 统一补上 token 参数（这些用例都不涉及令牌）。 */
function load<M, N extends string>(
    host: IRepoHost,
    source: InstallSource,
    spec: FetchSpec<N, M>
) {
    return fetchFiles(host, REF, source, undefined, spec);
}

const RELEASE_SOURCE: InstallSource = { kind: "release", tag: "1.0.0", ref: "1.0.0" };
const RAW_SOURCE: InstallSource = { kind: "raw", ref: "HEAD" };

describe("fetchFiles（插件）的通道选择", () => {
    it("资产齐全时走 release 通道", async () => {
        const { host, downloads } = createHost({
            assets: { "manifest.json": "ok", "main.js": "ok", "styles.css": "ok" },
        });

        const result = await load(host, RELEASE_SOURCE, PLUGIN_SPEC);

        expect(result.channel).toBe("release");
        expect(result.files.get("main.js")).toBe("// from asset");
        expect(downloads).toEqual(["manifest.json", "main.js", "styles.css"]);
    });

    it("**资产通道网络不可达时，后续文件不再试它**（否则白等三次超时）", async () => {
        const { host, downloads, reads } = createHost({
            assets: { "manifest.json": "network", "main.js": "ok", "styles.css": "ok" },
            source: { "manifest.json": PLUGIN_MANIFEST, "main.js": "// from source" },
        });

        const result = await load(host, RELEASE_SOURCE, PLUGIN_SPEC);

        // 只试了第一个 —— 记住「这条通道不通」正是这段逻辑存在的理由
        expect(downloads).toEqual(["manifest.json"]);
        // 三个文件都改走源码通道
        expect(reads).toEqual(["manifest.json", "main.js", "styles.css"]);
        expect(result.files.get("main.js")).toBe("// from source");
    });

    it("**资产 404 不算通道不可用** —— 后续文件仍应走资产通道", async () => {
        // 这条锁的是一个曾经写错的地方：把「某个资产 404」也当成
        // 「资产通道整体不可用」。后果很实际 —— `main.js` 通常被 gitignore，
        // 源码通道取不到它，于是一次本可成功的安装变成失败。
        const { host, downloads } = createHost({
            assets: { "manifest.json": "not-found", "main.js": "ok", "styles.css": "ok" },
            source: { "manifest.json": PLUGIN_MANIFEST },
        });

        const result = await load(host, RELEASE_SOURCE, PLUGIN_SPEC);

        // manifest.json 那一次失败不该影响后面的文件
        expect(downloads).toEqual(["manifest.json", "main.js", "styles.css"]);
        expect(result.files.get("main.js")).toBe("// from asset");
        expect(result.files.get("styles.css")).toBe("/* from asset */");
    });

    it("release 里没有某个资产时，该文件回退源码（不算通道失败）", async () => {
        const { host, downloads } = createHost({
            assets: { "main.js": "ok" }, // manifest.json 没被发布成资产
            source: { "manifest.json": PLUGIN_MANIFEST },
        });

        const result = await load(host, RELEASE_SOURCE, PLUGIN_SPEC);

        expect(downloads).toEqual(["main.js"]); // manifest 没资产，不会去下载
        expect(result.files.get("manifest.json")).toBe(PLUGIN_MANIFEST);
        expect(result.channel).toBe("release");
    });

    it("逐文件回退到源码后，channel 仍报 release（来源规格就是 release）", async () => {
        const { host } = createHost({
            assets: { "manifest.json": "ok", "main.js": "network" },
            source: { "main.js": "// from source" },
        });

        const result = await load(host, RELEASE_SOURCE, PLUGIN_SPEC);

        expect(result.files.get("main.js")).toBe("// from source");
        expect(result.channel).toBe("release");
    });

    it("tag 取不到 release 时整条通道切到 raw", async () => {
        const { host, downloads } = createHost({
            hasRelease: false,
            source: { "manifest.json": PLUGIN_MANIFEST, "main.js": "// from source" },
        });

        const result = await load(host, RELEASE_SOURCE, PLUGIN_SPEC);

        expect(downloads).toEqual([]);
        expect(result.channel).toBe("raw");
    });
});

describe("fetchFiles（插件）的必需/可选文件", () => {
    it("**styles.css 取不到不影响安装**（可选文件，连网络错误也吞掉）", async () => {
        const { host } = createHost({
            assets: { "manifest.json": "ok", "main.js": "ok", "styles.css": "network" },
        });

        const result = await load(host, RELEASE_SOURCE, PLUGIN_SPEC);

        expect(result.files.has("styles.css")).toBe(false);
        expect(result.manifest.id).toBe("demo");
    });

    it("缺 manifest.json 报 missingManifest（多半不是插件仓库）", async () => {
        const { host } = createHost({ assets: { "main.js": "ok" } });

        await expectInstallerError(() => load(host, RAW_SOURCE, PLUGIN_SPEC), "missingManifest");
    });

    it("有 manifest 但缺 main.js 报 missingRequiredFiles（作者没提交构建产物）", async () => {
        const { host } = createHost({
            assets: { "manifest.json": "ok" },
            source: { "manifest.json": PLUGIN_MANIFEST },
        });

        await expectInstallerError(
            () => load(host, RELEASE_SOURCE, PLUGIN_SPEC),
            "missingRequiredFiles"
        );
    });

    it("必需文件在两条通道上**都读不到**时，报「缺文件」而不是网络错误", async () => {
        // 「读不到」和「读失败」是两回事：前者是文件不存在（可能是仓库不对），
        // 后者是网络问题（该重试）。这条锁的是前者。
        const { host } = createHost({
            assets: { "manifest.json": "not-found", "main.js": "not-found" },
        });

        await expectInstallerError(
            () => load(host, RELEASE_SOURCE, PLUGIN_SPEC),
            "missingManifest"
        );
    });

    it("必需文件遇到**网络错误**时原样抛出，不被当成「文件不存在」吞掉", async () => {
        // 吞掉的话用户会看到「这多半不是插件仓库」—— 而实际只是网络不通，
        // 重试就能成功。指错方向的提示比没有提示更糟。
        const { host } = createHost({ sourceError: { "manifest.json": true } });

        await expect(load(host, RAW_SOURCE, PLUGIN_SPEC)).rejects.toBeInstanceOf(NetworkError);
    });
});

/**
 * 主题走的是同一个 `fetchFiles`，差别只在文件集与 manifest 解析器。
 *
 * 这几条要守的性质：**主题不会去找 `main.js`**（它没有那个文件，找了就会
 * 以「缺必需文件」失败），而它的必需文件是 `theme.css`。
 */
describe("fetchFiles（主题）的文件集", () => {
    const themeHost = (scenario: Scenario) => createHost(scenario, themeAssetContent);

    it("只取 manifest.json 与 theme.css —— 不会去要 main.js", async () => {
        const { host, downloads, reads } = themeHost({
            assets: { "manifest.json": "ok", "theme.css": "ok" },
        });

        // 资产通道：两个文件都在 release 里
        const result = await load(host, RELEASE_SOURCE, THEME_SPEC);

        // 只取了这两个文件 —— 找 main.js 会让主题永远以「缺必需文件」失败
        expect([...result.files.keys()]).toEqual(["manifest.json", "theme.css"]);
        expect(result.files.get("theme.css")).toBe("/* theme from asset */");
        expect(downloads).toEqual(["manifest.json", "theme.css"]);
        expect(reads).toEqual([]);
        expect(result.manifest.version).toBe("3.1.0");
        // 主题 manifest 没有 id —— 身份是目录名，这里不该凭空造一个
        expect(result.manifest).not.toHaveProperty("id");
    });

    it("**缺 theme.css 才算缺文件**（缺的是主题入口，不是 main.js）", async () => {
        const { host } = themeHost({
            assets: { "manifest.json": "ok" },
            source: { "manifest.json": THEME_MANIFEST },
        });

        await expectInstallerError(
            () => load(host, RELEASE_SOURCE, THEME_SPEC),
            "missingRequiredFiles"
        );
    });

    it("主题没有可选文件：两个都必需", async () => {
        const { host } = themeHost({ source: { "theme.css": "/* only css */" } });

        await expectInstallerError(() => load(host, RAW_SOURCE, THEME_SPEC), "missingManifest");
    });

    it("主题的 manifest 不合规时按主题的规则报错（缺 name）", async () => {
        const { host } = themeHost({
            source: {
                "manifest.json": JSON.stringify({ version: "1.0.0" }),
                "theme.css": "/* css */",
            },
        });

        let detail: unknown;
        try {
            await load(host, RAW_SOURCE, THEME_SPEC);
        } catch (err) {
            detail = (err as { detail?: unknown }).detail;
        }

        expect(detail).toMatchObject({ kind: "manifestMissingField", field: "name" });
    });

    it("主题缺 version 时按 Obsidian 的规矩当 0.0.0，而不是拒绝整个仓库", async () => {
        const { host } = themeHost({
            source: {
                "manifest.json": JSON.stringify({ name: "No Version Theme" }),
                "theme.css": "/* css */",
            },
        });

        const result = await load(host, RAW_SOURCE, THEME_SPEC);

        expect(result.manifest.version).toBe("0.0.0");
        expect(result.manifest.name).toBe("No Version Theme");
    });
});
