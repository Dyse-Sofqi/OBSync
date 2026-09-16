import { logger } from "../../core/logger";
import { RateLimitError } from "../../host/errors";
import { getHost } from "../../host/hostRegistry";
import { formatRepoId } from "../../host/repoRef";
import type { RepoRef } from "../../host/types";
import type { InstallerService } from "./installerService";
import type { TrackedPlugin, UpdateCheckResult } from "./types";
import { isNewerVersion } from "./versions";

/**
 * 更新检查。
 *
 * 参考项目 BRAT 只在启动后延迟 60 秒跑一次，没有定时器，且遍历时
 * 跳过冻结项（`version !== "latest"`）。这里保持一致的行为，
 * 但把「检查」与「执行更新」拆开 —— 用户应该先看到「哪些插件有更新」，
 * 再决定要不要装，而不是插件替他决定。
 */

export interface UpdateCheckSummary {
    results: UpdateCheckResult[];
    /** 有更新的条数。 */
    outdated: number;
    /** 检查失败的条数（通常是限流或网络问题）。 */
    failed: number;
}

export class UpdateChecker {
    constructor(private readonly service: InstallerService) {}

    /** 检查所有非冻结的已跟踪插件。 */
    async checkAll(tracked: TrackedPlugin[]): Promise<UpdateCheckSummary> {
        const results: UpdateCheckResult[] = [];

        for (const plugin of tracked) {
            if (plugin.frozen) continue;
            results.push(await this.checkOne(plugin));
        }

        return {
            results,
            outdated: results.filter((result) => result.hasUpdate).length,
            failed: results.filter((result) => result.error !== undefined).length,
        };
    }

    async checkOne(plugin: TrackedPlugin): Promise<UpdateCheckResult> {
        const repoRef: RepoRef = {
            host: plugin.host,
            owner: plugin.owner,
            repo: plugin.repo,
        };

        try {
            const host = getHost(plugin.host);
            const latest = await host.getLatestRelease(repoRef);

            if (!latest) {
                // 没有 release 的仓库（Gitee 上很常见）无法判断版本 ——
                // 这不是错误，只是「无从比较」。
                return {
                    tracked: plugin,
                    latestVersion: plugin.installedVersion,
                    hasUpdate: false,
                };
            }

            return {
                tracked: plugin,
                latestVersion: latest.tag,
                hasUpdate: isNewerVersion(latest.tag, plugin.installedVersion),
            };
        } catch (err) {
            logger.warn(`update check failed for ${formatRepoId(repoRef)}`, err);
            return {
                tracked: plugin,
                latestVersion: plugin.installedVersion,
                hasUpdate: false,
                error:
                    err instanceof RateLimitError
                        ? `${getHost(plugin.host).displayName} 接口调用次数已达上限`
                        : err instanceof Error
                          ? err.message
                          : String(err),
            };
        }
    }

    /**
     * 执行更新。
     *
     * 逐个串行执行 —— 并发更新会在 Obsidian 的插件管理 API 上打架
     * （每个更新都会触发一次 `loadManifests`）。
     */
    async updateAll(results: UpdateCheckResult[]): Promise<{
        updated: TrackedPlugin[];
        failed: Array<{ tracked: TrackedPlugin; error: string }>;
    }> {
        const updated: TrackedPlugin[] = [];
        const failed: Array<{ tracked: TrackedPlugin; error: string }> = [];

        for (const result of results) {
            if (!result.hasUpdate) continue;
            try {
                await this.service.install({
                    repo: formatRepoId(result.tracked),
                    version: "latest",
                    enableAfterInstall: true,
                    defaultHost: result.tracked.host,
                });
                updated.push(result.tracked);
            } catch (err) {
                failed.push({
                    tracked: result.tracked,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }

        return { updated, failed };
    }
}
