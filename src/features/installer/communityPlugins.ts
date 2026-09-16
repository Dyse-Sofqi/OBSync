import { logger } from "../../core/logger";
import { InstallerError } from "./errors";
import { httpJson } from "../../host/http";

/**
 * Obsidian 官方社区插件索引。
 *
 * 这是 GitHub 侧独有的资源 —— Obsidian 官方只维护一份
 * `community-plugins.json`，托管在 `obsidianmd/obsidian-releases` 仓库里，
 * **Gitee 没有任何等价物**。所以「浏览社区插件」这个功能只对 GitHub 源有效，
 * Gitee 侧只能靠用户手输地址。
 *
 * 实测（2026-09）：7685 个插件，条目字段为
 * `{ id, name, author, description, repo }`。
 */

const COMMUNITY_PLUGINS_URL =
    "https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json";
const COMMUNITY_STATS_URL =
    "https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugin-stats.json";

/** 索引缓存时长。这个文件变化很慢，没必要每次开弹窗都拉一遍。 */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

export interface CommunityPlugin {
    id: string;
    name: string;
    author: string;
    description: string;
    /** `owner/repo`。 */
    repo: string;
    /** 下载量。拿不到统计文件时为 undefined。 */
    downloads?: number;
}

interface RawEntry {
    id?: unknown;
    name?: unknown;
    author?: unknown;
    description?: unknown;
    repo?: unknown;
}

export class CommunityPluginIndex {
    private plugins: CommunityPlugin[] = [];
    private fetchedAt = 0;
    /** 预热好的小写检索串，避免每次搜索都对 7000+ 条目做 toLowerCase。 */
    private haystacks: string[] = [];
    private loading: Promise<CommunityPlugin[]> | undefined;

    get isLoaded(): boolean {
        return this.plugins.length > 0;
    }

    get size(): number {
        return this.plugins.length;
    }

    /** 按官方插件 id 查索引条目（未加载或不存在时为 undefined）。 */
    byId(id: string): CommunityPlugin | undefined {
        return this.plugins.find((plugin) => plugin.id === id);
    }

    /** 拉取索引。并发调用只会真正请求一次。 */
    async load(force = false): Promise<CommunityPlugin[]> {
        const fresh = Date.now() - this.fetchedAt < CACHE_TTL_MS;
        if (!force && this.plugins.length > 0 && fresh) return this.plugins;
        if (this.loading) return this.loading;

        this.loading = this.fetchAll().finally(() => {
            this.loading = undefined;
        });
        return this.loading;
    }

    private async fetchAll(): Promise<CommunityPlugin[]> {
        const [pluginsResponse, statsResponse] = await Promise.all([
            httpJson<RawEntry[]>({ url: COMMUNITY_PLUGINS_URL }),
            // 统计文件是可选的：拿不到就不显示下载量，不影响浏览。
            httpJson<Record<string, { downloads?: number }>>({ url: COMMUNITY_STATS_URL }).catch(
                (err: unknown) => {
                    logger.debug("community plugin stats unavailable", err);
                    return undefined;
                }
            ),
        ]);

        if (pluginsResponse.status !== 200 || !Array.isArray(pluginsResponse.data)) {
            throw new InstallerError({
                kind: "communityIndexFailed",
                status: pluginsResponse.status,
            });
        }

        const stats = statsResponse?.data;

        // 用显式循环而不是 filter + type predicate：这里要同时做字段收窄
        // 和缺省值填充，拆成两步反而更绕。
        this.plugins = [];
        for (const entry of pluginsResponse.data) {
            if (
                typeof entry?.id !== "string" ||
                typeof entry?.name !== "string" ||
                typeof entry?.repo !== "string"
            ) {
                continue;
            }

            const downloads = stats?.[entry.id]?.downloads;

            this.plugins.push({
                id: entry.id,
                name: entry.name,
                author: typeof entry.author === "string" ? entry.author : "",
                description: typeof entry.description === "string" ? entry.description : "",
                repo: entry.repo,
                downloads: typeof downloads === "number" ? downloads : undefined,
            });
        }

        this.haystacks = this.plugins.map((plugin) =>
            `${plugin.id} ${plugin.name} ${plugin.author} ${plugin.description} ${plugin.repo}`.toLowerCase()
        );
        this.fetchedAt = Date.now();

        logger.info(`community plugin index loaded: ${this.plugins.length} entries`);
        return this.plugins;
    }

    /**
     * 按关键词检索。
     *
     * 空查询返回下载量最高的若干条 —— 打开弹窗时给用户一个「热门」列表，
     * 比给一个 7000 条的空列表有用。
     */
    search(query: string, limit = 50): CommunityPlugin[] {
        const trimmed = query.trim().toLowerCase();

        if (!trimmed) {
            return this.byPopularity(limit);
        }

        const terms = trimmed.split(/\s+/);
        const matches: CommunityPlugin[] = [];

        for (let index = 0; index < this.plugins.length; index++) {
            const haystack = this.haystacks[index]!;
            if (terms.every((term) => haystack.includes(term))) {
                matches.push(this.plugins[index]!);
            }
        }

        return matches
            .sort((a, b) => score(b, terms) - score(a, terms) || byDownloads(a, b))
            .slice(0, limit);
    }

    private byPopularity(limit: number): CommunityPlugin[] {
        return [...this.plugins].sort(byDownloads).slice(0, limit);
    }
}

function byDownloads(a: CommunityPlugin, b: CommunityPlugin): number {
    return (b.downloads ?? 0) - (a.downloads ?? 0);
}

/** 名称/作者命中的排在描述命中的前面。 */
function score(plugin: CommunityPlugin, terms: string[]): number {
    const name = plugin.name.toLowerCase();
    const id = plugin.id.toLowerCase();
    let total = 0;
    for (const term of terms) {
        if (name.includes(term)) total += 3;
        if (id.includes(term)) total += 2;
        if (plugin.author.toLowerCase().includes(term)) total += 1;
    }
    return total;
}
