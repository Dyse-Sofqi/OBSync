import type { App } from "obsidian";
import { requireApiVersion } from "obsidian";
import type { LocaleStrings } from "../../core/i18n";
import { logger } from "../../core/logger";
import type { Notifier } from "../../core/notice";
import type { ObsyncSettings } from "../../core/settings";
import type { SecretStore } from "../../core/secretStore";
import { RateLimitError } from "../../host/errors";
import { getHost } from "../../host/hostRegistry";
import { formatRepoId, parseRepoRef } from "../../host/repoRef";
import type { HostKind, Release, RepoRef } from "../../host/types";
import { InstallerError } from "./errors";
import { findGiteeMirror } from "./mirrorFinder";
import { fetchPluginFiles } from "./pluginFiles";
import {
    createBackup,
    disablePlugin,
    enablePlugin,
    isPluginEnabled,
    readInstalledManifest,
    refreshPluginManifests,
    reloadPlugin,
    removePluginFolder,
    writePluginFiles,
} from "./pluginFolder";
import type { InstallResult, InstallSource, TrackedPlugin, UpdateCheckResult } from "./types";

/**
 * 安装编排。
 *
 * 一次安装的完整链路：
 *   解析仓库 → （可选）镜像发现 → 解析安装目标 → 取文件 → 兼容性检查
 *   → 备份 → 写盘 → 启用/重载 → 记录
 *
 * 与参考项目 BRAT 的三处关键差异：
 * 1. **写入前备份，失败回滚**（BRAT 没有回滚）。
 * 2. **逐文件回退到源码通道**（BRAT 要求三个文件都在 release 资产里）。
 * 3. **API 不可用时降级到源码通道**并明确告知用户 —— Gitee 的匿名 API
 *    配额极低，实测会直接 403 限流，没有这条降级路径就完全装不了。
 */

export interface InstallerHost {
    app: App;
    notifier: Notifier;
    secretStore: SecretStore;
    getSettings(): ObsyncSettings;
    getT(): LocaleStrings;
    saveSettings(): Promise<void>;
}

export interface InstallRequest {
    /** 用户输入的仓库地址（`owner/repo`、URL、scp 形式均可）。 */
    repo: string;
    /** `"latest"` 或具体 tag。 */
    version?: string;
    /** 安装后是否启用。 */
    enableAfterInstall?: boolean;
    /** 是否允许用 Gitee 镜像替换 GitHub 源。 */
    allowMirror?: boolean;
    /** 用于 `owner/repo` 简写时的默认平台。 */
    defaultHost?: HostKind;
}

export interface VersionOption {
    value: string;
    label: string;
    publishedAt?: string;
    prerelease: boolean;
}

/** 安装目标的解析结果，带上「是否降级」的信息。 */
interface ResolvedSource {
    source: InstallSource;
    /** 非空表示发生了降级，内容是要告诉用户的原因。 */
    degradedReason?: string;
}

export class InstallerService {
    constructor(readonly deps: InstallerHost) {}

    private get app(): App {
        return this.deps.app;
    }

    private get settings(): ObsyncSettings {
        return this.deps.getSettings();
    }

    private tokenFor(kind: HostKind): string | undefined {
        return this.deps.secretStore.getToken(kind);
    }

    // ── 解析 ──────────────────────────────────────────────────────────────

    /**
     * 解析用户输入，并按需做 Gitee 镜像发现。
     *
     * 镜像发现用 manifest 的 `id` 做二次校验，而不是只比仓库名 ——
     * 同名不同项目在 Gitee 上很常见，只比名字会装错插件。
     */
    async resolveRepo(
        input: string,
        options: { allowMirror?: boolean; defaultHost?: HostKind } = {}
    ): Promise<{ ref: RepoRef; mirror?: RepoRef }> {
        const ref = parseRepoRef(input, options.defaultHost ?? "github");

        const shouldLookForMirror =
            (options.allowMirror ?? this.settings.installer.discoverGiteeMirrors) &&
            ref.host === "github";

        if (!shouldLookForMirror) return { ref };

        try {
            const mirror = await findGiteeMirror(ref, this.tokenFor("github"));
            if (mirror) {
                logger.info(`using Gitee mirror ${formatRepoId(mirror)} for ${formatRepoId(ref)}`);
                return { ref: mirror, mirror };
            }
        } catch (err) {
            // 镜像发现是「锦上添花」，任何失败都不该阻断安装。
            logger.debug(`mirror discovery failed for ${formatRepoId(ref)}`, err);
        }

        return { ref };
    }

    /** 列出可安装的版本，供版本选择弹窗使用。 */
    async listVersions(repoRef: RepoRef): Promise<VersionOption[]> {
        const host = getHost(repoRef.host);
        const token = this.tokenFor(repoRef.host);
        const releases = await host.listReleases(repoRef, { token, limit: 100 });

        const options: VersionOption[] = [
            { value: "latest", label: this.deps.getT().installer.versionLatest, prerelease: false },
        ];

        for (const release of releases) {
            options.push({
                value: release.tag,
                label: release.tag + (release.prerelease ? " (pre)" : ""),
                publishedAt: release.publishedAt,
                prerelease: release.prerelease,
            });
        }

        return options;
    }

    /**
     * 解析实际要安装的来源。
     *
     * 优先级：指定 tag → 最新正式版 → 最新预发布版 → 源码默认分支。
     * API 调用失败（限流 / 网络）时降级到源码通道，并记录原因。
     */
    private async resolveSource(
        repoRef: RepoRef,
        requestedVersion: string
    ): Promise<ResolvedSource> {
        const token = this.tokenFor(repoRef.host);
        const host = getHost(repoRef.host);

        if (requestedVersion !== "latest") {
            return { source: { kind: "release", tag: requestedVersion, ref: requestedVersion } };
        }

        try {
            const latest = await host.getLatestRelease(repoRef, token);
            if (latest) {
                return { source: { kind: "release", tag: latest.tag, ref: latest.tag } };
            }

            // 没有正式版 —— 看看有没有预发布版（这是 beta 安装的路径）。
            const releases = await host.listReleases(repoRef, { token, limit: 20 });
            const first = releases[0];
            if (first) {
                return { source: { kind: "release", tag: first.tag, ref: first.tag } };
            }

            // 一个 release 都没有：Gitee 上这是常态，不是异常。
            return { source: { kind: "raw", ref: "HEAD" } };
        } catch (err) {
            // 这是一条**提示**（不是异常），所以在这里用 `t` 直接拼 ——
            // 本类持有 `t`，不必绕经错误的翻译器。
            const e = this.deps.getT().installer.errors;
            const reason =
                err instanceof RateLimitError
                    ? e.rateLimitFallback(host.displayName)
                    : e.apiUnavailableFallback(host.displayName);
            logger.warn(`falling back to source files for ${formatRepoId(repoRef)}`, err);
            return { source: { kind: "raw", ref: "HEAD" }, degradedReason: reason };
        }
    }

    // ── 安装 ──────────────────────────────────────────────────────────────

    /** 安装或更新一个插件。 */
    async install(request: InstallRequest): Promise<InstallResult> {
        const t = this.deps.getT();
        const { ref: repoRef, mirror } = await this.resolveRepo(request.repo, {
            allowMirror: request.allowMirror,
            defaultHost: request.defaultHost,
        });

        const requestedVersion = request.version ?? "latest";
        const { source, degradedReason } = await this.resolveSource(repoRef, requestedVersion);

        if (degradedReason) {
            this.deps.notifier.warn(degradedReason);
        }

        const host = getHost(repoRef.host);
        const token = this.tokenFor(repoRef.host);
        const repoLabel = formatRepoId(repoRef);

        const { files, manifest, channel } = await fetchPluginFiles(
            host,
            repoRef,
            source,
            token
        );

        // 兼容性检查放在写盘之前 —— 写完才发现不兼容就要走回滚了。
        if (!requireApiVersion(manifest.minAppVersion)) {
            throw new InstallerError({
                kind: "incompatibleApp",
                name: manifest.name,
                minVersion: manifest.minAppVersion,
            });
        }

        const alreadyInstalled = await readInstalledManifest(this.app, manifest.id);
        const wasEnabled = isPluginEnabled(this.app, manifest.id);

        // 插件目录名可能和用户输入的仓库不一致（仓库名 ≠ manifest id），
        // 这种情况下如果 id 已经装了别的插件，就是冲突，必须拦下。
        if (alreadyInstalled && alreadyInstalled.id !== manifest.id) {
            throw new InstallerError({
                kind: "pluginIdConflict",
                pluginId: manifest.id,
                repo: repoLabel,
            });
        }

        const backup = await createBackup(this.app, manifest.id);

        try {
            await writePluginFiles(this.app, manifest.id, files, backup);
            await refreshPluginManifests(this.app);

            let enabled = false;
            if (wasEnabled) {
                // 更新场景：用户本来就开着，保持开着。
                await reloadPlugin(this.app, manifest.id);
                enabled = isPluginEnabled(this.app, manifest.id);
            } else if (request.enableAfterInstall) {
                await enablePlugin(this.app, manifest.id);
                enabled = isPluginEnabled(this.app, manifest.id);
            }

            await this.recordInstalled({
                repoRef,
                manifest,
                requestedVersion,
                channel,
                enabled,
                replaced: alreadyInstalled !== undefined,
            });

            return {
                manifest,
                channel,
                version: manifest.version,
                replaced: alreadyInstalled !== undefined,
                enabled,
                mirror: mirror ? { host: mirror.host, owner: mirror.owner, repo: mirror.repo } : undefined,
            };
        } catch (err) {
            // writePluginFiles 内部已经回滚过一次；这里只处理写盘之后
            // （启用/重载）失败的场景 —— 文件是好的，只是没能启用。
            logger.error(`install of ${manifest.id} failed after writing files`, err);
            throw err;
        } finally {
            void t;
        }
    }

    /** 重装：忽略本地状态，按原设置重新走一遍安装。 */
    async reinstall(tracked: TrackedPlugin): Promise<InstallResult> {
        return this.install({
            repo: formatRepoId(tracked),
            version: tracked.requestedVersion,
            enableAfterInstall: true,
            defaultHost: tracked.host,
        });
    }

    /**
     * 绑定库里已安装的插件（来源经社区索引识别）。
     *
     * 绑定只是「加入跟踪列表」—— 不写任何文件、不改启用状态。
     * `installedVersion` 取本地 manifest 的版本（它就是磁盘上的事实），
     * `requestedVersion` 固定 latest，更新检查从此刻开始生效。
     *
     * @returns 实际新增的条数（已在跟踪列表里的会被跳过）。
     */
    async bindExisting(
        candidates: Array<{ pluginId: string; name: string; version: string; repo: RepoRef }>
    ): Promise<number> {
        const tracked = this.settings.installer.tracked;
        let added = 0;

        for (const candidate of candidates) {
            if (tracked.some((item) => item.pluginId === candidate.pluginId)) continue;
            tracked.push({
                host: candidate.repo.host,
                owner: candidate.repo.owner,
                repo: candidate.repo.repo,
                pluginId: candidate.pluginId,
                name: candidate.name,
                installedVersion: candidate.version,
                requestedVersion: "latest",
                frozen: false,
                // 历史未知 —— 当作 release 通道，更新检查会按实际回退。
                channel: "release",
                installedAt: Date.now(),
            });
            added += 1;
        }

        if (added > 0) await this.deps.saveSettings();
        return added;
    }

    /** 卸载：先禁用再删目录，最后从跟踪列表移除。 */
    async uninstall(tracked: TrackedPlugin): Promise<void> {
        await disablePlugin(this.app, tracked.pluginId);
        await removePluginFolder(this.app, tracked.pluginId);
        await refreshPluginManifests(this.app);

        const settings = this.settings;
        settings.installer.tracked = settings.installer.tracked.filter(
            (item) => !(item.pluginId === tracked.pluginId && item.host === tracked.host)
        );
        await this.deps.saveSettings();
    }

    // ── 记录 ──────────────────────────────────────────────────────────────

    private async recordInstalled(input: {
        repoRef: RepoRef;
        manifest: { id: string; name: string; version: string };
        requestedVersion: string;
        channel: TrackedPlugin["channel"];
        enabled: boolean;
        replaced: boolean;
    }): Promise<void> {
        const settings = this.settings;
        const { repoRef, manifest } = input;

        const existingIndex = settings.installer.tracked.findIndex(
            (item) => item.pluginId === manifest.id
        );
        const previous = existingIndex >= 0 ? settings.installer.tracked[existingIndex] : undefined;

        const record: TrackedPlugin = {
            host: repoRef.host,
            owner: repoRef.owner,
            repo: repoRef.repo,
            pluginId: manifest.id,
            name: manifest.name,
            installedVersion: manifest.version,
            requestedVersion: input.requestedVersion,
            // 更新时保留用户之前设的冻结状态。
            frozen: previous?.frozen ?? false,
            channel: input.channel,
            installedAt: Date.now(),
        };

        if (existingIndex >= 0) {
            settings.installer.tracked[existingIndex] = record;
        } else {
            settings.installer.tracked.push(record);
        }

        // 装上了新版本，旧的可更新徽标就该消失 —— 否则列表永远挂着过期提示。
        delete settings.installer.availableUpdates[manifest.id];

        await this.deps.saveSettings();
    }

    /** 切换冻结状态。 */
    async setFrozen(tracked: TrackedPlugin, frozen: boolean): Promise<void> {
        const record = this.settings.installer.tracked.find(
            (item) => item.pluginId === tracked.pluginId
        );
        if (!record) return;
        record.frozen = frozen;
        await this.deps.saveSettings();
    }

    /** 检查单个插件是否有新版本。 */
    async checkForUpdate(tracked: TrackedPlugin): Promise<Release | undefined> {
        const repoRef: RepoRef = {
            host: tracked.host,
            owner: tracked.owner,
            repo: tracked.repo,
        };
        const host = getHost(tracked.host);
        const token = this.tokenFor(tracked.host);

        const latest = await host.getLatestRelease(repoRef, token);
        if (!latest) return undefined;

        return latest.tag === tracked.requestedVersion ? undefined : latest;
    }

    /**
     * 把检查结果写进 `installer.availableUpdates` 并落盘。
     *
     * 有更新 → 记入（列表据此渲染常驻徽标，Notice 一闪就错过）；
     * 无更新 → 清除旧记录；检查失败 → **不动**旧记录（过期信息好过没有）。
     *
     * 顺带刷新 `lastUpdateCheckAt`：即使这一轮全部失败也算「检查过了」——
     * 否则限流期间每次打开设置页都会再打一遍 API，情况只会更糟。
     */
    async recordUpdateChecks(results: UpdateCheckResult[]): Promise<void> {
        if (results.length === 0) return;
        const settings = this.settings;
        settings.installer.lastUpdateCheckAt = Date.now();
        const store = settings.installer.availableUpdates;

        for (const result of results) {
            if (result.error !== undefined) continue;
            if (result.hasUpdate) {
                store[result.tracked.pluginId] = {
                    latestVersion: result.latestVersion,
                    checkedAt: Date.now(),
                };
            } else {
                delete store[result.tracked.pluginId];
            }
        }

        await this.deps.saveSettings();
    }
}
