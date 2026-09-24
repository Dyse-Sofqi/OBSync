import { afterEach, describe, expect, it, vi } from "vitest";
import {
    EDITED_SUFFIX,
    OUTPUT_FORMATS,
    applyAspectRatio,
    aspectRatioOf,
    buildOutputPath,
    clampCropRect,
    defaultCrop,
    extensionFor,
    isLossy,
    mimeFor,
    outputSize,
    resolveFormat,
    scaleCropRect,
    uniquePath,
} from "../../../src/features/images/imageEditor";

/**
 * 裁剪与压缩的纯计算部分。
 *
 * 这一层不碰 DOM，所以能在 Node 里被完整覆盖 —— 而它决定了**导出文件的像素
 * 与容器**，错了的表现是「裁完有黑边」「竖图没被压缩」这类只有用户看得见的
 * 问题。画布那一半（`ui/ImageEditorModal.ts`）只在真机上跑，靠这里的判据正确
 * 来保证它拿到的参数是对的。
 */

describe("defaultCrop", () => {
    it("默认是整张图", () => {
        expect(defaultCrop({ width: 5, height: 3 })).toEqual({
            x: 0,
            y: 0,
            width: 5,
            height: 3,
        });
    });
});

describe("clampCropRect", () => {
    const source = { width: 100, height: 50 };

    it("超出范围的矩形被钳回来", () => {
        expect(clampCropRect({ x: -10, y: -10, width: 200, height: 200 }, source)).toEqual({
            x: 0,
            y: 0,
            width: 100,
            height: 50,
        });
    });

    it("右/下越界时靠左上角不动、只挪原点", () => {
        // 拖到图外时选框允许越界（那样手感才对），但画布拿到越界矩形会画出
        // 一块透明 —— 用户看到的是「裁完有黑边」，原因却在几百行之外。
        expect(clampCropRect({ x: 90, y: 40, width: 50, height: 30 }, source)).toEqual({
            x: 50,
            y: 20,
            width: 50,
            height: 30,
        });
    });

    it("取整（小数会带来半像素的模糊边缘）", () => {
        expect(clampCropRect({ x: 0.4, y: 0.6, width: 10.5, height: 4.4 }, source)).toEqual({
            x: 0,
            y: 1,
            width: 11,
            height: 4,
        });
    });

    it("宽高最小为 1（0 会让画布直接失败）", () => {
        expect(clampCropRect({ x: 0, y: 0, width: 0, height: 0 }, source)).toEqual({
            x: 0,
            y: 0,
            width: 1,
            height: 1,
        });
    });

    it("负数宽高也被抬到 1", () => {
        expect(clampCropRect({ x: 0, y: 0, width: -5, height: -5 }, source)).toEqual({
            x: 0,
            y: 0,
            width: 1,
            height: 1,
        });
    });
});

describe("scaleCropRect", () => {
    it("四个分量一起乘", () => {
        expect(scaleCropRect({ x: 1, y: 2, width: 3, height: 4 }, 2)).toEqual({
            x: 2,
            y: 4,
            width: 6,
            height: 8,
        });
    });

    it("倍数 1 是恒等", () => {
        const rect = { x: 1, y: 2, width: 3, height: 4 };
        expect(scaleCropRect(rect, 1)).toEqual(rect);
    });
});

describe("outputSize", () => {
    it("按最长边等比缩放（横图）", () => {
        expect(outputSize({ x: 0, y: 0, width: 4000, height: 3000 }, 1600)).toEqual({
            width: 1600,
            height: 1200,
        });
    });

    /**
     * 这条是这个函数存在的理由。
     *
     * 竖构图的照片（手机截图、海报）宽度本来就小，**按宽度**限制等于什么也没做：
     * 用户设了「不超过 1600」，导出的图却还是 4000 高。
     */
    it("竖图按高度限制（按宽度限制会等于什么都没做）", () => {
        expect(outputSize({ x: 0, y: 0, width: 1200, height: 4000 }, 1600)).toEqual({
            width: 480,
            height: 1600,
        });
    });

    it("**只缩不放**：小图原样保留", () => {
        expect(outputSize({ x: 0, y: 0, width: 300, height: 200 }, 1600)).toEqual({
            width: 300,
            height: 200,
        });
    });

    it("最长边等于上限时不动", () => {
        expect(outputSize({ x: 0, y: 0, width: 1600, height: 900 }, 1600)).toEqual({
            width: 1600,
            height: 900,
        });
    });

    it("maxEdge <= 0 表示不限制", () => {
        expect(outputSize({ x: 0, y: 0, width: 4000, height: 3000 }, 0)).toEqual({
            width: 4000,
            height: 3000,
        });
        expect(outputSize({ x: 0, y: 0, width: 4000, height: 3000 }, -1)).toEqual({
            width: 4000,
            height: 3000,
        });
    });

    it("取整，且两条边都不会缩到 0", () => {
        expect(outputSize({ x: 0, y: 0, width: 1000, height: 333 }, 100)).toEqual({
            width: 100,
            height: 33,
        });
        // 极扁的图缩到 1px 上限：短边会算出 0.01，必须抬到 1 —— 0 会让画布失败。
        expect(outputSize({ x: 0, y: 0, width: 1000, height: 10 }, 1)).toEqual({
            width: 1,
            height: 1,
        });
    });

    it("先用取整后的裁剪尺寸算，避免与画布尺寸差一个像素", () => {
        expect(outputSize({ x: 0, y: 0, width: 100.6, height: 100.4 }, 0)).toEqual({
            width: 101,
            height: 100,
        });
    });
});

describe("resolveFormat", () => {
    it("keep 按原扩展名解析", () => {
        expect(resolveFormat("keep", "a.png")).toBe("png");
        expect(resolveFormat("keep", "a.webp")).toBe("webp");
        expect(resolveFormat("keep", "a.jpg")).toBe("jpeg");
        expect(resolveFormat("keep", "a.jpeg")).toBe("jpeg");
    });

    it("keep 时扩展名大小写不影响", () => {
        expect(resolveFormat("keep", "a.PNG")).toBe("png");
        expect(resolveFormat("keep", "a.JPEG")).toBe("jpeg");
    });

    /**
     * avif → webp：浏览器对 avif **编码**的支持远差于解码（Safari 至今不能
     * 从画布导出 avif），硬写 avif 会得到一个空的 blob。webp 是同类里
     * 编码支持最广的，压缩率也接近。
     */
    it("avif 落回 webp（画布不能可靠地导出 avif）", () => {
        expect(resolveFormat("keep", "a.avif")).toBe("webp");
    });

    /**
     * bmp → jpeg：bmp 是无压缩格式，转 jpeg 是纯赚；而「保持原样」写成 bmp
     * 只会让文件更大 —— 那不是用户要的「压缩」。
     */
    it("bmp 落回 jpeg", () => {
        expect(resolveFormat("keep", "a.bmp")).toBe("jpeg");
    });

    it("没有扩展名 / 认不出的扩展名也落回 jpeg", () => {
        expect(resolveFormat("keep", "README")).toBe("jpeg");
        expect(resolveFormat("keep", "a.gif")).toBe("jpeg");
    });

    it("显式指定的格式覆盖原扩展名", () => {
        expect(resolveFormat("png", "a.jpg")).toBe("png");
        expect(resolveFormat("jpeg", "a.png")).toBe("jpeg");
        expect(resolveFormat("webp", "a.png")).toBe("webp");
    });
});

describe("mimeFor", () => {
    it("按解析后的格式给 MIME", () => {
        expect(mimeFor("keep", "a.png")).toBe("image/png");
        expect(mimeFor("keep", "a.jpg")).toBe("image/jpeg");
        expect(mimeFor("keep", "a.avif")).toBe("image/webp");
        expect(mimeFor("webp", "a.png")).toBe("image/webp");
    });
});

describe("isLossy", () => {
    it("jpeg 与 webp 有质量可言，png 没有", () => {
        expect(isLossy("keep", "a.jpg")).toBe(true);
        expect(isLossy("keep", "a.webp")).toBe(true);
        expect(isLossy("keep", "a.png")).toBe(false);
        expect(isLossy("png", "a.jpg")).toBe(false);
        expect(isLossy("webp", "a.png")).toBe(true);
    });
});

describe("extensionFor", () => {
    it("jpeg 落到 .jpg（不是 .jpeg）", () => {
        expect(extensionFor("keep", "a.jpeg")).toBe("jpg");
        expect(extensionFor("jpeg", "a.png")).toBe("jpg");
    });

    it("png / webp 同名", () => {
        expect(extensionFor("keep", "a.png")).toBe("png");
        expect(extensionFor("keep", "a.avif")).toBe("webp");
    });
});

describe("buildOutputPath", () => {
    it("同目录下加后缀", () => {
        expect(buildOutputPath("images/a.png", "keep", EDITED_SUFFIX)).toBe(
            "images/a-edited.png"
        );
    });

    it("库根下的文件不带前导斜杠", () => {
        expect(buildOutputPath("a.png", "keep", EDITED_SUFFIX)).toBe("a-edited.png");
    });

    it("多层目录保留", () => {
        expect(buildOutputPath("a/b/c.jpg", "jpeg", EDITED_SUFFIX)).toBe("a/b/c-edited.jpg");
    });

    it("换格式时同时换扩展名", () => {
        expect(buildOutputPath("images/a.png", "jpeg", EDITED_SUFFIX)).toBe(
            "images/a-edited.jpg"
        );
    });

    it("没有扩展名的文件补上解析后的扩展名", () => {
        expect(buildOutputPath("images/README", "keep", EDITED_SUFFIX)).toBe(
            "images/README-edited.jpg"
        );
    });

    it("点开头的文件名不被当成扩展名（`.` 之后整段都是名字）", () => {
        expect(buildOutputPath("images/.hidden", "keep", EDITED_SUFFIX)).toBe(
            "images/.hidden-edited.jpg"
        );
    });

    it("目录名里的点不参与切分", () => {
        expect(buildOutputPath("v1.0/a.png", "keep", EDITED_SUFFIX)).toBe(
            "v1.0/a-edited.png"
        );
    });
});

describe("uniquePath", () => {
    it("没被占用时原样返回", () => {
        expect(uniquePath("a-edited.png", () => false)).toBe("a-edited.png");
    });

    it("被占用时依次试 -2 -3", () => {
        const taken = new Set(["a-edited.png", "a-edited-2.png"]);
        expect(uniquePath("a-edited.png", (path) => taken.has(path))).toBe("a-edited-3.png");
    });

    it("把编号插在扩展名之前", () => {
        expect(uniquePath("a.png", (path) => path === "a.png")).toBe("a-2.png");
    });

    it("没有扩展名时直接追加编号", () => {
        expect(uniquePath("README", (path) => path === "README")).toBe("README-2");
    });

    it("编号全被占满时退回时间戳（不覆盖任何文件）", () => {
        // 1000 个同名文件是极端情况，但**宁可多一个丑名字，也不覆盖**。
        const now = vi.spyOn(Date, "now").mockReturnValue(1700000000000);
        try {
            expect(uniquePath("a.png", () => true)).toBe("a-1700000000000.png");
        } finally {
            now.mockRestore();
        }
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });
});

describe("applyAspectRatio", () => {
    const source = { width: 1000, height: 1000 };

    it("ratio 为 undefined / 非正数时只做钳制", () => {
        const rect = { x: 0, y: 0, width: 200, height: 300 };
        expect(applyAspectRatio(rect, source, undefined)).toEqual(rect);
        expect(applyAspectRatio(rect, source, 0)).toEqual(rect);
    });

    it("1:1 时宽高取原宽度", () => {
        expect(applyAspectRatio({ x: 0, y: 0, width: 100, height: 100 }, source, 1)).toEqual({
            x: 0,
            y: 0,
            width: 100,
            height: 100,
        });
    });

    it("宽高比 2:1 时高度减半", () => {
        expect(applyAspectRatio({ x: 0, y: 0, width: 100, height: 100 }, source, 2)).toEqual({
            x: 0,
            y: 0,
            width: 100,
            height: 50,
        });
    });

    it("高度超出源图时反过来按高度定宽度", () => {
        // 源图只有 100 高，2:1 的框宽 100 会算出高 50（没问题）；
        // 换成 0.5:1（竖长）就会顶到边界，必须回退。
        const source100 = { width: 100, height: 100 };
        expect(
            applyAspectRatio({ x: 0, y: 0, width: 100, height: 100 }, source100, 0.5)
        ).toEqual({ x: 0, y: 0, width: 50, height: 100 });
    });

    it("宽度超出源图时再按宽度定高度", () => {
        const wide = { width: 100, height: 1000 };
        expect(applyAspectRatio({ x: 0, y: 0, width: 100, height: 100 }, wide, 0.05)).toEqual({
            x: 0,
            y: 0,
            width: 50,
            height: 1000,
        });
    });

    /**
     * `anchor` 决定从哪个角出发调整。
     *
     * 拖**左上角**时右下角该不动（否则选框会「自己跑」，手感很差）——
     * 所以那一路传 `bottom-right`。
     */
    it("bottom-right 锚点时右下角固定、左上角让位", () => {
        expect(
            applyAspectRatio(
                { x: 10, y: 10, width: 100, height: 100 },
                source,
                2,
                "bottom-right"
            )
        ).toEqual({ x: 10, y: 60, width: 100, height: 50 });
    });

    it("top-left 锚点时左上角固定", () => {
        expect(
            applyAspectRatio({ x: 10, y: 10, width: 100, height: 100 }, source, 2, "top-left")
        ).toEqual({ x: 10, y: 10, width: 100, height: 50 });
    });

    it("结果始终落在源图范围内", () => {
        const rect = applyAspectRatio(
            { x: 990, y: 990, width: 100, height: 100 },
            source,
            2,
            "bottom-right"
        );
        expect(rect.x).toBeGreaterThanOrEqual(0);
        expect(rect.y).toBeGreaterThanOrEqual(0);
        expect(rect.x + rect.width).toBeLessThanOrEqual(source.width);
        expect(rect.y + rect.height).toBeLessThanOrEqual(source.height);
    });
});

describe("aspectRatioOf", () => {
    it("宽 / 高", () => {
        expect(aspectRatioOf({ width: 1920, height: 1080 })).toBeCloseTo(16 / 9);
        expect(aspectRatioOf({ width: 100, height: 100 })).toBe(1);
    });

    it("宽高非法时返回 undefined（调用方按「不锁比例」处理）", () => {
        expect(aspectRatioOf({ width: 0, height: 100 })).toBeUndefined();
        expect(aspectRatioOf({ width: 100, height: 0 })).toBeUndefined();
        expect(aspectRatioOf({ width: -1, height: 100 })).toBeUndefined();
    });
});

describe("OUTPUT_FORMATS", () => {
    it("第一项是 keep（界面上是默认值）", () => {
        expect(OUTPUT_FORMATS[0]).toBe("keep");
        expect(OUTPUT_FORMATS).toContain("jpeg");
        expect(OUTPUT_FORMATS).toContain("webp");
        expect(OUTPUT_FORMATS).toContain("png");
    });
});
