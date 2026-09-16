import type { IRepoHost } from "../../host/IRepoHost";
import { ObsyncError } from "../../host/errors";
import { logger } from "../../core/logger";
import { parseManifest } from "./manifest";
import {
    PLUGIN_FILES,
    REQUIRED_FILES,
    type InstallChannel,
    type InstallSource,
    type PluginFileName,
    type PluginManifest,
} from "./types";
import type { Release, RepoRef } from "../../host/types";

/**
 * 取插件文件。
 *
 * 两条通道，优先级明确：
 *
 * 1. **release 资产** —— 作者发布正式版时附带的 `main.js` / `manifest.json` / `styles.css`。
 * 2. **源码文件** —— 从仓库的某个 ref 直接读同名文件。
 *
 * 参考项目 BRAT 只有通道 1，而且要求三个文件都在 release 资产里。
 * 这在 Gitee 上基本跑不通（大量插件仓库不发 release），
 * 在 GitHub 上也会漏掉「只把 main.js 传成资产、manifest 留在仓库里」的插件。
 *
 * 所以这里的策略是**逐文件回退**：每个文件先试 release 资产，
 * 没有就回到该 tag 的源码里读。整条 release 通道都不通时，再由上层切到 raw。
 *
 * ## 必需文件与可选文件的错误处理不同
 *
 * `main.js` / `manifest.json` 取不到 → 安装必须失败（否则会写出一个坏插件）。
 * `styles.css` 取不到 → **静默跳过**，包括网络错误。
 * 这条区分很重要：`styles.css` 在 release 资产里缺失、在仓库里被 gitignore、
 * 或者那次请求刚好超时，都不该让用户装不上插件。
 */

export interface FetchedPluginFiles {
    files: Map<PluginFileName, string>;
    manifest: PluginManifest;
    channel: InstallChannel;
}

const REQUIRED = new Set<string>(REQUIRED_FILES);

function isRequired(name: PluginFileName): boolean {
    return REQUIRED.has(name);
}

function decode(bytes: ArrayBuffer): string {
    return new TextDecoder().decode(bytes);
}

/**
 * 取单个文件。可选文件失败时返回 undefined 而不是抛错。
 */
async function fetchOne(
    load: () => Promise<string | undefined>,
    name: PluginFileName,
    repoLabel: string
): Promise<string | undefined> {
    try {
        return await load();
    } catch (err) {
        if (isRequired(name)) throw err;
        logger.debug(`optional file ${name} unavailable for ${repoLabel}`, err);
        return undefined;
    }
}

/** 从 release 资产 + 该 tag 的源码里取文件。 */
async function fetchFromRelease(
    host: IRepoHost,
    repoRef: RepoRef,
    release: Release,
    token: string | undefined,
    repoLabel: string,
    onProgress?: (file: PluginFileName) => void
): Promise<Map<PluginFileName, string>> {
    const files = new Map<PluginFileName, string>();

    for (const name of PLUGIN_FILES) {
        onProgress?.(name);
        const asset = release.assets.find((candidate) => candidate.name === name);

        const content = await fetchOne(
            async () => {
                if (asset) {
                    const bytes = await host.downloadAsset(repoRef, asset, { token, release });
                    return decode(bytes);
                }
                // 资产里没有这个文件 —— 回到该 tag 的源码里找。
                return await host.readFile(repoRef, name, { token, ref: release.tag });
            },
            name,
            repoLabel
        );

        if (content !== undefined) files.set(name, content);
    }

    return files;
}

/** 从某个 ref 的源码里取文件。 */
async function fetchFromRaw(
    host: IRepoHost,
    repoRef: RepoRef,
    refName: string,
    token: string | undefined,
    repoLabel: string,
    onProgress?: (file: PluginFileName) => void
): Promise<Map<PluginFileName, string>> {
    const files = new Map<PluginFileName, string>();

    for (const name of PLUGIN_FILES) {
        onProgress?.(name);
        const content = await fetchOne(
            () => host.readFile(repoRef, name, { token, ref: refName }),
            name,
            repoLabel
        );
        if (content !== undefined) files.set(name, content);
    }

    return files;
}

/**
 * 取齐插件文件并解析 manifest。
 *
 * @throws 必需文件缺失、请求失败或 manifest 不合法时抛错。
 */
export async function fetchPluginFiles(
    host: IRepoHost,
    repoRef: RepoRef,
    source: InstallSource,
    token: string | undefined,
    onProgress?: (file: PluginFileName) => void
): Promise<FetchedPluginFiles> {
    const repoLabel = `${repoRef.owner}/${repoRef.repo}`;

    let files: Map<PluginFileName, string>;
    let channel: InstallChannel;

    if (source.kind === "release") {
        const release = await host.getReleaseByTag(repoRef, source.tag, token);
        if (!release) {
            // tag 在这条通道上取不到 release —— 退到源码通道。
            logger.debug(`release ${source.tag} not found for ${repoLabel}, using source files`);
            files = await fetchFromRaw(host, repoRef, source.ref, token, repoLabel, onProgress);
            channel = "raw";
        } else {
            files = await fetchFromRelease(host, repoRef, release, token, repoLabel, onProgress);
            channel = "release";
        }
    } else {
        files = await fetchFromRaw(host, repoRef, source.ref, token, repoLabel, onProgress);
        channel = "raw";
    }

    const missing = REQUIRED_FILES.filter((file) => !files.has(file));
    if (missing.length > 0) {
        // 分开报错：没有 manifest.json 说明这多半不是插件仓库；
        // 没有 main.js 说明是插件仓库但作者没提交构建产物。
        if (missing.includes("manifest.json")) {
            throw new ObsyncError(
                `${repoLabel} 里找不到 manifest.json，它可能不是 Obsidian 插件仓库。`
            );
        }
        throw new ObsyncError(
            `${repoLabel} 里找不到 ${missing.join("、")}，无法安装。` +
                `如果这是源码仓库，作者可能没有把构建产物提交进仓库。`
        );
    }

    const manifest = parseManifest(files.get("manifest.json")!, repoLabel);

    return { files, manifest, channel };
}
