import { normalizePath, type App } from "obsidian";
import { logger } from "../../core/logger";
import { tryParseRepoRef } from "../../host/repoRef";
import type { HostKind, RepoRef } from "../../host/types";
import type { CommunityPluginIndex } from "./communityPlugins";
import { readInstalledManifest } from "./pluginFolder";
import type { PluginManifest } from "./types";

/**
 * 识别库里「已装但未跟踪」的插件，并把它们和来源仓库对上。
 *
 * ## 为什么不能直接从 manifest 拿到来源
 *
 * Obsidian 的 manifest 规范里**没有** repo 字段（只有 author/authorUrl，
 * 后者常常只是作者主页）。但官方社区索引（`community-plugins.json`）
 * 提供了 `插件 id → owner/repo` 的权威映射 —— 从官方商店装的插件都能对上；
 * 不在官方商店里的（大量中文/Gitee 插件）识别不了，只能靠用户手动添加，
 * 这是数据源的边界，不是实现的疏漏。
 *
 * ## 为什么扫文件系统而不是 `app.plugins.manifests`
 *
 * 后者是 Obsidian 启动时加载的内存状态，可能与磁盘有出入（比如刚手动
 * 拷进去一个插件还没重启）。以磁盘为准，顺带能发现「装了但损坏」的目录。
 */

/** 库里已安装的一个插件（以磁盘上的 manifest 为准）。 */
export interface ExistingPlugin {
    pluginId: string;
    manifest: PluginManifest;
    enabled: boolean;
}

/** 可以直接绑定跟踪的候选：来源仓库已识别。 */
export interface BindCandidate {
    pluginId: string;
    name: string;
    /** 本地已装的版本。 */
    version: string;
    repo: RepoRef;
}

/** 扫描库中已安装的插件目录。目录里没有合法 manifest 的会被跳过并记日志。 */
export async function listInstalledPlugins(app: App): Promise<ExistingPlugin[]> {
    const pluginsRoot = normalizePath(`${app.vault.configDir}/plugins`);

    let folders: string[];
    try {
        const listing = await app.vault.adapter.list(pluginsRoot);
        folders = listing.folders;
    } catch (err) {
        // 连插件目录都没有 = 全新库，不是错误。
        logger.debug("no plugins directory to scan", err);
        return [];
    }

    const result: ExistingPlugin[] = [];
    for (const folder of folders) {
        const pluginId = folder.slice(folder.lastIndexOf("/") + 1);
        const manifest = await readInstalledManifest(app, pluginId);
        if (!manifest) {
            logger.debug(`skipping ${folder}: no valid manifest.json`);
            continue;
        }
        result.push({
            pluginId,
            manifest,
            enabled: isPluginIdEnabled(app, pluginId),
        });
    }

    return result.sort((a, b) => a.pluginId.localeCompare(b.pluginId));
}

function isPluginIdEnabled(app: App, pluginId: string): boolean {
    const manager = (app as unknown as {
        plugins?: { enabledPlugins?: Set<string> };
    }).plugins;
    return manager?.enabledPlugins?.has(pluginId) ?? false;
}

/**
 * 把已安装插件与官方社区索引对上，分出「可绑定」与「来源未识别」两组。
 *
 * 会先拉取/复用社区索引缓存（6 小时，见 CommunityPluginIndex）。
 * 已在跟踪列表里的插件由调用方自行过滤 —— 这里不读设置，保持函数纯粹。
 */
export async function resolveBindCandidates(
    app: App,
    index: CommunityPluginIndex
): Promise<{ bindable: BindCandidate[]; unresolved: ExistingPlugin[] }> {
    await index.load();

    const installed = await listInstalledPlugins(app);
    const bindable: BindCandidate[] = [];
    const unresolved: ExistingPlugin[] = [];

    for (const plugin of installed) {
        const community = index.byId(plugin.pluginId);
        const repo = community ? repoRefOf(community.repo) : undefined;

        if (repo) {
            bindable.push({
                pluginId: plugin.pluginId,
                name: plugin.manifest.name,
                version: plugin.manifest.version,
                repo,
            });
        } else {
            unresolved.push(plugin);
        }
    }

    return { bindable, unresolved };
}

/** 社区索引里的 `owner/repo` → RepoRef。来源是官方索引，平台必为 GitHub。 */
function repoRefOf(repo: string): RepoRef | undefined {
    const ref = tryParseRepoRef(repo, "github");
    if (!ref) return undefined;
    return { host: "github" satisfies HostKind, owner: ref.owner, repo: ref.repo };
}
