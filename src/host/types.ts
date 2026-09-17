/**
 * host 层的领域类型。
 *
 * 设计目标：让 GitHub 与 Gitee 的差异**只体现在实现里**，调用方（安装器 / 同步）
 * 面对的是一套统一模型。实测确认 Gitee 的 Release 结构与 GitHub 同构
 * （见 docs/reference-analysis.md 3.1），所以这里可以用同一组类型。
 */

/**
 * 受支持的代码托管平台 —— **这是唯一的事实来源**，`HostKind` 由它推导。
 *
 * 为什么非得是数组而不是只写联合类型：这个「有哪些平台」的事实原本散在四处
 * （`settings` 的持久化校验、`secretStore` 的快照循环、设置页的两个令牌输入框、
 * 这里）。四处各写一份的后果不是「不好看」—— `settings` 那份漏掉某个平台时，
 * 用户在**那个平台**上装的插件会在下次加载 `data.json` 时被当成非法条目
 * **无声丢弃**，列表里就没了。
 *
 * 加一个平台要动的地方（`hostRegistry.ts` 的说明里有完整清单）从这条开始。
 */
export const SUPPORTED_HOSTS = ["github", "gitee"] as const;

export type HostKind = (typeof SUPPORTED_HOSTS)[number];

/** 一个仓库的结构化标识。这是整个插件里传递仓库的唯一形式。 */
export interface RepoRef {
    host: HostKind;
    owner: string;
    repo: string;
}

/** `owner/repo` 形式的稳定字符串，用于持久化与去重比较。 */
export type RepoId = string;

export interface RepoMeta {
    ref: RepoRef;
    /** 默认分支名。安装器走 raw 回退通道时要用到。 */
    defaultBranch: string;
    isPrivate: boolean;
    description?: string;
    /** 仓库主页，例如 https://github.com/owner/repo */
    webUrl: string;
}

export interface ReleaseAsset {
    /** 平台侧的资产 id。Gitee 私有仓库走 API 下载端点时必须带上。 */
    id?: string;
    name: string;
    size: number;
    /** 公开可下载地址（GitHub 的 browser_download_url / Gitee 的 browser_download_url）。 */
    downloadUrl: string;
    /**
     * 需要鉴权时的 API 地址。
     * GitHub 有（`assets[].url`，配合 `Accept: application/octet-stream` 下载私有资产）；
     * Gitee 没有，为 undefined。
     */
    apiUrl?: string;
}

export interface Release {
    /** 平台侧的 release id。Gitee 用它拼附件下载端点。 */
    id?: string;
    /** tag 名，例如 `1.2.3` 或 `v1.2.3`。 */
    tag: string;
    /** release 标题。Gitee 上可能与 tag 相同。 */
    name: string;
    prerelease: boolean;
    /** ISO 8601 时间字符串。 */
    publishedAt: string;
    assets: ReleaseAsset[];
}

/** 令牌校验结果。 */
export interface TokenInfo {
    valid: boolean;
    /** 令牌对应的账号名。 */
    account?: string;
}

/** 注入鉴权后的请求参数。 */
export interface AuthResult {
    url: string;
    headers: Record<string, string>;
}
