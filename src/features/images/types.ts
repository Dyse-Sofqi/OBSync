/**
 * 图片同步的领域类型。
 *
 * 与 `features/sync/types.ts` 同一套分工：这里只放**纯数据形状**，
 * 不放行为。远端对象与本地文件刻意用两个类型而不是一个 ——
 * 「云端有 etag、本地有 mtime」这件事是两边差异的根源，合成一个类型
 * 会让「这个字段在这一侧是不是有意义」变得看不出来。
 */

/** 云端一个对象（R2 里的一条 key）。 */
export interface RemoteObject {
    /** 对象键（含配置的前缀）。 */
    key: string;
    size: number;
    /**
     * R2 返回的 ETag（已去掉两端引号）。
     *
     * 只用它判断「远端内容变了没有」：R2 的 ETag 对单段上传就是内容的 MD5，
     * 但我们**不**拿它当内容校验和用（分片上传时它不是 MD5）——
     * 这里只做「和上次记下来的是不是同一个」的比较。
     */
    etag: string;
    /** 最后修改时间（毫秒）。 */
    lastModified: number;
}

/** 本地图片文件夹里的一个文件。 */
export interface LocalImage {
    /** vault 相对路径，`/` 分隔。 */
    path: string;
    size: number;
    /** 修改时间（毫秒）。 */
    mtime: number;
}

/**
 * 一条计划的动作。
 *
 * **没有删除。**
 *
 * 这里曾经有 `delete-local` / `delete-remote` 两种动作，对应「双向删除同步」。
 * 那套东西的歧义无法消除：同一个「本地有、云端没有」既可能是「用户删了云端那份」
 * 也可能是「本地新增」，靠状态清单才勉强区分得开 —— 而清单丢了、或者用户在两台
 * 设备上各删一边，判断就会错，代价是**删掉一份用户没打算删的东西**。
 *
 * 现在删除只发生在一种情况：用户在本机删掉一张图片，我们**问他**要不要连云端
 * 一起删（见 `ImageSyncService.deleteRemoteBackup` / `markLocalDeleted`）。
 * 于是 `run()` 永远只做「复制」这一件事 —— 它不可逆的操作只剩「覆盖」，
 * 而覆盖是有备份的那一侧。
 */
export type SyncActionKind = "upload" | "download" | "conflict" | "skip";

/**
 * 为什么是这条动作。
 *
 * 它存在的意义全在界面上：`preview()` 会把每条动作与它的理由一起列出来，
 * 而「本地新增」与「云端新增」在执行时是同一件事（都要传输），
 * 在**排查**时却是两件完全不同的事（我这边多了文件？还是云端多了文件？）。
 */
export type SyncReason =
    /** 本地有、云端没有 —— 把这一份补到云端。 */
    | "local-new"
    /** 本地有、云端有，本地比上次同步时更新 —— 上传。 */
    | "local-changed"
    /** 云端有、本地没有 —— 补到本地来。 */
    | "remote-new"
    /** 两边都有，远端比上次同步时更新 —— 下载。 */
    | "remote-changed"
    /** 两边都变了。按 `conflictPolicy` 定夺。 */
    | "conflict"
    /**
     * 本地已删除，云端副本按用户的选择**保留** —— 不再下载回来。
     *
     * 少了这一条，「删掉一张图」下一轮就会自己恢复：云端还有那一份，
     * 而镜像逻辑看到「云端有、本地没有」只会想到「补齐」。
     */
    | "local-deleted"
    /** 两边一致，什么都不做。 */
    | "in-sync";

export interface SyncPlanEntry {
    path: string;
    action: SyncActionKind;
    reason: SyncReason;
    /** 本地有就是本地大小，否则是云端大小。列表里展示用。 */
    size?: number;
}

export interface SyncPlan {
    entries: SyncPlanEntry[];
    /**
     * 云端列举是否被截断（对象数超过一次列举的上限）。
     *
     * 现在它**只影响提示**：删除已经不在计划里了，所以「没列到的对象会被误判成
     * 已删除」这条风险没有了。剩下的后果是「本地有、云端有、但那一份没被列到」
     * 会被当成「云端缺这一份」而重传一次 —— 无害，只是白传。
     */
    truncated: boolean;
    /** 这次实际列举到的云端对象数（状态行展示用）。 */
    remoteCount: number;
    localCount: number;
}

/** 一轮执行的结果。 */
export interface SyncSummary {
    uploaded: number;
    downloaded: number;
    conflicts: number;
    skipped: number;
    failed: number;
    /** 逐条失败原因 —— 只说「3 个失败」用户无从下手。 */
    errors: Array<{ path: string; message: string }>;
    /** 云端列举被截断（结果可能不完整）。 */
    truncated: boolean;
}

/**
 * 批量删除的结果（图片管理面板用）。
 *
 * 逐条报错而不是只给一个数字：面板上删五十张，用户要知道**是哪几张**没删掉、
 * 为什么。少了 `errors`，「有 3 个失败」这句话无法行动。
 */
export interface DeleteImagesResult {
    /** 真正从本地移走（进回收站）的张数。 */
    localDeleted: number;
    /** 云端对象真正删掉的个数（`remote: false` 时恒为 0）。 */
    remoteDeleted: number;
    /** 逐条失败原因。 */
    errors: Array<{ path: string; message: string }>;
}
