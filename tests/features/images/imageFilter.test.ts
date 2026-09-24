import { describe, expect, it } from "vitest";
import {
    applyImageFilter,
    EMPTY_IMAGE_FILTER,
    imageSizeOf,
    isFilterActive,
    sortImageRecords,
    type ImageFilter,
    type ImageRecord,
} from "../../../src/features/images/imageLibrary";

/**
 * 三方状态的筛选与排序。
 *
 * 这一层的意义全在**「有 / 无」两个方向都要能筛**：清理时最常用的两条是
 * 「本地有、云端没有」（该上传）与「本地没有、云端有」（只留在云端的），
 * 而后者用「勾选框 = 必须有」的写法根本表达不出来 —— 那正是这里用三档
 * （任意 / 有 / 无）而不是复选框的原因。
 */

function record(path: string, options: Partial<ImageRecord> = {}): ImageRecord {
    return {
        path,
        refs: [],
        ...options,
    };
}

function local(size: number) {
    return { path: "", size, mtime: 1 };
}

function remote(size: number, etag = "e") {
    return { key: "", size, etag, lastModified: 1 };
}

const records: ImageRecord[] = [
    // 本地有、云端有、被引用
    record("images/used.png", { local: local(1000), remote: remote(1000), refs: ["note.md"] }),
    // 本地有、云端没有、没人引用（失联）
    record("images/orphan.png", { local: local(2000) }),
    // 本地没有、云端有
    record("images/cloud-only.png", { remote: remote(3000) }),
    // 本地有、云端有、没人引用
    record("images/both-orphan.png", { local: local(500), remote: remote(500) }),
];

describe("applyImageFilter", () => {
    it("默认（三个都是「任意」）什么都不筛", () => {
        expect(applyImageFilter(records, EMPTY_IMAGE_FILTER)).toHaveLength(4);
    });

    it("本地 = 无 → 只剩「只留在云端」的那些", () => {
        const filter: ImageFilter = { ...EMPTY_IMAGE_FILTER, local: "no" };
        expect(applyImageFilter(records, filter).map((item) => item.path)).toEqual([
            "images/cloud-only.png",
        ]);
    });

    it("本地 = 有、云端 = 无 → 待上传的那些", () => {
        const filter: ImageFilter = { ...EMPTY_IMAGE_FILTER, local: "yes", remote: "no" };
        expect(applyImageFilter(records, filter).map((item) => item.path)).toEqual([
            "images/orphan.png",
        ]);
    });

    it("已链接 = 无 → 失联图片（本地那份还在的）", () => {
        const filter: ImageFilter = { ...EMPTY_IMAGE_FILTER, linked: "no", local: "yes" };
        expect(applyImageFilter(records, filter).map((item) => item.path)).toEqual([
            "images/orphan.png",
            "images/both-orphan.png",
        ]);
    });

    it("最小体积按「本地优先、否则云端」的体积比", () => {
        // 阈值 1 KB = 1024 字节：2000 与 3000 过线，1000 / 500 不过。
        const filter: ImageFilter = { ...EMPTY_IMAGE_FILTER, minSizeKB: 1 };
        expect(applyImageFilter(records, filter).map((item) => item.path)).toEqual([
            "images/orphan.png",
            "images/cloud-only.png",
        ]);
    });

    it("搜索忽略大小写，且只看路径", () => {
        const filter: ImageFilter = { ...EMPTY_IMAGE_FILTER, search: "ORPHAN" };
        expect(applyImageFilter(records, filter).map((item) => item.path)).toEqual([
            "images/orphan.png",
            "images/both-orphan.png",
        ]);
    });

    it("条件之间是「且」：同时要求本地有、云端有、无引用", () => {
        const filter: ImageFilter = {
            ...EMPTY_IMAGE_FILTER,
            local: "yes",
            remote: "yes",
            linked: "no",
        };
        expect(applyImageFilter(records, filter).map((item) => item.path)).toEqual([
            "images/both-orphan.png",
        ]);
    });
});

describe("isFilterActive", () => {
    it("默认条件不算「在筛」", () => {
        expect(isFilterActive(EMPTY_IMAGE_FILTER)).toBe(false);
        // 只有空白字符的搜索词同样不算。
        expect(isFilterActive({ ...EMPTY_IMAGE_FILTER, search: "   " })).toBe(false);
    });

    it("任一条件非默认就算", () => {
        expect(isFilterActive({ ...EMPTY_IMAGE_FILTER, linked: "no" })).toBe(true);
        expect(isFilterActive({ ...EMPTY_IMAGE_FILTER, minSizeKB: 100 })).toBe(true);
        expect(isFilterActive({ ...EMPTY_IMAGE_FILTER, search: "a" })).toBe(true);
    });
});

describe("imageSizeOf", () => {
    it("本地优先 —— 它是用户能直接压缩的那一份", () => {
        expect(imageSizeOf(record("a", { local: local(10), remote: remote(999) }))).toBe(10);
        expect(imageSizeOf(record("a", { remote: remote(999) }))).toBe(999);
        expect(imageSizeOf(record("a"))).toBe(0);
    });
});

describe("sortImageRecords", () => {
    it("按路径时稳定且不改原数组", () => {
        const sorted = sortImageRecords(records, "path");
        expect(sorted.map((item) => item.path)).toEqual([
            "images/both-orphan.png",
            "images/cloud-only.png",
            "images/orphan.png",
            "images/used.png",
        ]);
        expect(records[0]!.path).toBe("images/used.png");
    });

    it("按体积倒序时最大在前", () => {
        expect(sortImageRecords(records, "size-desc").map((item) => item.path)).toEqual([
            "images/cloud-only.png",
            "images/orphan.png",
            "images/used.png",
            "images/both-orphan.png",
        ]);
    });

    it("体积相同时退化成按路径 —— 否则两次打开的顺序会不一样", () => {
        const tied: ImageRecord[] = [
            record("b.png", { local: local(100) }),
            record("a.png", { local: local(100) }),
        ];
        expect(sortImageRecords(tied, "size-desc").map((item) => item.path)).toEqual([
            "a.png",
            "b.png",
        ]);
    });
});
