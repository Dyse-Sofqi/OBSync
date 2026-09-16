import { normalizePath, type App } from "obsidian";
import { logger } from "../../core/logger";
import { ObsyncError } from "../../host/errors";
import { parseManifest } from "./manifest";
import { PLUGIN_FILES, REQUIRED_FILES, type PluginFileName, type PluginManifest } from "./types";

/**
 * 插件目录的读写，带**写入前备份与失败回滚**。
 *
 * 参考项目 BRAT 没有回滚：它只做前置校验（manifest 缺 version、
 * main.js 为 null 则中止），`try/catch` 里直接返回 false，不备份不还原。
 * 这在「全新安装」时没问题，但在「更新已有插件」时，一旦写了一半失败，
 * 用户手上就只剩一个坏掉的插件 —— 而那个插件可能正在被使用。
 *
 * 这里的策略：写入前把现有文件读进内存（三个文本文件，几 MB 量级），
 * 任何一步失败就整体还原。
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

/** 插件目录的 vault 相对路径。 */
export function getPluginFolder(app: App, pluginId: string): string {
    return normalizePath(`${app.vault.configDir}/plugins/${pluginId}`);
}

function filePath(app: App, pluginId: string, file: PluginFileName): string {
    return normalizePath(`${getPluginFolder(app, pluginId)}/${file}`);
}

/** 读取已安装插件的 manifest。未安装或损坏时返回 undefined。 */
export async function readInstalledManifest(
    app: App,
    pluginId: string
): Promise<PluginManifest | undefined> {
    const path = filePath(app, pluginId, "manifest.json");
    try {
        if (!(await app.vault.adapter.exists(path))) return undefined;
        return parseManifest(await app.vault.adapter.read(path), pluginId);
    } catch (err) {
        logger.warn(`could not read installed manifest for ${pluginId}`, err);
        return undefined;
    }
}

/** 判断插件是否已安装（以 manifest.json 是否存在为准）。 */
export async function isPluginInstalled(app: App, pluginId: string): Promise<boolean> {
    return app.vault.adapter.exists(filePath(app, pluginId, "manifest.json"));
}

/** 写入前的快照。`null` 表示该文件原本不存在。 */
export interface PluginFolderBackup {
    pluginId: string;
    folderExisted: boolean;
    files: Map<PluginFileName, string | null>;
}

/** 把插件目录的现有内容读进内存。 */
export async function createBackup(app: App, pluginId: string): Promise<PluginFolderBackup> {
    const folder = getPluginFolder(app, pluginId);
    const backup: PluginFolderBackup = {
        pluginId,
        folderExisted: await app.vault.adapter.exists(folder),
        files: new Map(),
    };

    for (const file of PLUGIN_FILES) {
        const path = filePath(app, pluginId, file);
        try {
            backup.files.set(
                file,
                (await app.vault.adapter.exists(path)) ? await app.vault.adapter.read(path) : null
            );
        } catch (err) {
            // 读不到就当作不存在 —— 备份的用途是"尽量还原"，不是"必须完整"。
            logger.warn(`could not back up ${path}`, err);
            backup.files.set(file, null);
        }
    }

    return backup;
}

/** 用快照还原插件目录。 */
export async function restoreBackup(app: App, backup: PluginFolderBackup): Promise<void> {
    const folder = getPluginFolder(app, backup.pluginId);

    // 如果安装前插件根本不存在，还原就是把它整个删掉。
    if (!backup.folderExisted) {
        await removePluginFolder(app, backup.pluginId);
        return;
    }

    if (!(await app.vault.adapter.exists(folder))) {
        await app.vault.adapter.mkdir(folder);
    }

    for (const [file, content] of backup.files) {
        const path = filePath(app, backup.pluginId, file);
        if (content === null) {
            // 原本不存在的文件，还原时也不该存在。
            if (await app.vault.adapter.exists(path)) {
                await app.vault.adapter.remove(path);
            }
            continue;
        }
        await app.vault.adapter.write(path, content);
    }
}

/**
 * 写入插件文件。
 *
 * @param files 文件内容。`main.js` 与 `manifest.json` 必须存在。
 * @throws 缺必需文件时抛错（不写任何东西）；写入过程出错时先还原再抛错。
 */
export async function writePluginFiles(
    app: App,
    pluginId: string,
    files: Map<PluginFileName, string>,
    backup: PluginFolderBackup
): Promise<void> {
    for (const file of REQUIRED_FILES) {
        if (!files.has(file)) {
            throw new ObsyncError(`插件 ${pluginId} 缺少必需文件 ${file}，已中止安装。`);
        }
    }

    const folder = getPluginFolder(app, pluginId);
    const written: string[] = [];

    try {
        if (!(await app.vault.adapter.exists(folder))) {
            await app.vault.adapter.mkdir(folder);
        }

        for (const [file, content] of files) {
            const path = filePath(app, pluginId, file);
            await app.vault.adapter.write(path, content);
            written.push(path);
        }
    } catch (cause) {
        logger.error(`writing ${pluginId} failed, rolling back`, cause);
        try {
            await restoreBackup(app, backup);
        } catch (restoreError) {
            // 回滚也失败了 —— 这是最坏情况，必须让用户知道。
            logger.error(`rollback for ${pluginId} also failed`, restoreError);
            throw new ObsyncError(
                `写入 ${pluginId} 失败，且还原失败。请手动检查插件目录。`,
                { cause }
            );
        }
        throw new ObsyncError(`写入 ${pluginId} 失败，已还原到安装前的状态。`, { cause });
    }

    logger.debug(`wrote ${written.length} file(s) for ${pluginId}`);
}

/** 删除整个插件目录。 */
export async function removePluginFolder(app: App, pluginId: string): Promise<void> {
    const folder = getPluginFolder(app, pluginId);
    if (!(await app.vault.adapter.exists(folder))) return;
    await app.vault.adapter.rmdir(folder, true);
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
        throw new ObsyncError("当前 Obsidian 版本不支持通过插件启用其他插件。");
    }

    await manager.loadManifest?.(getPluginFolder(app, pluginId));
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
