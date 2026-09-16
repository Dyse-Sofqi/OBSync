import { logger } from "../core/logger";
import { NetworkError, NotFoundError } from "./errors";
import { encodePathSegments, getHeader, httpJson, httpRequest } from "./http";
import type {
    DownloadAssetOptions,
    IRepoHost,
    ListReleasesOptions,
    ReadFileOptions,
} from "./IRepoHost";
import { parseRateLimitReset } from "./IRepoHost";
import { formatRepoId } from "./repoRef";
import { throwForStatus } from "./statusMapper";
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
 * GitHub 实现。
 *
 * 对应参考项目 BRAT 的 `githubUtils.ts`，但补了三个原版没有的处理：
 * 1. **release 分页** —— 原版只取一页（`per_page=100`，无翻页循环），
 *    对发布超过 100 个 release 的仓库会漏掉旧版本。
 * 2. **限流区分** —— 403 不一定限流，要看 `x-ratelimit-remaining`。
 * 3. **无令牌时走 raw 域名** —— `raw.githubusercontent.com` 不占用
 *    未认证的 60 次/小时 API 配额，安装插件时能省下大量配额。
 */

const API_BASE = "https://api.github.com";
const RAW_BASE = "https://raw.githubusercontent.com";
const API_VERSION = "2022-11-28";

interface GitHubAsset {
    id: number;
    name: string;
    size: number;
    browser_download_url: string;
    url: string;
}

interface GitHubRelease {
    id: number;
    tag_name: string;
    name: string | null;
    prerelease: boolean;
    draft: boolean;
    published_at: string | null;
    created_at: string;
    assets: GitHubAsset[] | null;
}

interface GitHubRepo {
    default_branch: string;
    private: boolean;
    description: string | null;
    html_url: string;
}

interface GitHubUser {
    login: string;
}

function mapRelease(raw: GitHubRelease): Release {
    return {
        id: String(raw.id),
        tag: raw.tag_name,
        name: raw.name ?? raw.tag_name,
        prerelease: raw.prerelease,
        publishedAt: raw.published_at ?? raw.created_at,
        assets: (raw.assets ?? []).map(
            (asset): ReleaseAsset => ({
                id: String(asset.id),
                name: asset.name,
                size: asset.size,
                downloadUrl: asset.browser_download_url,
                apiUrl: asset.url,
            })
        ),
    };
}

export class GitHubHost implements IRepoHost {
    readonly kind: HostKind = "github";
    readonly displayName = "GitHub";
    readonly webBaseUrl = "https://github.com";
    readonly apiBaseUrl = API_BASE;
    readonly tokenInQuery = false;
    /**
     * GitHub 只校验令牌、不校验用户名，所以这里用约定俗成的 `x-access-token`
     * （与 GitHub Actions 的 `actions/checkout` 一致）而不是 `git` ——
     * 两边统一成「有据可依的值」，免得将来又有人以为是随手填的占位符。
     */
    readonly gitAuthUsername = "x-access-token";

    private baseHeaders(): Record<string, string> {
        return {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": API_VERSION,
            "User-Agent": "OBSync",
        };
    }

    private headers(token?: string): Record<string, string> {
        const headers = this.baseHeaders();
        if (token) headers.Authorization = `Bearer ${token}`;
        return headers;
    }

    /**
     * GitHub 的限流判定：403 或 429，且（429 或 remaining 为 0）。
     * 单纯的 403 是权限问题，不是限流。
     */
    private isRateLimited(status: number, headers: Record<string, string>): boolean {
        if (status === 429) return true;
        if (status !== 403) return false;
        const remaining = getHeader(headers, "x-ratelimit-remaining");
        return remaining === "0";
    }

    private fail(
        status: number,
        headers: Record<string, string>,
        text: string,
        ref: RepoRef,
        action: string
    ): never {
        throwForStatus({
            host: this.kind,
            displayName: this.displayName,
            status,
            headers,
            text,
            repo: formatRepoId(ref),
            isRateLimited: this.isRateLimited(status, headers),
            resetAt: parseRateLimitReset(headers),
            action,
        });
    }

    async getRepoMeta(ref: RepoRef, token?: string): Promise<RepoMeta> {
        const id = formatRepoId(ref);
        const res = await httpJson<GitHubRepo>({
            url: `${API_BASE}/repos/${id}`,
            headers: this.headers(token),
        });
        if (res.status !== 200 || !res.data) {
            this.fail(res.status, res.headers, res.text, ref, "reading repository metadata");
        }
        return {
            ref,
            defaultBranch: res.data.default_branch,
            isPrivate: res.data.private,
            description: res.data.description ?? undefined,
            webUrl: res.data.html_url,
        };
    }

    async listReleases(ref: RepoRef, options: ListReleasesOptions = {}): Promise<Release[]> {
        const { token, limit = 100, includePrerelease = true } = options;
        const id = formatRepoId(ref);
        const perPage = Math.min(100, Math.max(1, limit));

        const collected: Release[] = [];
        let page = 1;

        while (collected.length < limit) {
            const res = await httpJson<GitHubRelease[]>({
                url: `${API_BASE}/repos/${id}/releases?per_page=${perPage}&page=${page}`,
                headers: this.headers(token),
            });
            if (res.status !== 200) {
                this.fail(res.status, res.headers, res.text, ref, "listing releases");
            }

            const batch = res.data ?? [];
            if (batch.length === 0) break;

            for (const raw of batch) {
                if (raw.draft) continue;
                if (!includePrerelease && raw.prerelease) continue;
                collected.push(mapRelease(raw));
            }

            if (batch.length < perPage) break;
            page += 1;
        }

        return collected.slice(0, limit);
    }

    async getReleaseByTag(
        ref: RepoRef,
        tag: string,
        token?: string
    ): Promise<Release | undefined> {
        const id = formatRepoId(ref);
        const res = await httpJson<GitHubRelease>({
            url: `${API_BASE}/repos/${id}/releases/tags/${encodeURIComponent(tag)}`,
            headers: this.headers(token),
        });
        if (res.status === 404) return undefined;
        if (res.status !== 200 || !res.data) {
            this.fail(res.status, res.headers, res.text, ref, `reading release ${tag}`);
        }
        return mapRelease(res.data);
    }

    async getLatestRelease(ref: RepoRef, token?: string): Promise<Release | undefined> {
        const id = formatRepoId(ref);
        const res = await httpJson<GitHubRelease>({
            url: `${API_BASE}/repos/${id}/releases/latest`,
            headers: this.headers(token),
        });
        // 仓库从未发布过 release 时 GitHub 返回 404 —— 这不是错误，是正常状态。
        if (res.status === 404) return undefined;
        if (res.status !== 200 || !res.data) {
            this.fail(res.status, res.headers, res.text, ref, "reading the latest release");
        }
        return mapRelease(res.data);
    }

    async downloadAsset(
        ref: RepoRef,
        asset: ReleaseAsset,
        options: DownloadAssetOptions = {}
    ): Promise<ArrayBuffer> {
        const { token } = options;

        // 私有仓库的 browser_download_url 会 404，必须走 API 资产地址
        // 并带上 Accept: application/octet-stream。
        if (token && asset.apiUrl) {
            const res = await httpRequest({
                url: asset.apiUrl,
                headers: { ...this.headers(token), Accept: "application/octet-stream" },
            });
            if (res.status !== 200) {
                this.fail(res.status, res.headers, res.text, ref, `downloading ${asset.name}`);
            }
            return res.arrayBuffer;
        }

        const res = await httpRequest({
            url: asset.downloadUrl,
            headers: token ? this.headers(token) : this.baseHeaders(),
        });
        if (res.status !== 200) {
            this.fail(res.status, res.headers, res.text, ref, `downloading ${asset.name}`);
        }
        return res.arrayBuffer;
    }

    async readFile(
        ref: RepoRef,
        path: string,
        options: ReadFileOptions = {}
    ): Promise<string | undefined> {
        const { token, ref: refName } = options;
        const id = formatRepoId(ref);
        const encodedPath = encodePathSegments(path);

        if (token) {
            // 有令牌就走 contents API —— 私有仓库唯一可行的通道。
            const query = refName ? `?ref=${encodeURIComponent(refName)}` : "";
            const res = await httpRequest({
                url: `${API_BASE}/repos/${id}/contents/${encodedPath}${query}`,
                headers: { ...this.headers(token), Accept: "application/vnd.github.raw" },
            });
            if (res.status === 404) return undefined;
            if (res.status !== 200) {
                this.fail(res.status, res.headers, res.text, ref, `reading ${path}`);
            }
            return res.text;
        }

        // 无令牌时优先走 raw 域名：不消耗 60 次/小时的未认证 API 配额。
        // `HEAD` 是 GitHub 支持的「默认分支」写法，省掉一次 getRepoMeta 请求。
        const refSegment = encodePathSegments(refName ?? "HEAD");
        try {
            const res = await httpRequest({
                url: `${RAW_BASE}/${id}/${refSegment}/${encodedPath}`,
            });
            if (res.status === 200) return res.text;
            if (res.status === 404) return undefined;
            this.fail(res.status, res.headers, res.text, ref, `reading ${path}`);
        } catch (err) {
            // raw 域名不可达时退回 contents API。
            // `raw.githubusercontent.com` 在国内网络下经常被阻断，而
            // `api.github.com` 通常可达 —— 两个域名的可达性互不相关。
            // 代价是会消耗未认证配额（60 次/小时），但总比"装不上"好。
            if (!(err instanceof NetworkError)) throw err;
            logger.warn(
                `raw.githubusercontent.com unreachable for ${id}, ` +
                    `falling back to the contents API`,
                err
            );
        }

        const query = refName ? `?ref=${encodeURIComponent(refName)}` : "";
        const fallback = await httpRequest({
            url: `${API_BASE}/repos/${id}/contents/${encodedPath}${query}`,
            headers: { ...this.baseHeaders(), Accept: "application/vnd.github.raw" },
        });
        if (fallback.status === 404) return undefined;
        if (fallback.status !== 200) {
            this.fail(fallback.status, fallback.headers, fallback.text, ref, `reading ${path}`);
        }
        return fallback.text;
    }

    async validateToken(token: string): Promise<TokenInfo> {
        const res = await httpJson<GitHubUser>({
            url: `${API_BASE}/user`,
            headers: this.headers(token),
        });
        if (res.status === 200 && res.data?.login) {
            return { valid: true, account: res.data.login };
        }
        if (res.status === 401 || res.status === 403) return { valid: false };
        // 其他状态（例如网络问题被降级）不应误报令牌无效，但接口只能返回 TokenInfo，
        // 所以这里保守地返回 false —— 调用方会提示"无效或已过期"。
        if (res.status === 404) throw new NotFoundError("GitHub /user endpoint not reachable.");
        return { valid: false };
    }

    applyAuth(url: string, token: string): AuthResult {
        return { url, headers: { Authorization: `Bearer ${token}` } };
    }
}
