import { extensionOf } from "./imageScan";

/**
 * 裁剪与压缩的**纯计算**部分。
 *
 * 画布（`document.createElement("canvas")`）那一半在 `ui/ImageEditorModal.ts` 里 ——
 * 这样这里的一切都能在 Node 环境下被单测覆盖，而画布代码只在真机上跑。
 * 分界线的判据是「有没有碰 DOM」，不是「像不像工具函数」。
 */

export interface Size {
    width: number;
    height: number;
}

/** 源图坐标系里的一个矩形（像素，左上角原点）。 */
export interface CropRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

/**
 * 输出格式。
 *
 * `keep` = 保持原扩展名。它不是「不压缩」—— 原格式是 jpeg 时照样按质量重编码，
 * 只是不换容器。想让用户理解这一点，界面上的文案要说「格式：保持原样」，
 * 而不是「格式：无」。
 */
export type OutputFormat = "keep" | "jpeg" | "webp" | "png";

export const OUTPUT_FORMATS: OutputFormat[] = ["keep", "jpeg", "webp", "png"];

/** 整张图。 */
export function defaultCrop(source: Size): CropRect {
    return { x: 0, y: 0, width: source.width, height: source.height };
}

/**
 * 把矩形钳进源图范围，并取整。
 *
 * 必须做，而且要在**每次拖动之后**做：选框允许被拖到图外（那样手感才对），
 * 但画布 `drawImage` 拿到越界矩形会画出一块透明 —— 用户看到的是「裁完有黑边」，
 * 而原因在几百行之外。取整是因为画布坐标最终要变成像素索引，
 * 小数会带来半像素的模糊边缘。
 */
export function clampCropRect(rect: CropRect, source: Size): CropRect {
    const width = Math.max(1, Math.min(Math.round(rect.width), source.width));
    const height = Math.max(1, Math.min(Math.round(rect.height), source.height));
    const x = Math.max(0, Math.min(Math.round(rect.x), source.width - width));
    const y = Math.max(0, Math.min(Math.round(rect.y), source.height - height));
    return { x, y, width, height };
}

/** 把显示坐标下的矩形换算成源图坐标。 */
export function scaleCropRect(rect: CropRect, factor: number): CropRect {
    return {
        x: rect.x * factor,
        y: rect.y * factor,
        width: rect.width * factor,
        height: rect.height * factor,
    };
}

/**
 * 最终的输出尺寸：先裁剪，再按**最长边**等比缩放。
 *
 * 为什么限制的是最长边而不是宽度：竖构图的照片（手机截图、海报）宽度本来就小，
 * 按宽度限制等于什么也没做 —— 用户设了「不超过 1600」，导出的图却还是 4000 高。
 *
 * `maxEdge <= 0` 表示不限制。**只缩不放** —— 把一张 300px 的图放大到 1600px
 * 只会让它更模糊、更大，那不是用户要的「压缩」。
 */
export function outputSize(crop: CropRect, maxEdge: number): Size {
    const cropped: Size = {
        width: Math.max(1, Math.round(crop.width)),
        height: Math.max(1, Math.round(crop.height)),
    };
    const longest = Math.max(cropped.width, cropped.height);
    if (maxEdge <= 0 || longest <= maxEdge) return cropped;

    const factor = maxEdge / longest;
    return {
        width: Math.max(1, Math.round(cropped.width * factor)),
        height: Math.max(1, Math.round(cropped.height * factor)),
    };
}

/** 这个格式最终写到哪个容器里。 */
export function resolveFormat(format: OutputFormat, originalPath: string): Exclude<
    OutputFormat,
    "keep"
> {
    if (format !== "keep") return format;

    const extension = extensionOf(originalPath);
    if (extension === "png") return "png";
    if (extension === "webp") return "webp";
    if (extension === "avif") return "webp";
    // jpg / jpeg / bmp / 其他 → jpeg。bmp 是无压缩格式，转 jpeg 是纯赚；
    // 而「保持原样」写成 bmp 只会让文件更大。
    return "jpeg";
}

export function mimeFor(format: OutputFormat, originalPath: string): string {
    switch (resolveFormat(format, originalPath)) {
        case "png":
            return "image/png";
        case "webp":
            return "image/webp";
        case "jpeg":
            return "image/jpeg";
    }
}

/** 有损格式才有「质量」可言 —— png 的质量滑块要灰掉，而不是拨了没反应。 */
export function isLossy(format: OutputFormat, originalPath: string): boolean {
    const resolved = resolveFormat(format, originalPath);
    return resolved === "jpeg" || resolved === "webp";
}

export function extensionFor(format: OutputFormat, originalPath: string): string {
    const resolved = resolveFormat(format, originalPath);
    return resolved === "jpeg" ? "jpg" : resolved;
}

/**
 * 另存时的目标路径：同目录下 `<原名>-edited.<ext>`。
 *
 * 放同目录而不是固定的某个文件夹：图片在笔记里是**相对路径引用**的，
 * 另存到别处会让它脱离原来的引用语境，用户还得手动改链接。
 */
export function buildOutputPath(
    originalPath: string,
    format: OutputFormat,
    suffix: string
): string {
    const slash = originalPath.lastIndexOf("/");
    const directory = slash < 0 ? "" : originalPath.slice(0, slash + 1);
    const name = slash < 0 ? originalPath : originalPath.slice(slash + 1);
    const dot = name.lastIndexOf(".");
    const stem = dot <= 0 ? name : name.slice(0, dot);
    return `${directory}${stem}${suffix}.${extensionFor(format, originalPath)}`;
}

/** 目标路径被占用时依次试 `-2` `-3` …，避免覆盖已有文件。 */
export function uniquePath(
    candidate: string,
    exists: (path: string) => boolean
): string {
    if (!exists(candidate)) return candidate;

    const dot = candidate.lastIndexOf(".");
    const stem = dot <= 0 ? candidate : candidate.slice(0, dot);
    const extension = dot <= 0 ? "" : candidate.slice(dot);

    for (let index = 2; index < 1000; index++) {
        const next = `${stem}-${index}${extension}`;
        if (!exists(next)) return next;
    }
    return `${stem}-${Date.now()}${extension}`;
}

/**
 * 把矩形按给定宽高比修正。
 *
 * `anchor` 决定从哪个角出发调整 —— 拖右下角时左上角该不动，否则选框会
 * 「自己跑」，手感很差。宽度优先：先按宽度定高度，超出源图高度时再反过来按高度定宽度。
 */
export function applyAspectRatio(
    rect: CropRect,
    source: Size,
    ratio: number | undefined,
    anchor: "top-left" | "bottom-right" = "top-left"
): CropRect {
    if (ratio === undefined || ratio <= 0) return clampCropRect(rect, source);

    let width = rect.width;
    let height = width / ratio;

    if (height > source.height) {
        height = source.height;
        width = height * ratio;
    }
    if (width > source.width) {
        width = source.width;
        height = width / ratio;
    }

    if (anchor === "bottom-right") {
        // 右下角固定：左上角跟着让位。
        return clampCropRect(
            { x: rect.x + rect.width - width, y: rect.y + rect.height - height, width, height },
            source
        );
    }
    return clampCropRect({ x: rect.x, y: rect.y, width, height }, source);
}

/** 源图的宽高比（宽 / 高）。宽高非法时返回 undefined，让调用方按「不锁」处理。 */
export function aspectRatioOf(size: Size): number | undefined {
    if (size.width <= 0 || size.height <= 0) return undefined;
    return size.width / size.height;
}

/** 输出文件名里那个后缀的默认值。 */
export const EDITED_SUFFIX = "-edited";
