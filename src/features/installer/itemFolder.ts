import { normalizePath, type App } from "obsidian";
import { logger } from "../../core/logger";
import { InstallerError } from "./errors";
import { FILE_SETS, SUBDIR, type TrackedKind } from "./types";

/**
 * 被跟踪对象在磁盘上的目录读写，带**写入前备份与失败回滚**。
 *
 * 参考项目 BRAT 没有回滚：它只做前置校验（manifest 缺 version、
 * main.js 为 null 则中止），`try/catch` 里直接返回 false，不备份不还原。
 * 这在「全新安装」时没问题，但在「更新已有插件」时，一旦写了一半失败，
 * 用户手上就只剩一个坏掉的插件 —— 而那个插件可能正在被使用。
 *
 * 这里的策略：写入前把现有文件读进内存（都是文本文件，量级可忽略），
 * 任何一步失败就整体还原。插件与主题共用这条路径，只有文件集不同。
 *
 * ## 为什么这里收的是**目录**而不是 id
 *
 * 「一个 id 对应的真实目录是哪个」两种 kind 的答案不同（插件要扫目录比对
 * manifest.id，主题的目录名本身就是身份但要兜大小写）—— 那是各自的业务，
 * 分别写在 `pluginFolder.ts` / `themeFolder.ts` 里。这一层只做「给定目录，
 * 安全地读、写、删」。
 *
 * 顺带消掉一处重复：早先每个操作各自解析一次目录，一次安装要 `list()` 三趟；
 * 现在调用方解析一次、往下传。
 */

/** 某种对象在 configDir 下的根目录。 */
export function itemRoot(app: App, kind: TrackedKind): string {
    return normalizePath(`${app.vault.configDir}/${SUBDIR[kind]}`);
}

/** 默认落点：目录名 = 身份，与 Obsidian 自己的约定一致。 */
export function defaultItemFolder(app: App, kind: TrackedKind, id: string): string {
    return normalizePath(`${itemRoot(app, kind)}/${id}`);
}

/** 拼一个文件在目录内的路径。 */
export function filePathIn(folder: string, file: string): string {
    return normalizePath(`${folder}/${file}`);
}

/** 写入前的快照。`null` 表示该文件原本不存在。 */
export interface ItemFolderBackup {
    kind: TrackedKind;
    /** 身份，只用于日志与错误文案。 */
    id: string;
    /** 快照对应的真实目录（调用方解析后传入）。 */
    folder: string;
    folderExisted: boolean;
    files: Map<string, string | null>;
}

/** 把目录的现有内容读进内存。 */
export async function createBackup(
    app: App,
    kind: TrackedKind,
    id: string,
    folder: string
): Promise<ItemFolderBackup> {
    const backup: ItemFolderBackup = {
        kind,
        id,
        folder,
        folderExisted: await app.vault.adapter.exists(folder),
        files: new Map(),
    };

    for (const file of FILE_SETS[kind].all) {
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

/** 用快照还原目录。 */
export async function restoreBackup(app: App, backup: ItemFolderBackup): Promise<void> {
    // 如果安装前这个目录根本不存在，还原就是把它整个删掉。
    if (!backup.folderExisted) {
        await removeItemFolder(app, backup.folder);
        return;
    }

    if (!(await app.vault.adapter.exists(backup.folder))) {
        await app.vault.adapter.mkdir(backup.folder);
    }

    for (const [file, content] of backup.files) {
        const path = filePathIn(backup.folder, file);
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
 * 把文件写进目录。
 *
 * @param files 文件内容。必需文件必须齐全（见 `FILE_SETS`）。
 * @throws 缺必需文件时抛错（不写任何东西）；写入过程出错时先还原再抛错。
 */
export async function writeItemFiles(
    app: App,
    files: Map<string, string>,
    backup: ItemFolderBackup
): Promise<void> {
    const { kind, id, folder } = backup;

    for (const file of FILE_SETS[kind].required) {
        if (!files.has(file)) {
            throw new InstallerError({ kind: "folderMissingRequired", id, file, of: kind });
        }
    }

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
        logger.error(`writing ${kind} ${id} failed, rolling back`, cause);
        try {
            await restoreBackup(app, backup);
        } catch (restoreError) {
            // 回滚也失败了 —— 这是最坏情况，必须让用户知道。
            logger.error(`rollback for ${kind} ${id} also failed`, restoreError);
            throw new InstallerError({ kind: "writeFailedRollbackFailed", id, of: kind }, { cause });
        }
        throw new InstallerError({ kind: "writeFailedRolledBack", id, of: kind }, { cause });
    }

    logger.debug(`wrote ${written.length} file(s) for ${kind} ${id}`);
}

/**
 * 删除整个目录（递归）。调用方负责传入**已解析**的目录。
 *
 * 只被**回滚**路径调用（`restoreBackup` 处理「安装前这个目录根本不存在」）——
 * 取消跟踪不删任何文件，见 `InstallerService.unbind`。
 */
export async function removeItemFolder(app: App, folder: string): Promise<void> {
    if (!(await app.vault.adapter.exists(folder))) return;
    await app.vault.adapter.rmdir(folder, true);
}
