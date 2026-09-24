import type { App } from "obsidian";

/**
 * 图片同步的**状态清单**。
 *
 * ## 它现在管什么
 *
 * 取消双向删除（2026-09-23）之后，这份清单不再承担「区分删除与新增」那个
 * 最危险的任务 —— 删除已经不在自动流程里了。它剩下三件事：
 *
 * 1. **判断某一边变了没有。** 只有「上次同步时的快照」能回答这个问题：
 *    本地有没有改（size / mtime 变了吗）、云端有没有改（ETag 变了吗）。
 *    少了它就只能比大小，而大小相同的不同内容会被当成「一致」。
 * 2. **回答「这个文件在云端有备份吗」**（`hasEntry`）—— 用户删掉一张本地图片时，
 *    我们要据此决定「要不要问他一句」。读本地清单是**零延迟**的，
 *    而为了这个问题去列举一次桶，在删除单个文件时完全不成比例。
 * 3. **记一条「本地已删除、云端保留」的墓碑**（`SyncedEntry.remoteOnly`）。
 *
 * ## 清单丢了会怎样（这是设计上必须回答的问题）
 *
 * 清单丢失（换设备、清了浏览器存储）的后果是**两边补齐**：所有文件都按
 * 「本地有就上传、云端有就下载」处理。**不会**删除任何东西 —— 删除现在
 * 只发生在用户明确要求时（`deleteRemoteBackup`），与这份清单无关。
 *
 * 副作用只有一条：**墓碑丢了**。于是用户之前选过「保留云端副本」的那些图
 * 会被下载回本地一次。那是可见的、可理解的（「它怎么又回来了」），
 * 而且用户可以再删一次 —— 比误删一份东西便宜得多。
 *
 * ## 为什么按 vault 路径而不是对象键存
 *
 * 对象键里含用户可配的前缀。按对象键存的话，用户改一次前缀，整份清单就
 * 全部对不上，于是所有文件都变成「新增」—— 一轮全量重传，还得重新学一遍
 * 谁被删过。按 vault 路径存，前缀只是「往哪儿放」的问题，与身份无关。
 *
 * ## 为什么放 localStorage 而不是 vault 里的文件
 *
 * 它记录的是**这台设备**上一次同步时的观察结果，随笔记仓库同步给别的设备
 * 没有意义（那边有自己的观察）。放进 vault 还会被 git 同步走，
 * 于是两台设备互相覆盖对方的清单。`app.saveLocalStorage` 是按库隔离的
 * （与 `Automatics` 的时间戳同一个理由与同一个 API）。
 */

const STORAGE_KEY = "obsync-image-state";
const STATE_VERSION = 1;

export interface SyncedEntry {
    /** 上次同步时本地的大小。 */
    size: number;
    /** 上次同步时本地的修改时间。 */
    mtime: number;
    /** 上次同步后云端返回的 ETag。 */
    etag: string;
    /** 上次成功同步的时间（毫秒）。 */
    syncedAt: number;
    /**
     * 本地已删除，用户选择**保留云端副本**。
     *
     * ## 为什么必须有这一条
     *
     * 取消双向删除之后，「云端有、本地没有」只剩一种解释：补齐到本地。
     * 于是用户删掉一张图、又在询问里选了「保留云端副本」时，下一轮同步
     * 就会把它下载回来 —— 看起来像「删除没生效」。
     *
     * 这一位就是那个「用户确实删了，别再拿回来」的记录。它不需要时间戳，
     * 也不需要额外字段：云端那一份消失时（别人删了、或用户后来确认删除），
     * `pruneState` 会因为两边都不存在而把整条记录剪掉。
     */
    remoteOnly?: boolean;
}

export interface ImageSyncState {
    version: number;
    entries: Record<string, SyncedEntry>;
}

export function emptyState(): ImageSyncState {
    return { version: STATE_VERSION, entries: {} };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        Object.getPrototypeOf(value) === Object.prototype
    );
}

/**
 * 校验从存储里读出来的状态。
 *
 * 逐条校验而不是整体信任：`localStorage` 里的东西可以被手改、也可能被
 * 旧版本的插件写成别的形状。**坏值只丢它自己** —— 一条残缺记录的最坏后果是
 * 「这个文件这一轮按新增处理」，而整份丢弃会让所有文件都按新增处理。
 */
export function sanitizeState(raw: unknown): ImageSyncState {
    if (!isPlainObject(raw)) return emptyState();
    if (!isPlainObject(raw.entries)) return emptyState();

    const entries: Record<string, SyncedEntry> = {};
    for (const [path, value] of Object.entries(raw.entries)) {
        if (!path || !isPlainObject(value)) continue;
        const { size, mtime, etag, syncedAt } = value;
        if (typeof size !== "number" || !Number.isFinite(size)) continue;
        if (typeof mtime !== "number" || !Number.isFinite(mtime)) continue;
        if (typeof etag !== "string") continue;

        entries[path] = {
            size,
            mtime,
            etag,
            syncedAt:
                typeof syncedAt === "number" && Number.isFinite(syncedAt) ? syncedAt : 0,
            // 只认显式的 `true`：`data.json` 之外的东西都能被手改，
            // 而一个真值化的 `"false"` 会让这个文件永远不再下载回来。
            ...(value.remoteOnly === true ? { remoteOnly: true } : {}),
        };
    }

    return { version: STATE_VERSION, entries };
}

export function loadState(app: App): ImageSyncState {
    try {
        const raw: unknown = app.loadLocalStorage(STORAGE_KEY);
        // `loadLocalStorage` 声明的返回类型是 `any`，而且**存的是对象还是字符串
        // 取决于 Obsidian 版本**（它内部会做一次 JSON 往返）—— 所以两种都试。
        if (typeof raw === "string") return sanitizeState(JSON.parse(raw) as unknown);
        return sanitizeState(raw);
    } catch {
        // 读不出来（存储不可用、JSON 坏了）就当作「没有清单」——
        // 那是最保守的一档：只复制、不删除。
        return emptyState();
    }
}

export function saveState(app: App, state: ImageSyncState): void {
    try {
        app.saveLocalStorage(STORAGE_KEY, state);
    } catch {
        // 存不进去只影响「下次还能不能认出删除」，这一轮的动作已经做完了。
        // 不抛错：为了一个副作用失败去打断整个同步是得不偿失的。
    }
}

/** 记下「这个文件刚同步过，两边现在一致」。 */
export function recordSynced(
    state: ImageSyncState,
    path: string,
    local: { size: number; mtime: number },
    etag: string,
    now = Date.now()
): void {
    state.entries[path] = { size: local.size, mtime: local.mtime, etag, syncedAt: now };
}

/** 忘掉一条记录（文件在两边都不存在了）。 */
export function forget(state: ImageSyncState, path: string): void {
    delete state.entries[path];
}

/**
 * 记一条「本地已删除、云端保留」。
 *
 * 没有记录时**什么都不做**：那说明云端本来就没有这一份（否则上次同步会记下），
 * 于是也没有「别下载回来」要防 —— 凭空造一条记录只会让清单里多出无意义的一行。
 */
export function markRemoteOnly(state: ImageSyncState, path: string): void {
    const existing = state.entries[path];
    if (!existing) return;
    existing.remoteOnly = true;
}

/**
 * 记一条墓碑，**清单里本来没有这一条时也建**。
 *
 * ## 为什么需要「强制」的那一版
 *
 * `markRemoteOnly` 的「没有就不记」在本地删除事件里是对的：没有记录 = 上次
 * 同步没见过这一份 = 云端也没有。但**图片管理面板**不是从那个前提出发的 ——
 * 它是从**云端列举结果**出发的，于是确切知道「云端有这一份」，而本地清单里
 * 可能什么都没有（换设备、清了浏览器存储、清单被剪过）。
 *
 * 那种情况下不建墓碑，下一轮同步就会把用户刚在面板里删掉的图下载回来 ——
 * 用户看到的是「删除没生效」。
 *
 * `mtime` 记 0 是刻意的：它表示「我们不知道本地那一份长什么样」（本地确实
 * 已经没有了）。将来文件重新出现时，`refreshRecord` 会因为 mtime 不同而
 * 重写这条记录并清掉墓碑，正好是我们要的行为。
 */
export function markRemoteOnlyForced(
    state: ImageSyncState,
    path: string,
    remote: { size: number; etag: string },
    now = Date.now()
): void {
    state.entries[path] = {
        size: remote.size,
        mtime: 0,
        etag: remote.etag,
        syncedAt: now,
        remoteOnly: true,
    };
}

/** 这个路径在云端有备份吗（清单里有记录就算有）。 */
export function hasEntry(state: ImageSyncState, path: string): boolean {
    return state.entries[path] !== undefined;
}

/**
 * 剪掉两边都已经不存在的记录。
 *
 * 不剪的话清单会随「历史上传过的每一个文件」无限增长，而 `localStorage`
 * 有容量上限 —— 满了之后 `saveState` 静默失败，于是**删除检测悄悄失效**。
 * 这正是那种「不出声就坏掉」的路径，所以宁可每次多走一遍。
 */
export function pruneState(state: ImageSyncState, alivePaths: Set<string>): number {
    let removed = 0;
    for (const path of Object.keys(state.entries)) {
        if (alivePaths.has(path)) continue;
        delete state.entries[path];
        removed += 1;
    }
    return removed;
}
