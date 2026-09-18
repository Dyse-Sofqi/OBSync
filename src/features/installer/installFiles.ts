import type { IRepoHost } from "../../host/IRepoHost";
import { NotFoundError } from "../../host/errors";
import { InstallerError } from "./errors";
import { logger } from "../../core/logger";
import { parsePluginManifest, parseThemeManifest } from "./manifest";
import {
    FILE_SETS,
    MANIFEST_FILE,
    type FileSet,
    type InstallChannel,
    type InstallSource,
    type PluginFileName,
    type PluginManifest,
    type ThemeFileName,
    type ThemeManifest,
    type TrackedKind,
} from "./types";
import type { Release, RepoRef } from "../../host/types";

/**
 * 取一个被跟踪对象（插件或主题）需要的文件。
 *
 * 两条通道，优先级明确：
 *
 * 1. **release 资产** —— 作者发布正式版时附带的文件。
 * 2. **源码文件** —— 从仓库的某个 ref 直接读同名文件。
 *
 * 参考项目 BRAT 只有通道 1，而且要求文件都在 release 资产里。
 * 这在 Gitee 上基本跑不通（大量插件仓库不发 release），
 * 在 GitHub 上也会漏掉「只把 main.js 传成资产、manifest 留在仓库里」的插件。
 *
 * 所以这里的策略是**逐文件回退**：每个文件先试 release 资产，
 * 没有就回到该 tag 的源码里读。整条 release 通道都不通时，再由上层切到 raw。
 *
 * ## 必需文件与可选文件的错误处理不同
 *
 * 必需文件取不到 → 安装必须失败（否则会写出一个坏插件）。
 * 可选文件取不到 → **静默跳过**，包括网络错误。
 * 这条区分很重要：`styles.css` 在 release 资产里缺失、在仓库里被 gitignore、
 * 或者那次请求刚好超时，都不该让用户装不上插件。
 * （主题没有可选文件 —— 它的两个文件都必需。）
 *
 * ## 为什么按「文件集 + 解析器」参数化
 *
 * 插件要 `manifest.json` + `main.js`（可选 `styles.css`），主题要
 * `manifest.json` + `theme.css`。除了这两样，整条链路 —— 逐文件资产回退、
 * 传输层失败的短路、必需与可选的差别对待 —— 两者**完全一样**。
 * 所以这里只有文件集与 manifest 解析器是参数，其余保持一份实现。
 * （BRAT 是插件、主题各写一份 `features/*.ts`，同一个「通道回退」的坑
 * 踩两遍。）
 */
export interface FetchedFiles<N extends string, M> {
    files: Map<N, string>;
    manifest: M;
    channel: InstallChannel;
}

/** 一个 kind 的取文件规格。 */
export interface FetchSpec<N extends string, M> {
    kind: TrackedKind;
    fileSet: FileSet<N>;
    parseManifest(raw: string, context: string): M;
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
    required: boolean,
    name: string,
    repoLabel: string
): Promise<T | undefined> {
    try {
        return await load();
    } catch (err) {
        if (required) throw err;
        logger.debug(`optional file ${name} unavailable for ${repoLabel}`, err);
        return undefined;
    }
}

interface FileLoadResult<N extends string> {
    content: string | undefined;
    /** 资产通道因**传输层**原因失败（不是"文件不存在"）。 */
    assetUnreachable: boolean;
    name: N;
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
async function loadReleaseFile<N extends string>(
    host: IRepoHost,
    repoRef: RepoRef,
    name: N,
    release: Release,
    token: string | undefined,
    repoLabel: string,
    skipAssets: boolean
): Promise<FileLoadResult<N>> {
    const asset = release.assets.find((candidate) => candidate.name === name);

    if (asset && !skipAssets) {
        try {
            const bytes = await host.downloadAsset(repoRef, asset, { token, release });
            return { content: decode(bytes), assetUnreachable: false, name };
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
                name,
            };
        }
    }

    return {
        content: await host.readFile(repoRef, name, { token, ref: release.tag }),
        assetUnreachable: false,
        name,
    };
}

/** 从 release 资产 + 该 tag 的源码里取文件。 */
async function fetchFromRelease<N extends string, M>(
    host: IRepoHost,
    repoRef: RepoRef,
    release: Release,
    token: string | undefined,
    repoLabel: string,
    spec: FetchSpec<N, M>,
    onProgress?: (file: N) => void
): Promise<Map<N, string>> {
    const files = new Map<N, string>();
    const required = new Set<string>(spec.fileSet.required);

    /**
     * 资产通道一旦因传输层原因失败，**后续文件就不再试它**。
     *
     * 这条很重要：每个文件各试一次资产，而每次失败都要等一个超时 ——
     * 不记住的话，在资产 CDN 不可达的网络下（国内常态），
     * 装一个插件要白等三次超时。记住之后只付一次。
     */
    let skipAssets = false;

    for (const name of spec.fileSet.all) {
        onProgress?.(name);
        const result = await fetchOne(
            () =>
                loadReleaseFile(host, repoRef, name, release, token, repoLabel, skipAssets),
            required.has(name),
            name,
            repoLabel
        );

        if (result?.assetUnreachable) skipAssets = true;
        if (result?.content !== undefined) files.set(name, result.content);
    }

    return files;
}

/** 从某个 ref 的源码里取文件。 */
async function fetchFromRaw<N extends string, M>(
    host: IRepoHost,
    repoRef: RepoRef,
    refName: string,
    token: string | undefined,
    repoLabel: string,
    spec: FetchSpec<N, M>,
    onProgress?: (file: N) => void
): Promise<Map<N, string>> {
    const files = new Map<N, string>();
    const required = new Set<string>(spec.fileSet.required);

    for (const name of spec.fileSet.all) {
        onProgress?.(name);
        const content = await fetchOne(
            () => host.readFile(repoRef, name, { token, ref: refName }),
            required.has(name),
            name,
            repoLabel
        );
        if (content !== undefined) files.set(name, content);
    }

    return files;
}

/**
 * 取齐文件并解析 manifest。
 *
 * @throws 必需文件缺失、请求失败或 manifest 不合法时抛错。
 */
export async function fetchFiles<N extends string, M>(
    host: IRepoHost,
    repoRef: RepoRef,
    source: InstallSource,
    token: string | undefined,
    spec: FetchSpec<N, M>,
    onProgress?: (file: N) => void
): Promise<FetchedFiles<N, M>> {
    const repoLabel = `${repoRef.owner}/${repoRef.repo}`;
    // 文件集的元素类型是每个 kind 自己的字面量联合，而 manifest 的名字是两者共有的
    // 常量 —— 这里的转换只是为了把它带进 `Map<N, string>` 的键空间。
    const manifestFile = MANIFEST_FILE as N;

    let files: Map<N, string>;
    let channel: InstallChannel;

    if (source.kind === "release") {
        const release = await host.getReleaseByTag(repoRef, source.tag, token);
        if (!release) {
            // tag 在这条通道上取不到 release —— 退到源码通道。
            logger.debug(`release ${source.tag} not found for ${repoLabel}, using source files`);
            files = await fetchFromRaw(host, repoRef, source.ref, token, repoLabel, spec, onProgress);
            channel = "raw";
        } else {
            files = await fetchFromRelease(host, repoRef, release, token, repoLabel, spec, onProgress);
            channel = "release";
        }
    } else {
        files = await fetchFromRaw(host, repoRef, source.ref, token, repoLabel, spec, onProgress);
        channel = "raw";
    }

    const missing = spec.fileSet.required.filter((file) => !files.has(file));
    if (missing.length > 0) {
        // 分开报错：没有 manifest.json 说明这多半不是这类仓库；
        // 缺别的文件说明是这类仓库但作者没提交构建产物。
        if (missing.includes(manifestFile)) {
            throw new InstallerError({ kind: "missingManifest", repo: repoLabel, of: spec.kind });
        }
        throw new InstallerError({
            kind: "missingRequiredFiles",
            repo: repoLabel,
            files: missing.join("、"),
            of: spec.kind,
        });
    }

    const manifest = spec.parseManifest(files.get(manifestFile)!, repoLabel);

    return { files, manifest, channel };
}

/** 插件（`manifest.json` + `main.js`，可选 `styles.css`）。 */
export const PLUGIN_SPEC: FetchSpec<PluginFileName, PluginManifest> = {
    kind: "plugin",
    fileSet: FILE_SETS.plugin,
    parseManifest: parsePluginManifest,
};

/** 主题（`manifest.json` + `theme.css`）。 */
export const THEME_SPEC: FetchSpec<ThemeFileName, ThemeManifest> = {
    kind: "theme",
    fileSet: FILE_SETS.theme,
    parseManifest: parseThemeManifest,
};
