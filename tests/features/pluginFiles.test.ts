import { describe, expect, it } from "vitest";
import { NetworkError, NotFoundError } from "../../src/host/errors";
import type { IRepoHost } from "../../src/host/IRepoHost";
import type { Release, RepoRef } from "../../src/host/types";
import { fetchPluginFiles } from "../../src/features/installer/pluginFiles";
import { expectInstallerError } from "../helpers/expectInstallerError";
import type {
    InstallSource,
    PluginFileName,
} from "../../src/features/installer/types";

/**
 * 取插件文件的**通道选择与回退**。
 *
 * ## 为什么这个文件值得单独测
 *
 * 这段逻辑此前只被一个 live 测试碰过（要联网、要真实仓库），
 * 而它承载的是两条**只有在本机网络下才显得关键**的行为：
 *
 * - 资产通道（`releases/download/...` → `objects.githubusercontent.com`）在国内
 *   经常不可达，所以要逐文件回退到源码通道；
 * - 资产通道整体不通时要**记住**，否则三个文件各等一次超时（白等三次）。
 *
 * 用假 host 直接测，既快又不需要网络，而且能把「哪个文件试了哪条通道」记清楚 ——
 * 这类「试了没试」的性质靠读代码很难确认。
 */

const REF: RepoRef = { host: "github", owner: "owner", repo: "demo" };

const VALID_MANIFEST = JSON.stringify({
    id: "demo",
    name: "Demo",
    version: "1.0.0",
    minAppVersion: "1.8.7",
});

/** 资产通道返回的内容。manifest 必须是合法 JSON —— 它会被解析。 */
function assetContent(name: string): string {
    if (name === "manifest.json") return VALID_MANIFEST;
    if (name === "main.js") return "// from asset";
    return "/* from asset */";
}

/** 资产下载的行为。`absent` 表示 release 里根本没有这个资产。 */
type AssetOutcome = "ok" | "network" | "not-found" | "absent";

interface Scenario {
    /** false 模拟「这个 tag 取不到 release」。 */
    hasRelease?: boolean;
    assets?: Partial<Record<PluginFileName, AssetOutcome>>;
    /** 源码通道能提供哪些文件（缺失即读不到）。 */
    source?: Partial<Record<PluginFileName, string>>;
    /** 源码通道对某些文件**抛错**（模拟网络失败，而非「文件不存在」）。 */
    sourceError?: Partial<Record<PluginFileName, boolean>>;
}

function createHost(scenario: Scenario) {
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
        getReleaseByTag: async () =>
            scenario.hasRelease === false ? undefined : release,

        downloadAsset: async (_ref: RepoRef, asset: { name: string }) => {
            downloads.push(asset.name);
            const outcome = scenario.assets?.[asset.name as PluginFileName] ?? "ok";
            if (outcome === "network") throw new NetworkError("asset CDN unreachable");
            if (outcome === "not-found") throw new NotFoundError("asset gone");
            return new TextEncoder().encode(assetContent(asset.name)).buffer;
        },

        readFile: async (_ref: RepoRef, path: string) => {
            reads.push(path);
            if (scenario.sourceError?.[path as PluginFileName]) {
                throw new NetworkError(`readFile failed for ${path}`);
            }
            return scenario.source?.[path as PluginFileName];
        },
    } as unknown as IRepoHost;

    return { host, downloads, reads };
}

/** 统一补上 token 参数（这些用例都不涉及令牌）。 */
function load(host: IRepoHost, source: InstallSource) {
    return fetchPluginFiles(host, REF, source, undefined);
}

const RELEASE_SOURCE: InstallSource = { kind: "release", tag: "1.0.0", ref: "1.0.0" };
const RAW_SOURCE: InstallSource = { kind: "raw", ref: "HEAD" };

describe("fetchPluginFiles 的通道选择", () => {
    it("资产齐全时走 release 通道", async () => {
        const { host, downloads } = createHost({
            assets: { "manifest.json": "ok", "main.js": "ok", "styles.css": "ok" },
        });

        const result = await load(host, RELEASE_SOURCE);

        expect(result.channel).toBe("release");
        expect(result.files.get("main.js")).toBe("// from asset");
        expect(downloads).toEqual(["manifest.json", "main.js", "styles.css"]);
    });

    it("**资产通道网络不可达时，后续文件不再试它**（否则白等三次超时）", async () => {
        const { host, downloads, reads } = createHost({
            assets: { "manifest.json": "network", "main.js": "ok", "styles.css": "ok" },
            source: { "manifest.json": VALID_MANIFEST, "main.js": "// from source" },
        });

        const result = await load(host, RELEASE_SOURCE);

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
            source: { "manifest.json": VALID_MANIFEST },
        });

        const result = await load(host, RELEASE_SOURCE);

        // manifest.json 那一次失败不该影响后面的文件
        expect(downloads).toEqual(["manifest.json", "main.js", "styles.css"]);
        expect(result.files.get("main.js")).toBe("// from asset");
        expect(result.files.get("styles.css")).toBe("/* from asset */");
    });

    it("release 里没有某个资产时，该文件回退源码（不算通道失败）", async () => {
        const { host, downloads } = createHost({
            assets: { "main.js": "ok" }, // manifest.json 没被发布成资产
            source: { "manifest.json": VALID_MANIFEST },
        });

        const result = await load(host, RELEASE_SOURCE);

        expect(downloads).toEqual(["main.js"]); // manifest 没资产，不会去下载
        expect(result.files.get("manifest.json")).toBe(VALID_MANIFEST);
        expect(result.channel).toBe("release");
    });

    it("逐文件回退到源码后，channel 仍报 release（来源规格就是 release）", async () => {
        const { host } = createHost({
            assets: { "manifest.json": "ok", "main.js": "network" },
            source: { "main.js": "// from source" },
        });

        const result = await load(host, RELEASE_SOURCE);

        expect(result.files.get("main.js")).toBe("// from source");
        expect(result.channel).toBe("release");
    });

    it("tag 取不到 release 时整条通道切到 raw", async () => {
        const { host, downloads } = createHost({
            hasRelease: false,
            source: { "manifest.json": VALID_MANIFEST, "main.js": "// from source" },
        });

        const result = await load(host, RELEASE_SOURCE);

        expect(downloads).toEqual([]);
        expect(result.channel).toBe("raw");
    });
});

describe("fetchPluginFiles 的必需/可选文件", () => {
    it("**styles.css 取不到不影响安装**（可选文件，连网络错误也吞掉）", async () => {
        const { host } = createHost({
            assets: { "manifest.json": "ok", "main.js": "ok", "styles.css": "network" },
        });

        const result = await load(host, RELEASE_SOURCE);

        expect(result.files.has("styles.css")).toBe(false);
        expect(result.manifest.id).toBe("demo");
    });

    it("缺 manifest.json 报 missingManifest（多半不是插件仓库）", async () => {
        const { host } = createHost({ assets: { "main.js": "ok" } });

        await expectInstallerError(() => load(host, RAW_SOURCE), "missingManifest");
    });

    it("有 manifest 但缺 main.js 报 missingRequiredFiles（作者没提交构建产物）", async () => {
        const { host } = createHost({
            assets: { "manifest.json": "ok" },
            source: { "manifest.json": VALID_MANIFEST },
        });

        await expectInstallerError(() => load(host, RELEASE_SOURCE), "missingRequiredFiles");
    });

    it("必需文件在两条通道上**都读不到**时，报「缺文件」而不是网络错误", async () => {
        // 「读不到」和「读失败」是两回事：前者是文件不存在（可能是仓库不对），
        // 后者是网络问题（该重试）。这条锁的是前者。
        const { host } = createHost({
            assets: { "manifest.json": "not-found", "main.js": "not-found" },
        });

        await expectInstallerError(() => load(host, RELEASE_SOURCE), "missingManifest");
    });

    it("必需文件遇到**网络错误**时原样抛出，不被当成「文件不存在」吞掉", async () => {
        // 吞掉的话用户会看到「这多半不是插件仓库」—— 而实际只是网络不通，
        // 重试就能成功。指错方向的提示比没有提示更糟。
        const { host } = createHost({ sourceError: { "manifest.json": true } });

        await expect(load(host, RAW_SOURCE)).rejects.toBeInstanceOf(NetworkError);
    });
});
