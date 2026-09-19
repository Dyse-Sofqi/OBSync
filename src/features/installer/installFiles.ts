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
    /**
     * 资产通道**试过但没成**的原因：`transport` = 网络/超时，`not-found` = 资产 404。
     * `undefined` 表示这一次**根本没试**资产（被短路跳过了，或 release 里没这个资产）。
     *
     * 这个区分只服务一件事：决定「还要不要再试一次资产」。见 `fetchFromRelease`。
     */
    assetError?: "transport" | "not-found";
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
                assetError: err instanceof NotFoundError ? "not-found" : "transport",
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
     *
     * 但它**只是省时间的优化，不是「资产通道确实不可用」的结论** ——
     * 所以下面有一条：文件在源码里也拿不到时，为它再试一次资产。
     */
    let skipAssets = false;

    for (const name of spec.fileSet.all) {
        onProgress?.(name);

        const requiredFile = required.has(name);
        /** release 里**确实挂着**这个名字的资产（与「作者没传」是两件事）。 */
        const hasAsset = release.assets.some((asset) => asset.name === name);

        let result: FileLoadResult<N> | undefined;
        let failure: unknown;

        try {
            result = await loadReleaseFile(host, repoRef, name, release, token, repoLabel, skipAssets);
        } catch (err) {
            failure = err;
        }

        if (result?.assetUnreachable) skipAssets = true;

        /**
         * 源码通道也拿不到时，**为这个文件再试一次资产通道**。
         *
         * 为什么必须有这一条 —— 上面的短路会把一次本可成功的安装变成失败：
         *
         * 1. 第一个文件（`manifest.json`）的资产下载在冷连接上超时 → 回退源码成功
         *    → 记住「资产通道不通」；
         * 2. `main.js` / `styles.css` 因此被**跳过资产通道**，只去源码里找；
         * 3. 而它们都是构建产物（`.gitignore` 掉的），仓库里根本没有 ——
         *    于是「源码里找不到」被当成「这个插件缺 main.js」，安装失败。
         *
         * 实测（2026-09-19，本机）：`github.com/.../releases/download/...` 的**第一次**
         * 请求因为冷连接要 17~25 秒（超时阈值 20 秒），**第二次只要 ~600ms**。
         * 也就是说第 2 步里那些「被跳过」的资产，重试一次多半就能拿到 ——
         * 真机失败（Trefoil）正是卡在这里。
         *
         * 只在文件已经确定拿不到之后才重试，代价最多是这一次超时；而那条路径
         * 本来就要失败了，所以这笔时间买到的是「本来能装成」。
         *
         * 唯一的例外是**资产干净地 404**：那说明远端确实没有这个文件（作者的发布
         * 流程问题），再试一次只是多打一个请求 —— 留给上层报「缺文件」。
         */
        const unobtainable = result?.content === undefined;
        const assetDefinitelyGone = result?.assetError === "not-found";
        if (unobtainable && hasAsset && !assetDefinitelyGone) {
            logger.info(
                `could not get ${name} for ${repoLabel} from the source files — ` +
                    `retrying its release asset once`
            );
            try {
                result = await loadReleaseFile(
                    host,
                    repoRef,
                    name,
                    release,
                    token,
                    repoLabel,
                    false
                );
                failure = undefined;
            } catch (err) {
                failure = err;
            }
            if (result?.assetUnreachable) skipAssets = true;
        }

        if (result?.content !== undefined) {
            files.set(name, result.content);
            continue;
        }

        // 拿不到。必需文件要把错误抛出去（网络问题不该被当成「文件不存在」），
        // 可选文件吞掉 —— 与 `fetchOne` 的区分一致，见文件头的说明。
        if (requiredFile) {
            if (failure !== undefined) throw failure;
            // 没抛错说明两条通道都「读到了但没有这个文件」—— 留给 fetchFiles
            // 统一报错（那里才知道缺的是不是 manifest，以及是不是资产问题）。
            continue;
        }
        if (failure !== undefined) {
            logger.debug(`optional file ${name} unavailable for ${repoLabel}`, failure);
        }
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
    /**
     * release 通道里**挂着**的资产名。
     *
     * 只用来把「同一个缺文件」的两种成因分开：① 仓库/资产里确实没有它 ——
     * 那是作者的发布流程问题；② 挂在那儿但这次没下下来 —— 那是网络问题，
     * 重试或换 Gitee 镜像就能解决。不区分的话用户会被指去检查一个没问题的
     * 地方。实测踩过（2026-09-19）：GitHub 的 release 资产冷连接超时，
     * 而界面报的是「找不到 main.js」。
     */
    let assetNames: Set<string> | undefined;

    if (source.kind === "release") {
        const release = await host.getReleaseByTag(repoRef, source.tag, token);
        if (!release) {
            // tag 在这条通道上取不到 release —— 退到源码通道。
            logger.debug(`release ${source.tag} not found for ${repoLabel}, using source files`);
            files = await fetchFromRaw(host, repoRef, source.ref, token, repoLabel, spec, onProgress);
            channel = "raw";
        } else {
            assetNames = new Set(release.assets.map((asset) => asset.name));
            files = await fetchFromRelease(host, repoRef, release, token, repoLabel, spec, onProgress);
            channel = "release";
        }
    } else {
        files = await fetchFromRaw(host, repoRef, source.ref, token, repoLabel, spec, onProgress);
        channel = "raw";
    }

    const missing = spec.fileSet.required.filter((file) => !files.has(file));
    if (missing.length > 0) {
        // 先分「资产里挂着、却没取回来」：这种失败**不是**「这个文件不存在」，
        // 说成「找不到它」会把用户指去改一个没问题的发布流程。
        const fromAssets = missing.filter((file) => assetNames?.has(file));
        if (fromAssets.length > 0) {
            throw new InstallerError({
                kind: "assetDownloadFailed",
                repo: repoLabel,
                files: fromAssets.join("、"),
                of: spec.kind,
            });
        }

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
