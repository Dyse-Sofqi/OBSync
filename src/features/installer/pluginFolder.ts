import { normalizePath, type App } from "obsidian";
import { logger } from "../../core/logger";
import { InstallerError } from "./errors";
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

/** 插件目录的默认位置（目录名 = 插件 id，也是 Obsidian 自己的约定）。 */
function defaultPluginFolder(app: App, pluginId: string): string {
    return normalizePath(`${app.vault.configDir}/plugins/${pluginId}`);
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
    const pluginsRoot = normalizePath(`${app.vault.configDir}/plugins`);

    try {
        const listing = await app.vault.adapter.list(pluginsRoot);
        for (const folder of listing.folders) {
            const name = folder.slice(folder.lastIndexOf("/") + 1);
            // 快路径：目录名就是 id（绝大多数插件走这条，省一次 manifest 读取）。
            if (name === pluginId) return folder;

            const manifest = await readManifestAtPath(app, `${folder}/manifest.json`);
            if (manifest?.id === pluginId) return folder;
        }
    } catch (err) {
        // 插件根目录还不存在（全新库）—— 不是错误。
        logger.debug("could not scan plugin folders", err);
    }

    return defaultPluginFolder(app, pluginId);
}

/** 读取指定路径的 manifest，失败返回 undefined。 */
async function readManifestAtPath(
    app: App,
    path: string
): Promise<PluginManifest | undefined> {
    try {
        if (!(await app.vault.adapter.exists(path))) return undefined;
        return parseManifest(await app.vault.adapter.read(path), path);
    } catch {
        return undefined;
    }
}

/** 读取某个插件目录里的 manifest（已知目录时用，避免再扫一遍目录）。 */
export async function readManifestInFolder(
    app: App,
    folder: string
): Promise<PluginManifest | undefined> {
    return readManifestAtPath(app, filePathIn(folder, "manifest.json"));
}

function filePathIn(folder: string, file: PluginFileName): string {
    return normalizePath(`${folder}/${file}`);
}

/** 读取已安装插件的 manifest。未安装或损坏时返回 undefined。 */
export async function readInstalledManifest(
    app: App,
    pluginId: string
): Promise<PluginManifest | undefined> {
    const folder = await resolvePluginFolder(app, pluginId);
    return readManifestAtPath(app, filePathIn(folder, "manifest.json"));
}

/** 判断插件是否已安装（以 manifest.json 是否存在为准）。 */
export async function isPluginInstalled(app: App, pluginId: string): Promise<boolean> {
    const folder = await resolvePluginFolder(app, pluginId);
    return app.vault.adapter.exists(filePathIn(folder, "manifest.json"));
}

/** 写入前的快照。`null` 表示该文件原本不存在。 */
export interface PluginFolderBackup {
    pluginId: string;
    folderExisted: boolean;
    files: Map<PluginFileName, string | null>;
}

/** 把插件目录的现有内容读进内存。 */
export async function createBackup(app: App, pluginId: string): Promise<PluginFolderBackup> {
    const folder = await resolvePluginFolder(app, pluginId);
    const backup: PluginFolderBackup = {
        pluginId,
        folderExisted: await app.vault.adapter.exists(folder),
        files: new Map(),
    };

    for (const file of PLUGIN_FILES) {
        const path = filePathIn(folder, file);
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
    const folder = await resolvePluginFolder(app, backup.pluginId);

    // 如果安装前插件根本不存在，还原就是把它整个删掉。
    if (!backup.folderExisted) {
        await removePluginFolder(app, backup.pluginId);
        return;
    }

    if (!(await app.vault.adapter.exists(folder))) {
        await app.vault.adapter.mkdir(folder);
    }

    for (const [file, content] of backup.files) {
        const path = filePathIn(folder, file);
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
 * 写入**已存在**插件的真实目录（目录名可能是仓库名而非 id，见 resolvePluginFolder）；
 * 全新安装则落在 `plugins/{id}`。
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
            throw new InstallerError({ kind: "folderMissingRequired", pluginId, file });
        }
    }

    const folder = await resolvePluginFolder(app, pluginId);
    const written: string[] = [];

    try {
        if (!(await app.vault.adapter.exists(folder))) {
            await app.vault.adapter.mkdir(folder);
        }

        for (const [file, content] of files) {
            const path = filePathIn(folder, file);
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
            throw new InstallerError(
                { kind: "writeFailedRollbackFailed", pluginId },
                { cause }
            );
        }
        throw new InstallerError({ kind: "writeFailedRolledBack", pluginId }, { cause });
    }

    logger.debug(`wrote ${written.length} file(s) for ${pluginId}`);
}

/** 删除插件目录（解析后的真实目录，不只按 id 猜）。 */
export async function removePluginFolder(app: App, pluginId: string): Promise<void> {
    const folder = await resolvePluginFolder(app, pluginId);
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
