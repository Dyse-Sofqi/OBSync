import { Modal, Setting, type App, type TFile } from "obsidian";
import type { LocaleStrings } from "../../../core/i18n";
import { formatBytes } from "../../sync/repoSize";
import { ImageSyncError } from "../errors";
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
    uniquePath,
    type CropRect,
    type OutputFormat,
    type Size,
} from "../imageEditor";
import { isEditableImage } from "../imageScan";
import { contentTypeFor } from "../imageSyncService";

/**
 * 裁剪 / 压缩弹窗。
 *
 * ## 交互取舍
 *
 * 没有做「在图上直接画一个新选框」：默认就是整张图，用户要调的是**边界**，
 * 拖四个角 + 拖整块移动已经能覆盖全部场景，而「画新框」多一套状态机
 * （按下点、方向、最小尺寸…），出错时的表现是「选框跳到别处」，很难解释。
 *
 * ## 为什么预览的是**真实字节数**
 *
 * 压缩这件事用户唯一在意的是「小了多少」。用公式估一个数（`宽 × 高 × 0.5`）
 * 在 jpeg 上能差两三倍 —— 那是编数字。这里用同一个画布真的编码一遍，
 * 拿到 `blob.size` 再显示，代价是每次改参数多花十几毫秒（做了防抖）。
 *
 * ## 保存
 *
 * 两种模式：**覆盖原图**（默认）与**另存为新文件**。覆盖是绝大多数人的意图
 * （图片在笔记里已经被引用，另存会让链接指着旧文件），但它不可撤销 ——
 * 所以文案里要说清楚，且另存那条路默认给出 `-edited` 后缀的路径。
 */

export interface ImageEditorDeps {
    app: App;
    getT(): LocaleStrings;
    /** 保存成功之后调用（顺手把这一张推到云端）。 */
    onSaved?(file: TFile): void;
    /** 保存失败时的出口 —— 弹窗不负责决定怎么提示用户。 */
    onError?(error: unknown): void;
    /** 默认参数来自设置页（质量 / 最长边 / 格式）。 */
    defaults(): { quality: number; maxEdge: number; format: OutputFormat };
}

interface DragStart {
    mode: "move" | "nw" | "ne" | "sw" | "se";
    pointerX: number;
    pointerY: number;
    rect: CropRect;
}

const CORNERS = ["nw", "ne", "sw", "se"] as const;

/**
 * 四个角把手的完整类名。
 *
 * 写成一整张表而不是 `` `obsync-crop-handle-${corner}` ``：模板串拼出来的类名
 * 在源码里只留下 `obsync-crop-handle-` 这半截，项目自查（`scripts/checks.mjs`）
 * 的「CSS 类覆盖」会把它报成「用了但没定义」，而四个真正用到的类名一个也认不出。
 */
const CORNER_CLASSES: Record<(typeof CORNERS)[number], string> = {
    nw: "obsync-crop-handle obsync-crop-handle-nw",
    ne: "obsync-crop-handle obsync-crop-handle-ne",
    sw: "obsync-crop-handle obsync-crop-handle-sw",
    se: "obsync-crop-handle obsync-crop-handle-se",
};

export class ImageEditorModal extends Modal {
    private readonly t: LocaleStrings;
    private img!: HTMLImageElement;
    private stage!: HTMLElement;
    private box!: HTMLElement;
    private summary!: HTMLElement;

    private source: Size = { width: 1, height: 1 };
    private rect: CropRect = { x: 0, y: 0, width: 1, height: 1 };
    /** 显示像素 → 源图像素的倍数。 */
    private scale = 1;

    private format: OutputFormat;
    private quality: number;
    private maxEdge: number;
    private overwrite = true;
    private ratio: number | undefined;
    private objectUrl = "";
    private previewBytes: number | undefined;
    private previewTimer: number | undefined;
    private saving = false;

    constructor(
        app: App,
        private readonly file: TFile,
        private readonly deps: ImageEditorDeps
    ) {
        super(app);
        this.t = deps.getT();
        const defaults = deps.defaults();
        this.format = defaults.format;
        this.quality = defaults.quality;
        this.maxEdge = defaults.maxEdge;
    }

    async onOpen(): Promise<void> {
        const t = this.t.images.editor;
        this.titleEl.setText(t.title(this.file.name));

        if (!isEditableImage(this.file.path)) {
            // svg 与 gif 走画布会被毁掉（栅格化 / 只剩第一帧）。这里明确拒绝并说明，
            // 而不是产出一个用户没预期的文件。
            this.contentEl.createEl("p", { text: t.unsupported });
            return;
        }

        let buffer: ArrayBuffer;
        try {
            buffer = await this.deps.app.vault.readBinary(this.file);
        } catch {
            this.contentEl.createEl("p", { text: t.readFailed });
            return;
        }

        try {
            this.source = await this.loadImage(buffer);
        } catch {
            this.contentEl.createEl("p", { text: t.decodeFailed });
            return;
        }
        this.rect = defaultCrop(this.source);
        this.ratio = aspectRatioOf(this.source);

        this.stage = this.contentEl.createDiv({ cls: "obsync-crop-stage" });
        this.img = this.stage.createEl("img", { cls: "obsync-crop-image" });
        this.img.src = this.objectUrl;

        this.box = this.stage.createDiv({ cls: "obsync-crop-box" });
        // 类名写成**显式字面量**而不是模板串拼接：拼出来的类名 grep 不到，
        // 项目自查（scripts/checks.mjs）会把它们报成「定义了没用到」——
        // 它只认得出 `obsync-crop-handle-` 这半截，四个角一个都认不出。
        for (const corner of CORNERS) {
            const handle = this.box.createDiv({ cls: CORNER_CLASSES[corner] });
            handle.addEventListener("pointerdown", (event) => this.beginDrag(event, corner));
        }
        this.box.addEventListener("pointerdown", (event) => this.beginDrag(event, "move"));

        // 布局完成后再量尺寸 —— 此刻 `clientWidth` 才有值。
        this.measure();
        this.renderBox();

        this.summary = this.contentEl.createEl("p", { cls: "obsync-image-summary" });

        this.renderControls();
        this.renderActions();
        this.refreshPreview();
    }

    onClose(): void {
        if (this.previewTimer !== undefined) window.clearTimeout(this.previewTimer);
        if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
        this.contentEl.empty();
    }

    // ── 图像加载 ──────────────────────────────────────────────────────────

    /**
     * 解码图片，拿到原始像素尺寸。
     *
     * 用独立的 `Image` 探针而不是直接等 `this.img` 的 onload：探针在
     * 布局完成**之前**就能给出 `naturalWidth`，于是选框可以一次算对，
     * 不会出现「先画在错误位置、布局完成后跳一下」。
     */
    private loadImage(buffer: ArrayBuffer): Promise<Size> {
        return new Promise<Size>((resolve, reject) => {
            const blob = new Blob([buffer], { type: contentTypeFor(this.file.path) });
            this.objectUrl = URL.createObjectURL(blob);
            const probe = new Image();
            probe.onload = () =>
                resolve({ width: probe.naturalWidth, height: probe.naturalHeight });
            probe.onerror = () =>
                reject(new ImageSyncError("decodeFailed", { path: this.file.path }));
            probe.src = this.objectUrl;
        });
    }

    // ── 选框 ──────────────────────────────────────────────────────────────

    /** 量出「显示尺寸 → 源图尺寸」的倍数。量不到（未布局）时按 1 处理。 */
    private measure(): void {
        const displayed = this.img.clientWidth;
        this.scale = displayed > 0 ? this.source.width / displayed : 1;
        if (!Number.isFinite(this.scale) || this.scale <= 0) this.scale = 1;
    }

    private renderBox(): void {
        const style = this.box.style;
        style.left = `${this.rect.x / this.scale}px`;
        style.top = `${this.rect.y / this.scale}px`;
        style.width = `${this.rect.width / this.scale}px`;
        style.height = `${this.rect.height / this.scale}px`;
    }

    private beginDrag(event: PointerEvent, mode: DragStart["mode"]): void {
        event.preventDefault();
        event.stopPropagation();

        const start: DragStart = {
            mode,
            pointerX: event.clientX,
            pointerY: event.clientY,
            rect: { ...this.rect },
        };

        const onMove = (moveEvent: PointerEvent): void => {
            const dx = (moveEvent.clientX - start.pointerX) * this.scale;
            const dy = (moveEvent.clientY - start.pointerY) * this.scale;
            this.rect = this.applyDrag(start, dx, dy);
            this.renderBox();
            this.refreshPreview();
        };

        const onUp = (): void => {
            document.removeEventListener("pointermove", onMove);
            document.removeEventListener("pointerup", onUp);
        };

        document.addEventListener("pointermove", onMove);
        document.addEventListener("pointerup", onUp);
    }

    private applyDrag(start: DragStart, dx: number, dy: number): CropRect {
        const base = start.rect;

        if (start.mode === "move") {
            return clampCropRect(
                { x: base.x + dx, y: base.y + dy, width: base.width, height: base.height },
                this.source
            );
        }

        let left = base.x;
        let top = base.y;
        let right = base.x + base.width;
        let bottom = base.y + base.height;

        if (start.mode === "nw" || start.mode === "sw") left = base.x + dx;
        if (start.mode === "ne" || start.mode === "se") right = base.x + base.width + dx;
        if (start.mode === "nw" || start.mode === "ne") top = base.y + dy;
        if (start.mode === "sw" || start.mode === "se") bottom = base.y + base.height + dy;

        // 允许反向拖过对边（手感上「翻转」比「卡住」自然），取绝对值即可。
        const rect: CropRect = {
            x: Math.min(left, right),
            y: Math.min(top, bottom),
            width: Math.abs(right - left),
            height: Math.abs(bottom - top),
        };

        const anchor = start.mode === "nw" || start.mode === "ne" ? "bottom-right" : "top-left";
        return applyAspectRatio(rect, this.source, this.ratio, anchor);
    }

    // ── 控件 ──────────────────────────────────────────────────────────────

    private renderControls(): void {
        const t = this.t.images.editor;

        new Setting(this.contentEl)
            .setName(t.format)
            .setDesc(t.formatDesc)
            .addDropdown((dropdown) => {
                for (const format of OUTPUT_FORMATS) {
                    dropdown.addOption(format, this.t.images.formatOption[format]);
                }
                dropdown.setValue(this.format);
                dropdown.onChange((value) => {
                    this.format = value as OutputFormat;
                    this.renderControls();
                    this.refreshPreview();
                });
            });

        new Setting(this.contentEl)
            .setName(t.quality)
            .setDesc(t.qualityDesc)
            .addSlider((slider) =>
                slider
                    .setLimits(10, 100, 1)
                    .setValue(this.quality)
                    // png 是无损的，质量滑块对它没有意义 —— 灰掉而不是藏起来，
                    // 让用户看得到「这个格式没有这个参数」。
                    .setDisabled(!isLossy(this.format, this.file.path))
                    .onChange((value) => {
                        this.quality = value;
                        this.refreshPreview();
                    })
            );

        new Setting(this.contentEl)
            .setName(t.maxEdge)
            .setDesc(t.maxEdgeDesc)
            .addText((text) => {
                text.inputEl.type = "number";
                text.inputEl.min = "0";
                text.setValue(String(this.maxEdge));
                text.onChange((value) => {
                    const parsed = Number.parseInt(value, 10);
                    this.maxEdge = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
                    this.refreshPreview();
                });
            });

        new Setting(this.contentEl)
            .setName(t.ratio)
            .setDesc(t.ratioDesc)
            .addDropdown((dropdown) => {
                dropdown.addOption("free", t.ratioFree);
                dropdown.addOption("original", t.ratioOriginal);
                dropdown.addOption("square", t.ratioSquare);
                dropdown.setValue(
                    this.ratio === undefined
                        ? "free"
                        : Math.abs(this.ratio - 1) < 1e-6
                          ? "square"
                          : "original"
                );
                dropdown.onChange((value) => {
                    if (value === "free") this.ratio = undefined;
                    else if (value === "square") this.ratio = 1;
                    else this.ratio = aspectRatioOf(this.source);
                    this.rect = applyAspectRatio(this.rect, this.source, this.ratio);
                    this.renderBox();
                    this.refreshPreview();
                });
            });
    }

    private renderActions(): void {
        const t = this.t.images.editor;

        new Setting(this.contentEl)
            .setName(t.overwrite)
            .setDesc(t.overwriteDesc)
            .addToggle((toggle) =>
                toggle.setValue(this.overwrite).onChange((value) => {
                    this.overwrite = value;
                    this.renderActions();
                })
            );

        const target = this.targetPath();
        this.contentEl.createEl("p", {
            cls: "setting-item-description",
            text: this.overwrite ? t.targetOverwrite(this.file.path) : t.targetNew(target),
        });

        new Setting(this.contentEl)
            .addButton((button) =>
                button.setButtonText(t.reset).onClick(() => {
                    this.rect = defaultCrop(this.source);
                    this.renderBox();
                    this.refreshPreview();
                })
            )
            .addButton((button) =>
                button.setButtonText(t.cancel).onClick(() => this.close())
            )
            .addButton((button) =>
                button
                    .setButtonText(t.save)
                    .setCta()
                    .onClick(async () => {
                        if (this.saving) return;
                        this.saving = true;
                        button.setDisabled(true);
                        button.setButtonText(t.saving);
                        try {
                            await this.save();
                        } finally {
                            this.saving = false;
                        }
                    })
            );
    }

    /** 另存时的目标路径（与现有文件重名就往后编号）。 */
    private targetPath(): string {
        const candidate = buildOutputPath(this.file.path, this.format, EDITED_SUFFIX);
        return uniquePath(candidate, (path) => this.deps.app.vault.getAbstractFileByPath(path) !== null);
    }

    // ── 预览与保存 ────────────────────────────────────────────────────────

    private refreshPreview(): void {
        if (this.previewTimer !== undefined) window.clearTimeout(this.previewTimer);

        const rect = clampCropRect(this.rect, this.source);
        const size = outputSize(rect, this.maxEdge);
        const t = this.t.images.editor;

        // 先给出尺寸（立刻可得），字节数等编码完再补 —— 不让用户盯着空白。
        this.summary.setText(
            t.summary(
                size.width,
                size.height,
                this.previewBytes === undefined ? "…" : formatBytes(this.previewBytes),
                extensionFor(this.format, this.file.path)
            )
        );

        // 防抖：拖动时会连续触发，每次都编码一遍会把主线程占满。
        this.previewTimer = window.setTimeout(() => {
            void this.encode()
                .then((buffer) => {
                    this.previewBytes = buffer.byteLength;
                    this.summary.setText(
                        t.summary(
                            size.width,
                            size.height,
                            formatBytes(buffer.byteLength),
                            extensionFor(this.format, this.file.path)
                        )
                    );
                })
                .catch(() => {
                    this.previewBytes = undefined;
                });
        }, 180);
    }

    private async encode(): Promise<ArrayBuffer> {
        const rect = clampCropRect(this.rect, this.source);
        const size = outputSize(rect, this.maxEdge);
        const mime = mimeFor(this.format, this.file.path);

        // 用 Obsidian 的全局 `createEl`（审核规则 `prefer-create-el`）：
        // 它带主题与无障碍约定，且不会在 popout window 里落到错误的 document 上。
        const canvas = createEl("canvas");
        canvas.width = size.width;
        canvas.height = size.height;

        const context = canvas.getContext("2d");
        if (!context) throw new ImageSyncError("decodeFailed", { path: this.file.path });

        // JPEG 没有透明通道：不铺底色的话透明区域会变成黑色。
        // 只在输出 jpeg 时铺，png / webp 保留透明。
        if (mime === "image/jpeg") {
            context.fillStyle = "#ffffff";
            context.fillRect(0, 0, size.width, size.height);
        }
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = "high";
        context.drawImage(
            this.img,
            rect.x,
            rect.y,
            rect.width,
            rect.height,
            0,
            0,
            size.width,
            size.height
        );

        return await canvasToArrayBuffer(canvas, mime, this.quality / 100);
    }

    private async save(): Promise<void> {
        try {
            const buffer = await this.encode();

            if (this.overwrite) {
                await this.deps.app.vault.modifyBinary(this.file, buffer);
                this.deps.onSaved?.(this.file);
            } else {
                const path = this.targetPath();
                const created = await this.deps.app.vault.createBinary(path, buffer);
                this.deps.onSaved?.(created);
            }
            this.close();
        } catch (error) {
            // 写盘失败不能关窗：用户刚调好的裁剪框还在，关掉就得从头再来一遍。
            this.deps.onError?.(error);
        }
    }
}

/**
 * 画布 → ArrayBuffer。
 *
 * `toBlob` 的回调可能拿到 `null`（画布过大、格式不支持）—— 那时抛错比
 * 静默写一个 0 字节文件好得多。
 */
function canvasToArrayBuffer(
    canvas: HTMLCanvasElement,
    mime: string,
    quality: number
): Promise<ArrayBuffer> {
    return new Promise<ArrayBuffer>((resolve, reject) => {
        canvas.toBlob(
            (blob) => {
                if (!blob) {
                    reject(new ImageSyncError("decodeFailed", { path: "" }));
                    return;
                }
                void blob.arrayBuffer().then(resolve, reject);
            },
            mime,
            quality
        );
    });
}
