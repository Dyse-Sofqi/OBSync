import type { App } from "obsidian";
import { isImagePath, isInsideFolders, normalizeFolders, scanLocalImages } from "./imageScan";
import { collectImageReferences } from "./references";
import type { ImageSyncService } from "./imageSyncService";
import type { LocalImage, RemoteObject } from "./types";

/**
 * 图片库的三方视图：**本地、云端、引用**。
 *
 * ## 三个状态是三条独立的轴，不是三个互斥的桶
 *
 * 一张图可以同时「本地有、云端有、被引用」，也可以只占其中一两个。
 * 把它们当分类（每张图归入某一类）会立刻漏掉最有用的那几个组合 ——
 * 而用户真正要处理的正是组合：
 *
 * | 组合 | 含义 | 该做的事 |
 * | --- | --- | --- |
 * | 本地有 + 云端无 | 还没上传 | 同步上去 |
 * | 本地无 + 云端有 | 只留在云端（删过本地，或别的设备传的） | 拉回来 / 删掉 |
 * | 本地有 + 无引用 | **失联图片** | 清理 |
 * | 体积很大 | 占仓库体积 | 压缩后同步 |
 *
 * 所以这里只给出一张「每张图在三条轴上的取值」的表，筛选与计数都由调用方
 * （或 `imageFilter`）在这张表上做。
 */

/** 一张图片的完整状态。 */
export interface ImageRecord {
    /** vault 相对路径。云端独有的图片由对象键推出同一个形状的路径。 */
    path: string;
    /** 本地有一份时给出。 */
    local?: LocalImage;
    /** 云端有一份时给出。 */
    remote?: RemoteObject;
    /**
     * 引用它的来源文件（vault 路径，已排序去重）。
     *
     * **空数组 = 失联**：没有任何笔记、画布或画板提到它。
     * 注意这是「扫描结果为空」，而不是「没扫」—— 扫描失败时整个 `refs` 都是空的，
     * 那种情况下界面必须显式说明，否则用户会把整库的图都当成失联删掉。
     */
    refs: string[];
}

/** 三个状态的计数。**不是互斥分类** —— 同一张图会同时计入多个。 */
export interface ImageLibraryCounts {
    /** 本地有（受管文件夹里）。 */
    local: number;
    /** 云端有。 */
    remote: number;
    /** 至少被一个文件引用。 */
    linked: number;
    /** 本地有、但没有任何引用（失联）。 */
    orphans: number;
    /** 本地或云端存在的图片总数（并集）。 */
    total: number;
    /** 两边的并集里，本地那份的总体积（字节）。 */
    localBytes: number;
}

export interface ImageLibrary {
    records: ImageRecord[];
    counts: ImageLibraryCounts;
    /** 云端列举被截断（结果可能不完整）。 */
    truncated: boolean;
    /**
     * 云端列举失败的原因。
     *
     * 有值时列表**仍然可用**，只是「云端」这一维全是「无」—— 这时界面必须
     * 说清楚，否则用户会以为「云端一张都没有」进而把本地全删了。
     */
    remoteError?: unknown;
    /** 引用扫描是否完成。没完成时所有 `refs` 都是空数组，不能当成失联。 */
    referencesScanned: boolean;
}

export interface LoadImageLibraryOptions {
    onProgress?: (done: number, total: number) => void;
}

/**
 * 汇总本地、云端、引用三方状态。
 *
 * ## 云端失败为什么不让整个面板失败
 *
 * 「本地有哪些图」「哪些图没人引用」这两件事与 R2 完全无关，而它们正是
 * 清理失联图片与批量压缩要用的部分。云端列举失败（没配、网络不通、桶权限不对）
 * 时把整页变成一句错误，等于把能用的功能一起关掉。所以这里吞掉云端错误、
 * 记在 `remoteError` 里交给界面说明。
 */
export async function loadImageLibrary(
    app: App,
    service: ImageSyncService,
    options: LoadImageLibraryOptions = {}
): Promise<ImageLibrary> {
    const settings = service.getImageSettings();
    const folders = normalizeFolders(settings.folders);

    const localImages = scanLocalImages(app, folders);
    const localByPath = new Map(localImages.map((image) => [image.path, image]));

    // 引用扫描与云端列举互不依赖，并行跑 —— 两者都是秒级的等待。
    const references = await collectImageReferences(app, { onProgress: options.onProgress });

    let remoteByPath = new Map<string, RemoteObject>();
    let truncated = false;
    let remoteError: unknown;
    if (service.isConfigured()) {
        try {
            const listed = await service.listRemoteImages();
            remoteByPath = listed.remote;
            truncated = listed.truncated;
        } catch (error) {
            remoteError = error;
        }
    }

    // 面板只管图片。云端列举的口径是「前缀 + 受管文件夹」，那里可能混着非图片
    // 对象（同一个文件夹里放着的 PDF、压缩包、笔记备份）。把它们列进来会让
    // 「压缩」「重命名」这类动作出现在不该出现的行上。
    //
    // ⚠ 这里只是**不显示**，`run()` 的同步口径一点没变 —— 面板不该顺手
    //   改写「哪些对象会被同步」这件事，那是同步设置该决定的。
    const paths = [...new Set([...localByPath.keys(), ...remoteByPath.keys()])]
        .filter((path) => isImagePath(path))
        .sort();

    const records: ImageRecord[] = paths.map((path) => ({
        path,
        local: localByPath.get(path),
        remote: remoteByPath.get(path),
        refs: references.refs.get(path) ?? [],
    }));

    let localBytes = 0;
    for (const image of localImages) localBytes += image.size;

    return {
        records,
        counts: {
            local: records.filter((record) => record.local !== undefined).length,
            remote: records.filter((record) => record.remote !== undefined).length,
            linked: records.filter((record) => record.refs.length > 0).length,
            orphans: records.filter((record) => record.local && record.refs.length === 0).length,
            total: records.length,
            localBytes,
        },
        truncated,
        remoteError,
        referencesScanned: true,
    };
}

/** 这张图在这一侧的体积。本地优先（它是用户能直接压缩的那一份）。 */
export function imageSizeOf(record: ImageRecord): number {
    return record.local?.size ?? record.remote?.size ?? 0;
}

/** 路径在受管文件夹里吗 —— 与同步、删除用的是同一个边界。 */
export function isManagedPath(service: ImageSyncService, path: string): boolean {
    const folders = normalizeFolders(service.getImageSettings().folders);
    return isInsideFolders(path, folders);
}

// ── 筛选 ────────────────────────────────────────────────────────────────────

/**
 * 单个状态的筛选取值。
 *
 * 三档而不是勾选框：「必须有」与「必须没有」都是真实需求，而勾选框只能表达
 * 前者 —— 「只看着云端、本地已经没有的图」（本地=无）在清理时是最常用的一条，
 * 用勾选框根本写不出来。
 */
export type StateFilter = "any" | "yes" | "no";

export interface ImageFilter {
    local: StateFilter;
    remote: StateFilter;
    linked: StateFilter;
    /** 只看不小于这个体积的图（KB）。0 = 不限。 */
    minSizeKB: number;
    /** 路径包含这个子串（忽略大小写）。空串 = 不限。 */
    search: string;
}

export const EMPTY_IMAGE_FILTER: ImageFilter = {
    local: "any",
    remote: "any",
    linked: "any",
    minSizeKB: 0,
    search: "",
};

/** 这个筛选条件有没有在起作用（界面用它决定要不要显示「N 项被筛掉」）。 */
export function isFilterActive(filter: ImageFilter): boolean {
    return (
        filter.local !== "any" ||
        filter.remote !== "any" ||
        filter.linked !== "any" ||
        filter.minSizeKB > 0 ||
        filter.search.trim() !== ""
    );
}

function matchesState(state: StateFilter, present: boolean): boolean {
    if (state === "any") return true;
    return state === "yes" ? present : !present;
}

export function applyImageFilter(records: ImageRecord[], filter: ImageFilter): ImageRecord[] {
    const search = filter.search.trim().toLowerCase();
    const minBytes = filter.minSizeKB > 0 ? filter.minSizeKB * 1024 : 0;

    return records.filter((record) => {
        if (!matchesState(filter.local, record.local !== undefined)) return false;
        if (!matchesState(filter.remote, record.remote !== undefined)) return false;
        if (!matchesState(filter.linked, record.refs.length > 0)) return false;
        if (minBytes > 0 && imageSizeOf(record) < minBytes) return false;
        if (search && !record.path.toLowerCase().includes(search)) return false;
        return true;
    });
}

/** 列表的排序方式。 */
export type ImageSort = "path" | "size-desc" | "size-asc";

export function sortImageRecords(records: ImageRecord[], sort: ImageSort): ImageRecord[] {
    const sorted = [...records];
    if (sort === "path") {
        sorted.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
        return sorted;
    }

    const direction = sort === "size-desc" ? -1 : 1;
    sorted.sort((left, right) => {
        const diff = imageSizeOf(left) - imageSizeOf(right);
        // 体积相同时按路径，否则同一个列表两次打开的顺序会不一样。
        if (diff !== 0) return diff * direction;
        return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
    });
    return sorted;
}
