import { logger } from "../../core/logger";
import { tryParseRepoRef } from "../../host/repoRef";
import type { HostKind, RepoRef } from "../../host/types";

/**
 * 官方社区索引的公共骨架。
 *
 * 插件索引（`community-plugins.json`）与主题索引（`community-css-themes.json`）
 * 都托管在 `obsidianmd/obsidian-releases` 里，用法上**没有一处需要分叉**：
 * 缓存 6 小时、并发只真正拉一次、失败抛出同一个类型码。子类只提供「从哪个 URL
 * 拉、怎么解析、日志里叫什么」。
 *
 * 抽出来的动机与「有哪些平台」那件事一样：同一个事实写两遍，早晚只有一份是对的。
 * 「并发去重」和「失败不缓存」这类细节一旦抄漏，症状是打光平台配额 ——
 * 只在用户那边偶发，最难查。
 */

/** 索引缓存时长。这两个文件变化很慢，没必要每次开弹窗都拉一遍。 */
export const INDEX_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

export abstract class RemoteIndex<T> {
    private entries: T[] = [];
    private fetchedAt = 0;
    private loading: Promise<T[]> | undefined;

    /** 日志里用的名字，例如 `community plugin index`。 */
    protected abstract readonly label: string;

    get isLoaded(): boolean {
        return this.entries.length > 0;
    }

    get size(): number {
        return this.entries.length;
    }

    /** 已加载的条目；未加载时为空数组。 */
    protected get items(): T[] {
        return this.entries;
    }

    /** 拉取索引。并发调用只会真正请求一次。 */
    async load(force = false): Promise<T[]> {
        const fresh = Date.now() - this.fetchedAt < INDEX_CACHE_TTL_MS;
        // 「一次都没拉到条目」不算缓存命中 —— 否则一次网络抖动会让这个功能
        // 在**整个会话**里都返回空列表，而用户看到的只是「什么都没搜到」。
        if (!force && this.entries.length > 0 && fresh) return this.entries;
        if (this.loading) return this.loading;

        this.loading = this.fetchIndex()
            .then((entries) => {
                this.entries = entries;
                this.fetchedAt = Date.now();
                logger.info(`${this.label} loaded: ${entries.length} entries`);
                return entries;
            })
            .finally(() => {
                this.loading = undefined;
            });

        return this.loading;
    }

    /**
     * 真正去拉并解析。
     *
     * 失败必须**抛错**，不能返回空数组 —— 后者会被上层当成「索引里就是没有这一条」，
     * 于是「来源未识别」变成一个看不出原因的结论。
     */
    protected abstract fetchIndex(): Promise<T[]>;
}

/**
 * 官方索引里的 `owner/repo` → RepoRef。
 *
 * 索引只覆盖 GitHub 仓库（Obsidian 官方只维护这一份，Gitee 没有等价物），
 * 所以平台写死 github 而不是去猜 —— 插件与主题两个索引共用这一处。
 */
export function communityRepoRef(repo: string): RepoRef | undefined {
    const ref = tryParseRepoRef(repo, "github");
    if (!ref) return undefined;
    return { host: "github" satisfies HostKind, owner: ref.owner, repo: ref.repo };
}
