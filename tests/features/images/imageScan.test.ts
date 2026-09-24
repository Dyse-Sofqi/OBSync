import { describe, expect, it } from "vitest";
import {
    extensionOf,
    formatFolders,
    isEditableImage,
    isImagePath,
    isInsideFolders,
    normalizeFolder,
    normalizeFolders,
    parseFolders,
    scanLocalImages,
} from "../../../src/features/images/imageScan";
import { createFakeImageVault } from "../../helpers/fakeImageVault";

/**
 * 图片扫描 —— 双副本架构里**唯一的边界**。
 *
 * 这里的每一条判据背后都挂着「一个文件会不会被删」，所以测试的重点不是
 * 「函数返回了什么」，而是「范围之外的东西有没有被放进来」。
 */

describe("extensionOf", () => {
    it("取小写扩展名", () => {
        expect(extensionOf("a/b/Photo.PNG")).toBe("png");
        expect(extensionOf("a/b/photo.jpeg")).toBe("jpeg");
    });

    it("没有扩展名时返回空串", () => {
        expect(extensionOf("a/b/README")).toBe("");
        expect(extensionOf("")).toBe("");
    });

    it("只认最后一个点", () => {
        // `archive.tar.gz` 的扩展名是 gz —— 用第一个点会把 `.tar.gz` 当扩展名。
        expect(extensionOf("archive.tar.gz")).toBe("gz");
    });

    it("目录名里的点不算扩展名", () => {
        // 取的是**最后一段**（文件名）的扩展名，不是整条路径最后一个点之后的内容 ——
        // 后者会给 `v1.0/README` 返回 `0/readme`。那个值恰好不是任何图片扩展名
        // （它含斜杠），所以不会误判，但那是巧合而不是保证。
        expect(extensionOf("v1.0/README")).toBe("");
        expect(extensionOf("v1.0/photo.png")).toBe("png");
        expect(extensionOf("a.b.c/file")).toBe("");
    });

    it("点开头的文件名没有扩展名（那个点是在起名，不是在分格式）", () => {
        // 与 `buildOutputPath` 的 `dot <= 0` 判据保持一致。
        expect(extensionOf(".hidden")).toBe("");
        expect(extensionOf("images/.png")).toBe("");
    });
});

describe("isImagePath（参与同步的格式）", () => {
    it.each(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "svg", "heic", "tif", "tiff"])(
        "认 %s",
        (extension) => {
            expect(isImagePath(`attachments/a.${extension}`)).toBe(true);
        }
    );

    it("大小写不敏感（相机导出的文件常常是大写后缀）", () => {
        expect(isImagePath("attachments/IMG_0001.JPG")).toBe(true);
        expect(isImagePath("attachments/Scan.PNG")).toBe(true);
    });

    it.each(["md", "pdf", "canvas", "zip", "mp4", "txt"])("不认 %s", (extension) => {
        expect(isImagePath(`attachments/a.${extension}`)).toBe(false);
    });

    it("没有扩展名的文件不算图片", () => {
        expect(isImagePath("attachments/README")).toBe(false);
    });
});

describe("isEditableImage（可以用画布重新编码的格式）", () => {
    it.each(["png", "jpg", "jpeg", "webp", "avif", "bmp"])("认 %s", (extension) => {
        expect(isEditableImage(`a.${extension}`)).toBe(true);
    });

    /**
     * 这两条差异不是洁癖，而是「编辑会把图毁掉」：
     * - svg 是矢量图，画布会把它栅格化；
     * - gif 经过画布会只剩第一帧（动图变静图）。
     *
     * 所以它们**能同步**但**不能编辑** —— 编辑入口会明确拒绝并说明原因。
     */
    it("svg 与 gif 能同步但不能编辑", () => {
        expect(isImagePath("a.svg")).toBe(true);
        expect(isEditableImage("a.svg")).toBe(false);

        expect(isImagePath("a.gif")).toBe(true);
        expect(isEditableImage("a.gif")).toBe(false);
    });

    it("编辑范围是同步范围的子集（不能出现「能编辑但不能同步」的格式）", () => {
        const all = ["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "svg", "heic", "tif", "tiff"];
        for (const extension of all) {
            if (isEditableImage(`a.${extension}`)) {
                expect(isImagePath(`a.${extension}`)).toBe(true);
            }
        }
    });
});

describe("normalizeFolder", () => {
    it("去掉两侧斜杠与空白", () => {
        expect(normalizeFolder("/images/")).toBe("images");
        expect(normalizeFolder("  images  ")).toBe("images");
        expect(normalizeFolder("images")).toBe("images");
    });

    it("折叠重复的斜杠", () => {
        expect(normalizeFolder("a//b")).toBe("a/b");
    });

    /**
     * `.` 与 `/` 都表示「整个库」，归一成空串。
     *
     * 归一成空串而不是保留字面量，是因为 `isInsideFolders` 已经把空串当作
     * 「全都在范围内」—— 保留 `.` 会变成「找名字叫 `.` 的文件夹」，
     * 于是一个文件都匹配不上，而用户以为自己在同步整个库。
     */
    it("`.` 与 `/` 归一成空串（表示整个库）", () => {
        expect(normalizeFolder(".")).toBe("");
        expect(normalizeFolder("/")).toBe("");
    });

    /**
     * 这些是同一个「整个库」的写法，**必须都归一成空串**。
     *
     * 判据的顺序在这里是关键：先判断「是不是整个库」再剥斜杠的话，`./` 既不
     * 等于 `.` 也不等于 `/`，会漏过去归一成 `.` —— 于是 `isInsideFolders` 去找
     * 一个名字叫 `.` 的文件夹，一个文件都匹配不上，界面却什么都不说。
     * 用户填了 `./`（很自然的写法），看到的是「同步完成，0 个文件」。
     */
    it.each(["./", "/./", " ./ ", "//", "/", "."])("`%s` 也归一成空串", (value) => {
        expect(normalizeFolder(value)).toBe("");
    });

    it("中间的 `.` 段被丢掉（`a/./b` 与 `a/b` 是同一个文件夹）", () => {
        expect(normalizeFolder("a/./b")).toBe("a/b");
        expect(normalizeFolder("./images")).toBe("images");
    });

    /**
     * `..` 段原样保留 —— 它匹配不到任何文件（安静地不做事），而**不会**逃出库。
     *
     * 这个函数的返回值只被当作前缀去比对 vault 路径（`isInsideFolders`），
     * 从不拼成文件系统路径，所以「逃逸」在这里没有着力点。
     */
    it("`..` 原样保留，且不会让范围扩大", () => {
        expect(normalizeFolder("../outside")).toBe("../outside");
        expect(isInsideFolders("images/a.png", ["../outside"])).toBe(false);
    });
});

describe("normalizeFolders", () => {
    /**
     * 纯空白（空行）要丢，但**空串本身是合法值**。
     *
     * 曾经这里把 `""` 也一起丢，于是「同步整个库」这个设置在**重新加载时**被
     * 悄悄改回「什么都没管」—— 而且不止加载：`imageSyncService.configProblem()`
     * 每次都会重跑一遍 `normalizeFolders`，内存里的 `[""]` 也会被当成「没配文件夹」。
     * 默认值是仓库根目录（落盘形状正是 `[""]`）之后，这条会立刻踩到。
     */
    it("跳过纯空白项，但保留空串（整个库归一之后的规范形状）", () => {
        expect(normalizeFolders(["   ", "\t"])).toEqual([]);
        expect(normalizeFolders([""])).toEqual([""]);
        expect(normalizeFolders(["", "images"])).toEqual(["", "images"]);
    });

    it("空串反复归一不丢（落盘 → 读回的往返）", () => {
        expect(normalizeFolders(normalizeFolders(["."]))).toEqual([""]);
    });

    it("去重（否则设置页看起来像坏了）", () => {
        expect(normalizeFolders(["images", "/images/", "images"])).toEqual(["images"]);
    });

    it("归一之后才比较，所以不同写法算同一个", () => {
        expect(normalizeFolders(["a/b", "a//b", "/a/b/"])).toEqual(["a/b"]);
    });

    it("保留顺序", () => {
        expect(normalizeFolders(["b", "a"])).toEqual(["b", "a"]);
    });

    it("整个库与具体文件夹可以共存（先命中的那个生效）", () => {
        expect(normalizeFolders([".", "images"])).toEqual(["", "images"]);
    });
});

/**
 * 设置页那一格文本的解析。
 *
 * 与 `normalizeFolders` 分开的理由：拆行产生的 `""`（用户多打了一个回车）
 * 和「整个库」的规范形状长得一模一样，而两者要的处置正好相反 ——
 * 前者必须丢，后者必须留。
 */
describe("parseFolders（设置页文本 → 列表）", () => {
    it("一行一个，丢掉空行", () => {
        expect(parseFolders("attachments\n\nassets/img\n")).toEqual(["attachments", "assets/img"]);
    });

    it("`.` 表示整个库（归一成空串）", () => {
        expect(parseFolders(".")).toEqual([""]);
    });

    it("空行不会把范围悄悄扩大成整个库", () => {
        expect(parseFolders("attachments\n\n")).toEqual(["attachments"]);
    });

    it("全空白时是「没有文件夹」，不是整个库", () => {
        expect(parseFolders("\n\n")).toEqual([]);
    });
});

describe("formatFolders（列表 → 设置页文本）", () => {
    it("空串显示成 `.`（空行读起来像「什么都没填」，而它正是默认值）", () => {
        expect(formatFolders([""])).toBe(".");
        expect(formatFolders(["attachments", ""])).toBe("attachments\n.");
    });
});

describe("isInsideFolders", () => {
    it("空列表表示什么都不管", () => {
        expect(isInsideFolders("a.png", [])).toBe(false);
    });

    it("空串表示整个库", () => {
        expect(isInsideFolders("any/where/a.png", [""])).toBe(true);
        expect(isInsideFolders("a.png", [""])).toBe(true);
    });

    it("前缀命中", () => {
        expect(isInsideFolders("images/a.png", ["images"])).toBe(true);
        expect(isInsideFolders("images/2026/a.png", ["images"])).toBe(true);
    });

    it("文件夹自身也算在范围内", () => {
        expect(isInsideFolders("images", ["images"])).toBe(true);
    });

    /**
     * 前缀判断**必须带斜杠** —— 这是这个函数最容易写错、后果也最重的一条。
     *
     * 不带斜杠时 `attachments-old/a.png`.startsWith("attachments") 为真，
     * 于是**范围外的文件会被同步、进而被删除**。用户配的是 `attachments`，
     * 却动了 `attachments-old`。
     */
    it("`attachments` 不覆盖 `attachments-old`（前缀要带斜杠）", () => {
        expect(isInsideFolders("attachments-old/a.png", ["attachments"])).toBe(false);
        expect(isInsideFolders("attachments2/a.png", ["attachments"])).toBe(false);
        expect(isInsideFolders("attachments/a.png", ["attachments"])).toBe(true);
    });

    it("多个文件夹取并集", () => {
        expect(isInsideFolders("a/1.png", ["b", "a"])).toBe(true);
        expect(isInsideFolders("c/1.png", ["b", "a"])).toBe(false);
    });
});

describe("scanLocalImages", () => {
    it("一个文件夹都没配时返回空（**不碰任何文件**）", () => {
        const vault = createFakeImageVault();
        vault.seed("images/a.png");

        expect(scanLocalImages(vault.app, [])).toEqual([]);
    });

    it("只收受管文件夹里的图片", () => {
        const vault = createFakeImageVault();
        vault.seed("images/a.png", { bytes: 100, mtime: 5 });
        vault.seed("images/notes.md");
        vault.seed("other/b.png");
        vault.seed("templates/diagram.svg");

        const found = scanLocalImages(vault.app, ["images"]);

        expect(found).toEqual([{ path: "images/a.png", size: 100, mtime: 5 }]);
    });

    it("按路径排序，让界面上的顺序稳定", () => {
        const vault = createFakeImageVault();
        vault.seed("images/c.png");
        vault.seed("images/a.png");
        vault.seed("images/b.png");

        expect(scanLocalImages(vault.app, ["images"]).map((image) => image.path)).toEqual([
            "images/a.png",
            "images/b.png",
            "images/c.png",
        ]);
    });

    it("带上 size 与 mtime（差异判定全靠这两个值）", () => {
        const vault = createFakeImageVault();
        vault.seed("images/a.png", { bytes: 4242, mtime: 987654 });

        const [image] = scanLocalImages(vault.app, ["images"]);
        expect(image!.size).toBe(4242);
        expect(image!.mtime).toBe(987654);
    });

    it("空串表示整个库（这时连库根的图片也收）", () => {
        const vault = createFakeImageVault();
        vault.seed("a.png");
        vault.seed("deep/nested/b.png");
        vault.seed("c.md");

        expect(scanLocalImages(vault.app, [""]).map((image) => image.path)).toEqual([
            "a.png",
            "deep/nested/b.png",
        ]);
    });
});
