import { ImageSyncError } from "../errors";
import { mimeFor, outputSize, type OutputFormat } from "../imageEditor";
import { isEditableImage } from "../imageScan";
import { contentTypeFor } from "../imageSyncService";

/**
 * 批量压缩的画布部分。
 *
 * ## 为什么单独一个文件
 *
 * 这里碰 `document` / `Image` / `canvas`，于是它**没法在 Node 里跑**。
 * 裁剪与压缩的纯计算（尺寸、格式、路径）留在 `imageEditor.ts` 里被单测覆盖，
 * 这一层只负责「把字节喂给画布、再拿回字节」。分界线的判据是「有没有碰 DOM」，
 * 与 `ui/ImageEditorModal.ts` 的分法一致。
 *
 * ## 批量压缩**不改容器**
 *
 * 单张编辑时用户能选输出格式（`{name}-edited.webp` 之类，路径由他自己确认）。
 * 批量压缩不提供这个 —— 换容器意味着**改文件名**，而文件名被笔记里的链接
 * 指着，一次批量操作改掉几十个文件名（哪怕 Obsidian 会跟着更新链接）是
 * 用户很难复核的事。所以这里一律保持原扩展名：质量与最长边照设，容器不动。
 * 界面上要把这一点说出来，不能让用户以为它按「默认输出格式」跑了。
 */

export interface CompressOptions {
    /** 有损格式的质量（10–100）。 */
    quality: number;
    /** 最长边上限（像素）。0 = 不缩放。**只缩不放**。 */
    maxEdge: number;
}

export interface CompressOutcome {
    /** 重编码后的字节。 */
    buffer: ArrayBuffer;
    /** 重编码前的大小。 */
    before: number;
    /** 重编码后的大小。 */
    after: number;
}

/**
 * 重新编码一份图片字节。
 *
 * 返回结果**不判断「值不值得写回去」** —— 那个决定（只在更小时才覆盖）留给
 * 调用方，因为它是产品决策而不是编码细节：写一个更大的文件回去是纯粹的损失，
 * 但「多大算大」要看原图。
 *
 * 解码失败抛 `decodeFailed`（与单张编辑同一个错误类型），由调用方逐条记下
 * 并继续处理下一张 —— 一张坏图不该中断整批。
 */
export async function compressImageBuffer(
    buffer: ArrayBuffer,
    path: string,
    options: CompressOptions
): Promise<CompressOutcome> {
    if (!isEditableImage(path)) {
        // svg 是矢量（画布会栅格化，那不是压缩是毁图）；gif 经画布只剩第一帧。
        throw new ImageSyncError("decodeFailed", { path });
    }

    const objectUrl = URL.createObjectURL(new Blob([buffer], { type: contentTypeFor(path) }));
    try {
        const image = await loadImage(objectUrl, path);
        const size = outputSize(
            { x: 0, y: 0, width: image.naturalWidth, height: image.naturalHeight },
            options.maxEdge
        );

        // 「保持原样」在批量里就是「原扩展名对应的容器」，见文件头。
        const format: OutputFormat = "keep";
        const mime = mimeFor(format, path);

        // 同 ImageEditorModal：走全局 `createEl`（审核规则 `prefer-create-el`）。
        const canvas = createEl("canvas");
        canvas.width = size.width;
        canvas.height = size.height;

        const context = canvas.getContext("2d");
        if (!context) throw new ImageSyncError("decodeFailed", { path });

        // JPEG 没有透明通道：不铺底色的话透明区域会变成黑色。
        if (mime === "image/jpeg") {
            context.fillStyle = "#ffffff";
            context.fillRect(0, 0, size.width, size.height);
        }
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = "high";
        context.drawImage(image, 0, 0, size.width, size.height);

        const encoded = await canvasToArrayBuffer(canvas, mime, options.quality / 100, path);
        return { buffer: encoded, before: buffer.byteLength, after: encoded.byteLength };
    } finally {
        // 不释放的话，一次批量压缩几十张会一直占着这些 blob（它们不会被回收，
        // 因为 URL 还指向它们）。见 MDN 关于 createObjectURL 生命周期的说明。
        URL.revokeObjectURL(objectUrl);
    }
}

function loadImage(objectUrl: string, path: string): Promise<HTMLImageElement> {
    return new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new ImageSyncError("decodeFailed", { path }));
        image.src = objectUrl;
    });
}

/** `toBlob` 的回调可能拿到 `null`（画布过大、格式不支持）—— 抛错比写空文件好。 */
function canvasToArrayBuffer(
    canvas: HTMLCanvasElement,
    mime: string,
    quality: number,
    path: string
): Promise<ArrayBuffer> {
    return new Promise<ArrayBuffer>((resolve, reject) => {
        canvas.toBlob(
            (blob) => {
                if (!blob) {
                    reject(new ImageSyncError("decodeFailed", { path }));
                    return;
                }
                void blob.arrayBuffer().then(resolve, reject);
            },
            mime,
            quality
        );
    });
}
