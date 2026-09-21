import type { App } from "obsidian";
import { logger } from "../../core/logger";
import type { RepoRef } from "../../host/types";
import { communityRepoRef } from "./communityIndex";
import type { CommunityPluginIndex } from "./communityPlugins";
import { isPluginEnabled, readManifestInFolder } from "./pluginFolder";
import { SELF_PLUGIN_ID } from "./selfUpdate";
import { itemRoot } from "./itemFolder";
import type { PluginManifest } from "./types";

/**
 * 识别库里「已装但未跟踪」的插件，并把它们和来源仓库对上。
 *
 * ## 为什么不能直接从 manifest 拿到来源
 *
 * Obsidian 的 manifest 规范里**没有** repo 字段（只有 author/authorUrl，
 * 后者常常只是作者主页）。但官方社区索引（`community-plugins.json`）
 * 提供了 `插件 id → owner/repo` 的权威映射 —— 从官方商店装的插件都能对上；
 * 不在官方商店里的（PKMer 等中文渠道分发、或自建的插件）识别不了，
 * 只能靠用户手动添加，这是数据源的边界，不是实现的疏漏。
 *
 * ## 身份一律用 manifest id，不用目录名
 *
 * 目录名不保证等于 id（实测本机 32 个插件里 5 个错位：`MDRazor/` → `md-razor`、
 * `obsidian-commander/` → `cmdr`）。早先版本拿目录名当 id 查索引，
 * 导致这些「明明上了官方市场」的插件被误判成来源未识别 —— 这是踩过的坑，
 * 查索引、查启用状态、写跟踪记录都必须用 manifest.id。
 *
 * （主题侧刚好相反：主题**没有** id，身份就是目录名。见 `existingThemes.ts`。）
 *
 * ## 为什么扫文件系统而不是 `app.plugins.manifests`
 *
 * 后者是 Obsidian 启动时加载的内存状态，可能与磁盘有出入（比如刚手动
 * 拷进去一个插件还没重启）。以磁盘为准，顺带能发现「装了但损坏」的目录。
 */


/** 库里已安装的一个插件（以磁盘上的 manifest 为准）。 */
export interface ExistingPlugin {
    /** manifest 里的 id（插件身份，不是目录名）。 */
    id: string;
    manifest: PluginManifest;
    enabled: boolean;
}

/** 可以直接绑定跟踪的候选：来源仓库已识别。 */
export interface BindCandidate {
    id: string;
    name: string;
    /** 本地已装的版本。 */
    version: string;
    repo: RepoRef;
}

/**
 * 扫描库中已安装的插件目录。
 *
 * 目录里没有合法 manifest 的会被跳过并记日志；同一个 manifest id 出现在
 * 多个目录时只保留第一个（重复安装，Obsidian 自己也只能加载一份）。
 */
export async function listInstalledPlugins(app: App): Promise<ExistingPlugin[]> {
    let folders: string[];
    try {
        folders = (await app.vault.adapter.list(itemRoot(app, "plugin"))).folders;
    } catch (err) {
        // 连插件目录都没有 = 全新库，不是错误。
        logger.debug("no plugins directory to scan", err);
        return [];
    }

    const result: ExistingPlugin[] = [];
    const seen = new Set<string>();

    for (const folder of folders) {
        // 直接从目录读 manifest（不按目录名去解析 id —— 那会再扫一遍目录）。
        const manifest = await readManifestInFolder(app, folder);
        if (!manifest) {
            logger.debug(`skipping ${folder}: no valid manifest.json`);
            continue;
        }
        // 自己不进列表：跟踪自己不是「用户装了什么」的一部分（自制更新的入口
        // 在设置页的「SyncHub 自身」一节）。id 来自 selfUpdate 的单一事实来源。
        if (manifest.id === SELF_PLUGIN_ID) continue;

        if (seen.has(manifest.id)) {
            logger.debug(
                `skipping duplicate install of ${manifest.id} at ${folder} ` +
                    `(already seen elsewhere)`
            );
            continue;
        }
        seen.add(manifest.id);

        result.push({
            id: manifest.id,
            manifest,
            enabled: isPluginEnabled(app, manifest.id),
        });
    }

    return result.sort((a, b) => a.id.localeCompare(b.id));
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
        const community = index.byId(plugin.id);
        const repo = community ? communityRepoRef(community.repo) : undefined;

        if (repo) {
            bindable.push({
                id: plugin.id,
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
