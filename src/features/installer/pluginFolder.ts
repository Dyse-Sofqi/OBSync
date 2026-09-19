import type { App } from "obsidian";
import { logger } from "../../core/logger";
import { InstallerError } from "./errors";
import { defaultItemFolder, filePathIn, itemRoot } from "./itemFolder";
import { parsePluginManifest } from "./manifest";
import { MANIFEST_FILE, type PluginManifest } from "./types";

/**
 * 插件的目录定位与生命周期（启用 / 禁用 / 重载 / 刷新 manifest）。
 *
 * 目录的读写本身（备份、写盘、回滚、删除）在 `itemFolder.ts` —— 那部分插件与
 * 主题完全一样。这里只留**插件独有**的两件事：目录名与 id 的错位，以及
 * Obsidian 的插件管理 API。
 */

/** Obsidian 内部插件管理 API。未进 typings，只能收窄。 */
interface InternalPluginManager {
    enabledPlugins?: Set<string>;
    /** 已扫描到的插件 manifest，键是**插件 id**（Obsidian 的插件列表用的就是它）。 */
    manifests?: Record<string, { dir?: string } | undefined>;
    loadManifest?(path: string): Promise<void>;
    loadManifests?(): Promise<void>;
    enablePluginAndSave?(id: string): Promise<void>;
    disablePluginAndSave?(id: string): Promise<void>;
}

function pluginManager(app: App): InternalPluginManager | undefined {
    return (app as unknown as { plugins?: InternalPluginManager }).plugins;
}

/** 一次目录定位的结果。 */
export interface PluginFolderLookup {
    /** 文件该读该写的目录。 */
    folder: string;
    /**
     * **其他也声明了同一 id 的目录**（通常是一份残留备份）。
     *
     * 只要它非空，就说明 `plugins/` 里有两个目录抢同一个插件 id —— 而 Obsidian
     * 认哪一个**是不定的**（实测：重启后它加载了备份那份 2.5.16，而 OBSync 按
     * `md-razor/` 的 manifest 记着 2.6.4，于是更新检查永远报「已是最新」）。
     */
    duplicates: string[];
    /** 这个目录是不是 Obsidian 自己给的（即它**实际加载**的那一份）。 */
    fromObsidian: boolean;
}

/** 扫描 `plugins/` 下所有声明了该 id 的目录。 */
async function findFoldersDeclaringId(app: App, pluginId: string): Promise<string[]> {
    const found: string[] = [];
    try {
        const listing = await app.vault.adapter.list(itemRoot(app, "plugin"));
        for (const folder of listing.folders) {
            // 快路径：目录名就是 id（绝大多数插件走这条，省一次 manifest 读取）。
            const name = folder.slice(folder.lastIndexOf("/") + 1);
            if (name === pluginId) {
                found.push(folder);
                continue;
            }

            const manifest = await readManifestAtPath(app, filePathIn(folder, MANIFEST_FILE));
            if (manifest?.id === pluginId) found.push(folder);
        }
    } catch (err) {
        // 插件根目录还不存在（全新库）—— 不是错误。
        logger.debug("could not scan plugin folders", err);
    }
    return found;
}

/**
 * 解析插件在磁盘上的**真实目录**，并报告「同一个 id 有几个目录」。
 *
 * 目录名**不保证等于** manifest id：手动解压 release、或别的安装器用仓库名建目录，
 * 都会造成错位 —— 实测本机 32 个插件里有 5 个（`MDRazor/` → id `md-razor`、
 * `obsidian-commander/` → id `cmdr` 等）。踩过的坑：拿目录名当 id 去查官方索引
 * 会让这些插件「明明上了市场却识别不出来」；而写文件时若按 id 建目录，
 * 会造出同 id 的第二份安装。
 *
 * 因此：**目录名只用于定位文件，插件身份一律以 manifest id 为准**。
 *
 * ## 优先听 Obsidian 的：它加载的那一份才是真的
 *
 * 同一个 id 有两个目录时（实测：一份残留备份），Obsidian 自己也不定 ——
 * 它按 manifest id 建索引，谁最后被扫到谁赢。所以这里**先问 Obsidian**
 * （`manifests[id].dir`，未进 typings 的 API，与 `app.customCss` 一样带守卫），
 * 它给出的目录才是用户实际在跑的那份；拿不到时才退回「同名优先」的猜测。
 *
 * 调用方**必须**看看 `duplicates`：非空意味着用户机器上有一份看不见的第二安装，
 * 它会让「实际装的是什么」与「OBSync 显示的是什么」长期不一致。
 */
export async function resolvePluginFolderInfo(
    app: App,
    pluginId: string
): Promise<PluginFolderLookup> {
    const candidates = await findFoldersDeclaringId(app, pluginId);

    // ① Obsidian 实际加载的那一份（权威）
    const loadedDir = pluginManager(app)?.manifests?.[pluginId]?.dir;
    if (loadedDir && candidates.includes(loadedDir)) {
        return {
            folder: loadedDir,
            duplicates: candidates.filter((folder) => folder !== loadedDir),
            fromObsidian: true,
        };
    }

    // ② 目录名恰好等于 id（没有重复时与 ① 同解）
    const exact = candidates.find(
        (folder) => folder.slice(folder.lastIndexOf("/") + 1) === pluginId
    );
    if (exact) {
        return {
            folder: exact,
            duplicates: candidates.filter((folder) => folder !== exact),
            fromObsidian: false,
        };
    }

    // ③ 任意声明了该 id 的目录
    if (candidates.length > 0) {
        return {
            folder: candidates[0]!,
            duplicates: candidates.slice(1),
            fromObsidian: false,
        };
    }

    // ④ 全新安装的落点
    return {
        folder: defaultItemFolder(app, "plugin", pluginId),
        duplicates: [],
        fromObsidian: false,
    };
}

/** 只要目录、不关心有没有重复 —— 大多数调用方要的就是这个。 */
export async function resolvePluginFolder(app: App, pluginId: string): Promise<string> {
    return (await resolvePluginFolderInfo(app, pluginId)).folder;
}

/** 读取指定路径的 manifest，失败返回 undefined。 */
async function readManifestAtPath(
    app: App,
    path: string
): Promise<PluginManifest | undefined> {
    try {
        if (!(await app.vault.adapter.exists(path))) return undefined;
        return parsePluginManifest(await app.vault.adapter.read(path), path);
    } catch {
        return undefined;
    }
}

/** 读取某个插件目录里的 manifest（已知目录时用，避免再扫一遍目录）。 */
export async function readManifestInFolder(
    app: App,
    folder: string
): Promise<PluginManifest | undefined> {
    return readManifestAtPath(app, filePathIn(folder, MANIFEST_FILE));
}

/** 读取已安装插件的 manifest。未安装或损坏时返回 undefined。 */
export async function readInstalledManifest(
    app: App,
    pluginId: string
): Promise<PluginManifest | undefined> {
    const folder = await resolvePluginFolder(app, pluginId);
    return readManifestAtPath(app, filePathIn(folder, MANIFEST_FILE));
}

export function isPluginEnabled(app: App, pluginId: string): boolean {
    return pluginManager(app)?.enabledPlugins?.has(pluginId) ?? false;
}

/**
 * 启用插件。
 *
 * 需要先 `loadManifest` 让 Obsidian 知道这个新插件存在，否则
 * `enablePluginAndSave` 会因为找不到 manifest 而静默失败。
 */
export async function enablePlugin(app: App, pluginId: string): Promise<void> {
    const manager = pluginManager(app);
    if (!manager?.enablePluginAndSave) {
        throw new InstallerError({ kind: "cannotEnablePlugin" });
    }

    // loadManifest 要的是**目录**，enablePluginAndSave 要的是**插件 id** ——
    // 两者在目录名 ≠ id 的插件上不是同一个字符串。
    await manager.loadManifest?.(await resolvePluginFolder(app, pluginId));
    await manager.enablePluginAndSave(pluginId);
}

export async function disablePlugin(app: App, pluginId: string): Promise<void> {
    const manager = pluginManager(app);
    if (!manager?.disablePluginAndSave) return;
    if (!isPluginEnabled(app, pluginId)) return;
    await manager.disablePluginAndSave(pluginId);
}

/** 重新加载插件（禁用后启用）。用于更新完文件之后。 */
export async function reloadPlugin(app: App, pluginId: string): Promise<void> {
    const wasEnabled = isPluginEnabled(app, pluginId);
    if (!wasEnabled) return;
    await disablePlugin(app, pluginId);
    await enablePlugin(app, pluginId);
}

/** 让 Obsidian 重新扫描插件目录。 */
export async function refreshPluginManifests(app: App): Promise<void> {
    await pluginManager(app)?.loadManifests?.();
}
