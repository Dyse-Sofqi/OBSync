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

/**
 * 「进入设置页自动检查」的最小间隔：10 分钟。
 *
 * 设置页每次打开都会触发一次机会，但用户可能反复开合（改个设置、看一眼列表）。
 * 没有这个节流，Gitee 那种匿名配额极低的平台会立刻被 403。
 */
export const SETTINGS_OPEN_CHECK_INTERVAL_MS = 10 * 60 * 1000;

/**
 * 判断这次打开设置页要不要跑自动检查。
 *
 * 做成纯函数是为了能单测 —— 真正的触发点在设置页里（依赖 Obsidian 的
 * display/hide 时序，node 环境测不了）。
 */
export function shouldCheckOnSettingsOpen(input: {
    enabled: boolean;
    autoCheckOnSettingsOpen: boolean;
    trackedCount: number;
    lastCheckAt: number;
    now: number;
    intervalMs?: number;
}): boolean {
    if (!input.enabled) return false;
    if (!input.autoCheckOnSettingsOpen) return false;
    if (input.trackedCount === 0) return false;

    const interval = input.intervalMs ?? SETTINGS_OPEN_CHECK_INTERVAL_MS;
    const elapsed = input.now - input.lastCheckAt;
    // lastCheckAt 为 0（从未检查过）时 elapsed 极大 → 放行。
    return elapsed >= interval;
}

export class UpdateChecker {
    constructor(private readonly service: InstallerService) {}

    /** 本模块有 `t` 的访问路径（经 service 的依赖），提示文案直接在这里拼。 */
    private get t() {
        return this.service.deps.getT();
    }

    /**
     * 检查所有非冻结的已跟踪插件。
     *
     * 结果会写进 `installer.availableUpdates` 并落盘 —— 已跟踪列表的
     * 常驻徽标靠它渲染（见 InstallerService.recordUpdateChecks）。
     */
    async checkAll(tracked: TrackedPlugin[]): Promise<UpdateCheckSummary> {
        const results: UpdateCheckResult[] = [];

        for (const plugin of tracked) {
            if (plugin.frozen) continue;
            results.push(await this.checkOne(plugin));
        }

        await this.service.recordUpdateChecks(results);

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
                        ? this.t.installer.errors.rateLimited(
                              getHost(plugin.host).displayName
                          )
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
