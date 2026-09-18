import { logger } from "../../core/logger";
import { RateLimitError } from "../../host/errors";
import { getHost } from "../../host/hostRegistry";
import { formatRepoId } from "../../host/repoRef";
import type { HostKind, RepoRef } from "../../host/types";
import type { DownloadSource } from "./downloadSource";
import type { InstallerService } from "./installerService";
import { parseThemeManifest } from "./manifest";
import { SELF_REPO } from "./selfUpdate";
import {
    itemRepoRef,
    MANIFEST_FILE,
    type SelfUpdateCheck,
    type TrackedItem,
    type TrackedPlugin,
    type TrackedTheme,
    type UpdateCheckResult,
} from "./types";
import { isNewerVersion } from "./versions";

/**
 * 更新检查。
 *
 * 参考项目 BRAT 只在启动后延迟 60 秒跑一次，没有定时器，且遍历时
 * 跳过冻结项（`version !== "latest"`）。这里保持一致的行为，
 * 但把「检查」与「执行更新」拆开 —— 用户应该先看到「哪些插件有更新」，
 * 再决定要不要装，而不是插件替他决定。
 *
 * 插件与主题的判据同构（远端版本 vs 本地已装版本），但**取远端版本的方式不同**：
 * 主题多一级回退，见 `checkTheme`。
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
     * 检查所有非冻结的跟踪对象（插件与主题一起）。
     *
     * 结果会写进 `installer.availableUpdates` 并落盘 —— 已跟踪列表的
     * 常驻徽标靠它渲染（见 InstallerService.recordUpdateChecks）。
     */
    async checkAll(tracked: TrackedItem[]): Promise<UpdateCheckSummary> {
        const results: UpdateCheckResult[] = [];

        for (const item of tracked) {
            if (item.frozen) continue;
            results.push(await this.checkOne(item));
        }

        await this.service.recordUpdateChecks(results);

        return {
            results,
            outdated: results.filter((result) => result.hasUpdate).length,
            failed: results.filter((result) => result.error !== undefined).length,
        };
    }

    async checkOne(item: TrackedItem): Promise<UpdateCheckResult> {
        return item.kind === "theme" ? this.checkTheme(item) : this.checkPlugin(item);
    }

    /**
     * 检查 OBSync 自己有没有新版本。
     *
     * 与插件同构（远端最新版本 vs 运行中的版本），但不写 `availableUpdates` ——
     * 它不是跟踪列表里的一项，那张表是「谁该有徽标」的事实来源。
     *
     * 比较用**运行中**的版本：待重启期间磁盘上已经躺着更新的一份，
     * 拿磁盘那份去比会得到「已是最新」，而用户此刻跑的还不是它 ——
     * 那个状态由待重启标记单独表达，不混进检查结果。
     */
    async checkSelf(currentVersion: string, repoRef: RepoRef = SELF_REPO): Promise<SelfUpdateCheck> {
        try {
            const token = this.service.tokenForHost(repoRef.host);
            const latest = await this.latestReleaseTag(repoRef, token);

            if (!latest) {
                // 一个 release 都没有：OBSync 的 `main.js` 是构建产物（不入库），
                // 源码通道取不到它 —— 所以这里如实说「无从比较」，不是错误。
                return {
                    currentVersion,
                    latestVersion: currentVersion,
                    hasUpdate: false,
                };
            }

            return {
                currentVersion,
                latestVersion: latest,
                hasUpdate: isNewerVersion(latest, currentVersion),
            };
        } catch (err) {
            logger.warn(`self update check failed for ${formatRepoId(repoRef)}`, err);
            return {
                currentVersion,
                latestVersion: currentVersion,
                hasUpdate: false,
                error: this.errorText(repoRef.host, err),
            };
        }
    }

    /**
     * 远端「最新版本」的口径：正式版 → 预发布版。
     *
     * 抽出来是因为它必须与安装路径一致：`/releases/latest` 只给正式版，
     * 而「只发预发布版」的仓库在安装路径上是能装的（`resolveSource` 的第二级）——
     * 检查若不来这一级，那种仓库就「装得上、却永远报已是最新」（修过的一个真 bug）。
     */
    private async latestReleaseTag(
        repoRef: RepoRef,
        token: string | undefined
    ): Promise<string | undefined> {
        const host = getHost(repoRef.host);
        const latest = await host.getLatestRelease(repoRef, token);
        if (latest) return latest.tag;

        return (await host.listReleases(repoRef, { token, limit: 20 }))[0]?.tag;
    }

    private async checkPlugin(plugin: TrackedPlugin): Promise<UpdateCheckResult> {
        // 检查要打在**实际使用**的来源上（走镜像时即镜像）—— 与安装路径同源。
        // 改用 `item.origin`（源仓库）会让「检查 GitHub、下载 Gitee」分叉：
        // 镜像的版本常落后于源仓库，那就会反复报「有更新」而每次更新都装回同一个版本。
        const repoRef: RepoRef = itemRepoRef(plugin);

        try {
            // 与安装路径同一套凭据 —— 理由见 `InstallerService.tokenForHost`。
            const token = this.service.tokenForHost(plugin.host);
            // 正式版 → 预发布版，与安装路径 `resolveSource` 同一口径（见 latestReleaseTag）。
            const latest = await this.latestReleaseTag(repoRef, token);

            if (!latest) {
                // 一个 release 都没有（Gitee 上很常见）无法判断版本 ——
                // 这不是错误，只是「无从比较」。
                //
                // 这里的边界是**真实存在**的，不是没往下想：安装路径此时会退到
                // 源码 HEAD（第三级），而「HEAD 上是不是更新」要多读一次
                // manifest.json —— 每个插件每次检查都多一次请求，与上面刚说过的
                // 配额顾虑直接冲突。所以停在这里，把缺口如实记下。
                //
                // （主题那边反过来：它的生态就是「只推仓库、不发 release」，
                // 所以必须读那一次 —— 见 checkTheme。）
                return {
                    tracked: plugin,
                    latestVersion: plugin.installedVersion,
                    hasUpdate: false,
                };
            }

            return {
                tracked: plugin,
                latestVersion: latest,
                hasUpdate: isNewerVersion(latest, plugin.installedVersion),
            };
        } catch (err) {
            logger.warn(`update check failed for ${formatRepoId(repoRef)}`, err);
            return this.failure(plugin, err);
        }
    }

    /**
     * 主题的更新判据。
     *
     * 与插件同构（远端版本 vs 本地已装版本），但**多一级回退**：没有 release 时
     * 读默认分支的 `manifest.json` 取 `version`。
     *
     * 为什么插件停在第二级、主题要往下走一级：
     *
     * - 插件停下的理由是**配额** —— 每个插件每次检查多一次请求，而 Gitee 的匿名
     *   配额极低（项目为此专门做了 10 分钟节流）；
     * - 主题的生态不是这样：主题常常只有仓库、不发 release，而它们的 manifest 里
     *   **确实写着 version**（实测 kepano/obsidian-minimal → 9.1.0、
     *   colineckert/obsidian-things → 2.2.4、AnubisNekhet/AnuPpuccin → 1.5.0）。
     *   不读这一级，「只推仓库不发 release」的主题就永远收不到更新提示 ——
     *   正是插件侧刚修过的那类 bug（能装上、却没有更新）。
     *
     * 代价是「没有 release 的主题每次检查多一次 raw 请求」：raw 域名不消耗 API
     * 配额，主题数量也远小于插件，这个代价可以接受。
     *
     * 另一个边界：远端 manifest 里的 version 若长期不涨而 CSS 在变，版本判据会漏报。
     * 这与插件侧是同一套语义（以作者声明的版本为准），已记在交接文档里。
     */
    private async checkTheme(theme: TrackedTheme): Promise<UpdateCheckResult> {
        const repoRef = itemRepoRef(theme);

        try {
            const host = getHost(theme.host);
            const token = this.service.tokenForHost(theme.host);
            const latest = await this.latestReleaseTag(repoRef, token);

            if (latest) {
                return {
                    tracked: theme,
                    latestVersion: latest,
                    hasUpdate: isNewerVersion(latest, theme.installedVersion),
                };
            }

            const raw = await host.readFile(repoRef, MANIFEST_FILE, { token, ref: "HEAD" });
            if (raw === undefined) {
                // 连默认分支的 manifest 都读不到：无从比较，不是错误。
                return {
                    tracked: theme,
                    latestVersion: theme.installedVersion,
                    hasUpdate: false,
                };
            }

            const manifest = parseThemeManifest(raw, formatRepoId(repoRef));
            return {
                tracked: theme,
                latestVersion: manifest.version,
                hasUpdate: isNewerVersion(manifest.version, theme.installedVersion),
            };
        } catch (err) {
            logger.warn(`update check failed for ${formatRepoId(repoRef)}`, err);
            return this.failure(theme, err);
        }
    }

    /** 检查失败的结果。两种 kind 共用，错误文案只有一处。 */
    private failure(tracked: TrackedItem, err: unknown): UpdateCheckResult {
        return {
            tracked,
            latestVersion: tracked.installedVersion,
            hasUpdate: false,
            error: this.errorText(tracked.host, err),
        };
    }

    /** 失败原因的用户可读文本：限流单独说清（那是要用户配令牌的场景），其余用原始消息。 */
    private errorText(host: HostKind, err: unknown): string {
        return err instanceof RateLimitError
            ? this.t.installer.errors.rateLimited(getHost(host).displayName)
            : err instanceof Error
              ? err.message
              : String(err);
    }

    /**
     * 执行更新。
     *
     * 逐个串行执行 —— 并发更新会在 Obsidian 的插件管理 API 上打架
     * （每个更新都会触发一次 `loadManifests`），主题那边也会同时写同一批文件。
     *
     * 每个更新成功的条目连同**它实际用的来源**一起返回：调用方要能在提示里说清
     * 「这次是从 GitHub 还是 Gitee 拿的」（可能就是这一趟才发现的镜像）。
     */
    async updateAll(results: UpdateCheckResult[]): Promise<{
        updated: Array<{ tracked: TrackedItem; source: DownloadSource }>;
        failed: Array<{ tracked: TrackedItem; error: string }>;
    }> {
        const updated: Array<{ tracked: TrackedItem; source: DownloadSource }> = [];
        const failed: Array<{ tracked: TrackedItem; error: string }> = [];

        for (const result of results) {
            if (!result.hasUpdate) continue;
            try {
                const outcome =
                    result.tracked.kind === "theme"
                        ? // 主题走 updateTheme：不碰当前主题选择，也不做 enable/reload。
                          await this.service.updateTheme(result.tracked)
                        : // 插件走 install，且**明确取 latest** —— 不能用 reinstall：
                          // 后者会重装用户钉住的那个 tag（`requestedVersion`），
                          // 而「更新全部」的语义是装到最新。
                          await this.service.install({
                              repo: formatRepoId(result.tracked),
                              version: "latest",
                              enableAfterInstall: true,
                              defaultHost: result.tracked.host,
                          });
                updated.push({
                    tracked: result.tracked,
                    source: { repoRef: outcome.repoRef, origin: outcome.origin },
                });
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
