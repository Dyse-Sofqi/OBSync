import type {
    AuthResult,
    HostKind,
    Release,
    ReleaseAsset,
    RepoMeta,
    RepoRef,
    TokenInfo,
} from "./types";

/**
 * 平台适配层的统一接口 —— 整个插件的「脊柱」。
 *
 * 「插件安装器」和「Git 同步」两个功能都通过它访问远端，所以 GitHub 与 Gitee
 * 的差异只需要在这里各实现一次，而不是在两个功能里各写一遍。
 */

export interface ListReleasesOptions {
    token?: string;
    /** 最多取多少个 release。两个平台单页上限都是 100。 */
    limit?: number;
    /** 是否包含预发布版本。默认 true —— 安装 beta 版插件依赖这个。 */
    includePrerelease?: boolean;
}

export interface ReadFileOptions {
    token?: string;
    /** 分支 / tag / commit。不传则由平台解析默认分支。 */
    ref?: string;
}

export interface DownloadAssetOptions {
    token?: string;
    /** Gitee 私有仓库走 API 附件端点时需要。 */
    release?: Release;
}

export interface IRepoHost {
    readonly kind: HostKind;
    /** 展示用名称。GitHub / Gitee 是专有名词，两种语言下一致。 */
    readonly displayName: string;
    readonly webBaseUrl: string;
    readonly apiBaseUrl: string;
    /**
     * 该平台是否把令牌放在查询串里。
     *
     * 这个差异**无法用统一的请求装饰器消除**：GitHub 用 `Authorization` 请求头，
     * Gitee 用 `?access_token=`（见 docs/reference-analysis.md 3.2 差异 2）。
     * 所以鉴权注入必须是接口方法，而不是共用的工具函数。
     */
    readonly tokenInQuery: boolean;

    /** 仓库元信息。安装器走 raw 回退通道时需要 `defaultBranch`。 */
    getRepoMeta(ref: RepoRef, token?: string): Promise<RepoMeta>;

    /** 列出 release。实现负责保证「最新的在前」—— Gitee 默认是升序，必须显式纠正。 */
    listReleases(ref: RepoRef, options?: ListReleasesOptions): Promise<Release[]>;

    /** 按 tag 取 release。不存在时返回 undefined。 */
    getReleaseByTag(ref: RepoRef, tag: string, token?: string): Promise<Release | undefined>;

    /** 取最新 release。平台没有发布过 release 时返回 undefined。 */
    getLatestRelease(ref: RepoRef, token?: string): Promise<Release | undefined>;

    /** 下载 release 资产，返回原始字节。 */
    downloadAsset(
        ref: RepoRef,
        asset: ReleaseAsset,
        options?: DownloadAssetOptions
    ): Promise<ArrayBuffer>;

    /** 读取仓库里的单个文件内容。文件不存在时返回 undefined。 */
    readFile(
        ref: RepoRef,
        path: string,
        options?: ReadFileOptions
    ): Promise<string | undefined>;

    /** 校验令牌是否可用，并返回对应账号。 */
    validateToken(token: string): Promise<TokenInfo>;

    /** 把令牌注入到请求参数里（URL 或请求头，视平台而定）。 */
    applyAuth(url: string, token: string): AuthResult;
}

/** 从响应头里读限流恢复时间（秒级时间戳），转成毫秒。 */
export function parseRateLimitReset(
    headers: Record<string, string>
): number | undefined {
    const raw = headers["x-ratelimit-reset"];
    if (!raw) return undefined;
    const seconds = Number(raw);
    if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
    return seconds * 1000;
}
