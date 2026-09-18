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
    manifests?: Record<string, unknown>;
    loadManifest?(path: string): Promise<void>;
    loadManifests?(): Promise<void>;
    enablePluginAndSave?(id: string): Promise<void>;
    disablePluginAndSave?(id: string): Promise<void>;
}

function pluginManager(app: App): InternalPluginManager | undefined {
    return (app as unknown as { plugins?: InternalPluginManager }).plugins;
}

/**
 * 解析插件在磁盘上的**真实目录**。
 *
 * 目录名**不保证等于** manifest id：手动解压 release、或别的安装器用仓库名建目录，
 * 都会造成错位 —— 实测本机 32 个插件里有 5 个（`MDRazor/` → id `md-razor`、
 * `obsidian-commander/` → id `cmdr` 等）。踩过的坑：拿目录名当 id 去查官方索引
 * 会让这些插件「明明上了市场却识别不出来」；而写文件时若按 id 建目录，
 * 会造出同 id 的第二份安装。
 *
 * 因此：**目录名只用于定位文件，插件身份一律以 manifest id 为准**。
 * 找不到匹配目录时返回默认位置 —— 全新安装的落点。
 */
export async function resolvePluginFolder(app: App, pluginId: string): Promise<string> {
    try {
        const listing = await app.vault.adapter.list(itemRoot(app, "plugin"));
        for (const folder of listing.folders) {
            const name = folder.slice(folder.lastIndexOf("/") + 1);
            // 快路径：目录名就是 id（绝大多数插件走这条，省一次 manifest 读取）。
            if (name === pluginId) return folder;

            const manifest = await readManifestAtPath(app, filePathIn(folder, MANIFEST_FILE));
            if (manifest?.id === pluginId) return folder;
        }
    } catch (err) {
        // 插件根目录还不存在（全新库）—— 不是错误。
        logger.debug("could not scan plugin folders", err);
    }

    return defaultItemFolder(app, "plugin", pluginId);
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
