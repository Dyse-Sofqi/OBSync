import { encodePathSegments, getHeader, httpJson, httpRequest } from "./http";
import type {
    DownloadAssetOptions,
    IRepoHost,
    ListReleasesOptions,
    ReadFileOptions,
} from "./IRepoHost";
import { parseRateLimitReset } from "./IRepoHost";
import { formatRepoId, repoWebUrl } from "./repoRef";
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
 * Gitee 实现。
 *
 * 字段名与 GitHub 高度同构（实测确认，见 docs/reference-analysis.md 3.1），
 * 但有五处必须显式处理的差异：
 *
 * 1. **releases 列表默认升序**。GitHub 默认最新在前，Gitee 默认最旧在前。
 *    实测：不传 `direction` 时 `mindspore/mindspore` 首个返回的是 2020 年的
 *    `v0.1.0-alpha`，传 `direction=desc` 才是 2026 年的 `v2.7.2`。
 *    直接照搬 GitHub 逻辑会静默安装一个六年前的版本。
 * 2. **令牌走查询参数**（`?access_token=`），不是 `Authorization` 请求头。
 * 3. **API raw 端点对匿名请求不可用** —— 即使公开仓库也返回 401
 *    （"登录失效，无权限访问该资源"）。匿名读文件必须走网页 raw 通道。
 * 4. **没有社区插件索引**，所以安装器的"浏览社区插件"功能对 Gitee 不可用。
 * 5. **多数仓库没有 release**，安装器必须能回退到源码文件通道。
 */

const API_BASE = "https://gitee.com/api/v5";

interface GiteeAsset {
    id: number;
    name: string;
    size: number;
    browser_download_url: string;
}

interface GiteeRelease {
    id: number;
    tag_name: string;
    name: string | null;
    prerelease: boolean;
    created_at: string;
    assets: GiteeAsset[] | null;
}

interface GiteeRepo {
    default_branch: string;
    private: boolean;
    description: string | null;
    html_url: string;
}

interface GiteeUser {
    login: string;
}

function mapRelease(raw: GiteeRelease): Release {
    return {
        id: String(raw.id),
        tag: raw.tag_name,
        name: raw.name ?? raw.tag_name,
        prerelease: Boolean(raw.prerelease),
        // Gitee 的 Release 定义里没有 published_at，用 created_at 代替。
        publishedAt: raw.created_at,
        assets: (raw.assets ?? []).map(
            (asset): ReleaseAsset => ({
                id: String(asset.id),
                name: asset.name,
                size: asset.size,
                downloadUrl: asset.browser_download_url,
            })
        ),
    };
}

/** 把令牌拼进查询串。Gitee 的鉴权方式就是这样，没有请求头方案。 */
function withToken(url: string, token?: string): string {
    if (!token) return url;
    const separator = url.includes("?") ? "&" : "?";
    return `${url}${separator}access_token=${encodeURIComponent(token)}`;
}

export class GiteeHost implements IRepoHost {
    readonly kind: HostKind = "gitee";
    readonly displayName = "Gitee";
    readonly webBaseUrl = "https://gitee.com";
    readonly apiBaseUrl = API_BASE;
    readonly tokenInQuery = true;
    /**
     * Gitee 只接受 账号名 / `oauth2` / `gitee.com` 三种用户名（见 IRepoHost 的说明）。
     * 用 `oauth2` 是因为它**恒定可用**，不需要先查一次账号名。
     */
    readonly gitAuthUsername = "oauth2";

    private baseHeaders(): Record<string, string> {
        return {
            Accept: "application/json",
            "User-Agent": "OBSync",
        };
    }

    /**
     * Gitee 的限流判定。
     *
     * 与 GitHub 不同，Gitee 不保证返回 `x-ratelimit-*` 响应头，超限时可能只是
     * 一个 403 + 中文提示。所以这里除了看状态码，还要看响应体里的关键词。
     * 这个启发式不完美，但比"把所有 403 都当成权限错误"更接近事实。
     */
    private isRateLimited(status: number, headers: Record<string, string>, text: string): boolean {
        if (status === 429) return true;
        if (status !== 403) return false;

        const remaining = getHeader(headers, "x-ratelimit-remaining");
        if (remaining === "0") return true;

        const lower = text.toLowerCase();
        return (
            lower.includes("rate limit") ||
            lower.includes("too many request") ||
            text.includes("请求过于频繁") ||
            text.includes("超过限制") ||
            text.includes("访问频率")
        );
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
            isRateLimited: this.isRateLimited(status, headers, text),
            resetAt: parseRateLimitReset(headers),
            action,
        });
    }

    async getRepoMeta(ref: RepoRef, token?: string): Promise<RepoMeta> {
        const id = formatRepoId(ref);
        const res = await httpJson<GiteeRepo>({
            url: withToken(`${API_BASE}/repos/${id}`, token),
            headers: this.baseHeaders(),
        });
        if (res.status !== 200 || !res.data) {
            this.fail(res.status, res.headers, res.text, ref, "reading repository metadata");
        }
        return {
            ref,
            defaultBranch: res.data.default_branch,
            isPrivate: res.data.private,
            description: res.data.description ?? undefined,
            // 实测：Gitee 的 html_url 带 `.git` 后缀
            // （如 https://gitee.com/mindspore/mindspore.git），GitHub 不带。
            // 不处理的话用户会看到带 .git 的链接。
            webUrl: (res.data.html_url ?? repoWebUrl(ref)).replace(/\.git$/, ""),
        };
    }

    async listReleases(ref: RepoRef, options: ListReleasesOptions = {}): Promise<Release[]> {
        const { token, limit = 100, includePrerelease = true } = options;
        const id = formatRepoId(ref);
        const perPage = Math.min(100, Math.max(1, limit));

        const collected: Release[] = [];
        let page = 1;

        while (collected.length < limit) {
            // `direction=desc` 是必须的：Gitee 默认升序，不传会拿到最旧的版本。
            const url = withToken(
                `${API_BASE}/repos/${id}/releases?per_page=${perPage}&page=${page}&direction=desc`,
                token
            );
            const res = await httpJson<GiteeRelease[]>({
                url,
                headers: this.baseHeaders(),
            });
            if (res.status !== 200) {
                this.fail(res.status, res.headers, res.text, ref, "listing releases");
            }

            const batch = res.data ?? [];
            if (batch.length === 0) break;

            for (const raw of batch) {
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
        const res = await httpJson<GiteeRelease>({
            url: withToken(
                `${API_BASE}/repos/${id}/releases/tags/${encodeURIComponent(tag)}`,
                token
            ),
            headers: this.baseHeaders(),
        });
        if (res.status === 404) return undefined;
        if (res.status !== 200 || !res.data) {
            this.fail(res.status, res.headers, res.text, ref, `reading release ${tag}`);
        }
        return mapRelease(res.data);
    }

    async getLatestRelease(ref: RepoRef, token?: string): Promise<Release | undefined> {
        const id = formatRepoId(ref);
        const res = await httpJson<GiteeRelease>({
            url: withToken(`${API_BASE}/repos/${id}/releases/latest`, token),
            headers: this.baseHeaders(),
        });
        // Gitee 上大量插件仓库从未发布过 release，404 是常见且正常的状态。
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
        const { token, release } = options;
        const id = formatRepoId(ref);

        // 私有仓库：browser_download_url 需要登录态，走 API 附件端点。
        if (token && release?.id && asset.id) {
            const res = await httpRequest({
                url: withToken(
                    `${API_BASE}/repos/${id}/releases/${release.id}/attach_files/${asset.id}/download`,
                    token
                ),
                headers: this.baseHeaders(),
            });
            if (res.status !== 200) {
                this.fail(res.status, res.headers, res.text, ref, `downloading ${asset.name}`);
            }
            return res.arrayBuffer;
        }

        const res = await httpRequest({
            url: withToken(asset.downloadUrl, token),
            headers: this.baseHeaders(),
        });
        if (res.status !== 200) {
            this.fail(res.status, res.headers, res.text, ref, `downloading ${asset.name}`);
        }
        return res.arrayBuffer;
    }

    /**
     * 读取文件内容。
     *
     * 这里有两条**实测出来的**关键约束：
     *
     * 1. API raw 端点（`/v5/repos/{o}/{r}/raw/{path}`）对匿名请求一律返回 401
     *    （响应体："登录失效，无权限访问该资源"），**即使是公开仓库**。
     *    所以匿名访问只能走网页 raw 通道：
     *
     *        https://gitee.com/{owner}/{repo}/raw/{ref}/{path}
     *        → 302 → raw.giteeusercontent.com/...
     *
     * 2. 网页通道接受 `HEAD` 作为「默认分支」的写法（实测 200）。
     *    这一点很重要：Gitee 的匿名 API 配额极低（实测连续请求后会直接
     *    403 Rate Limit Exceeded，且一分钟内不恢复），所以能省一次 API 调用就省一次 ——
     *    不必先查 `getRepoMeta` 拿默认分支。
     */
    async readFile(
        ref: RepoRef,
        path: string,
        options: ReadFileOptions = {}
    ): Promise<string | undefined> {
        const { token, ref: refName } = options;
        const id = formatRepoId(ref);
        const encodedPath = encodePathSegments(path);

        // 有令牌才走 API 通道 —— 这是访问私有仓库的唯一途径。
        if (token) {
            const refQuery = refName ? `?ref=${encodeURIComponent(refName)}` : "";
            const res = await httpRequest({
                url: withToken(
                    `${API_BASE}/repos/${id}/raw/${encodedPath}${refQuery}`,
                    token
                ),
                headers: this.baseHeaders(),
            });
            if (res.status === 200) return res.text;
            // 404 交给下面的网页通道再试一次；其他状态直接报错。
            if (res.status !== 404) {
                this.fail(res.status, res.headers, res.text, ref, `reading ${path}`);
            }
        }

        const refSegment = encodePathSegments(refName ?? "HEAD");
        const res = await httpRequest({
            url: `https://gitee.com/${id}/raw/${refSegment}/${encodedPath}`,
        });
        if (res.status === 404) return undefined;
        if (res.status !== 200) {
            this.fail(res.status, res.headers, res.text, ref, `reading ${path}`);
        }
        return res.text;
    }

    async validateToken(token: string): Promise<TokenInfo> {
        const res = await httpJson<GiteeUser>({
            url: withToken(`${API_BASE}/user`, token),
            headers: this.baseHeaders(),
        });
        if (res.status === 200 && res.data?.login) {
            return { valid: true, account: res.data.login };
        }
        return { valid: false };
    }

    applyAuth(url: string, token: string): AuthResult {
        return { url: withToken(url, token), headers: this.baseHeaders() };
    }
}
