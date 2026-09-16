import type { IRepoHost } from "../../host/IRepoHost";
import { NotFoundError } from "../../host/errors";
import { InstallerError } from "./errors";
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
 *
 * 对返回类型是泛型的：release 通道要额外回传「资产通道是否不可达」，
 * 源码通道只回传内容。
 */
async function fetchOne<T>(
    load: () => Promise<T>,
    name: PluginFileName,
    repoLabel: string
): Promise<T | undefined> {
    try {
        return await load();
    } catch (err) {
        if (isRequired(name)) throw err;
        logger.debug(`optional file ${name} unavailable for ${repoLabel}`, err);
        return undefined;
    }
}

interface FileLoadResult {
    content: string | undefined;
    /** 资产通道因**传输层**原因失败（不是"文件不存在"）。 */
    assetUnreachable: boolean;
}

/**
 * 取 release 里的单个文件：先试资产，**失败或不存在**都回到该 tag 的源码里读。
 *
 * 为什么失败也要回退（不只是"资产不存在"时回退）：
 * release 资产的下载地址是 `github.com/{o}/{r}/releases/download/...`，
 * 会 302 到 `objects.githubusercontent.com`。这条链路在国内网络下经常不可达 ——
 * 本机实测 3 次里 2 次 21 秒超时、0 字节，第 3 次才成功。
 * 而同一个文件在 `raw.githubusercontent.com` 上现成可取（release 本来就是从某个
 * tag 构建的），两者可达性互不相关。
 *
 * 不补这条回退，症状是「网络稍差就完全装不上插件」，
 * 而用户看到的只是一句网络错误，完全不知道换个通道就能成。
 */
async function loadReleaseFile(
    host: IRepoHost,
    repoRef: RepoRef,
    name: PluginFileName,
    release: Release,
    token: string | undefined,
    repoLabel: string,
    skipAssets: boolean
): Promise<FileLoadResult> {
    const asset = release.assets.find((candidate) => candidate.name === name);

    if (asset && !skipAssets) {
        try {
            const bytes = await host.downloadAsset(repoRef, asset, { token, release });
            return { content: decode(bytes), assetUnreachable: false };
        } catch (err) {
            logger.warn(
                `downloading asset ${name} for ${repoLabel} failed, ` +
                    `falling back to the source file at ${release.tag}`,
                err
            );
            return {
                content: await host.readFile(repoRef, name, { token, ref: release.tag }),
                // **只有传输层失败才算「资产通道整体不可用」。**
                //
                // 404 是**这一个资产**的问题（私有仓库的 `browser_download_url`
                // 本来就会 404），不代表后面的文件也拿不到。把它也算成不可用，
                // 会让后面的文件被无谓地跳过资产通道 —— 而 `main.js` 通常被
                // gitignore，源码通道取不到它，于是一次本可成功的安装变成失败。
                //
                // 反过来，网络超时才是「这条通道现在都不通」，那时记住它、
                // 后面的文件直接走源码，可以少等两次超时。
                assetUnreachable: !(err instanceof NotFoundError),
            };
        }
    }

    return {
        content: await host.readFile(repoRef, name, { token, ref: release.tag }),
        assetUnreachable: false,
    };
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

    /**
     * 资产通道一旦因传输层原因失败，**后续文件就不再试它**。
     *
     * 这条很重要：三个文件各试一次资产，而每次失败都要等一个超时 ——
     * 不记住的话，在资产 CDN 不可达的网络下（国内常态），
     * 装一个插件要白等三次超时。记住之后只付一次。
     */
    let skipAssets = false;

    for (const name of PLUGIN_FILES) {
        onProgress?.(name);
        const result = await fetchOne(
            () =>
                loadReleaseFile(host, repoRef, name, release, token, repoLabel, skipAssets),
            name,
            repoLabel
        );

        if (result?.assetUnreachable) skipAssets = true;
        if (result?.content !== undefined) files.set(name, result.content);
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
            throw new InstallerError({ kind: "missingManifest", repo: repoLabel });
        }
        throw new InstallerError({
            kind: "missingRequiredFiles",
            repo: repoLabel,
            files: missing.join("、"),
        });
    }

    const manifest = parseManifest(files.get("manifest.json")!, repoLabel);

    return { files, manifest, channel };
}
