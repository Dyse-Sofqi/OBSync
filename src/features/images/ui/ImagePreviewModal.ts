import { Modal, setIcon, TFile, type App } from "obsidian";
import type { LocaleStrings } from "../../../core/i18n";
import { formatBytes } from "../../sync/repoSize";
import { fileNameOf } from "../batchRename";
import { imageSizeOf, type ImageRecord } from "../imageLibrary";
import { fitSize, panLimit, stageSize, type PreviewSize } from "../imagePreview";

/**
 * 图片预览弹窗：点列表里的缩略图打开。
 *
 * ## 为什么不用 Obsidian 自己的打开方式
 *
 * `workspace.openLinkText` 会把这张图当成一个文件在**标签页**里打开，用户得关掉
 * 它才能回到面板。而看缩略图这件事发生在「连续扫一列图」的过程里（哪张能删、
 * 哪张该压），每看一眼都切一次标签页会把这个动作打断成两半。
 *
 * 所以这里是一个就地弹出的弹窗：**不离开面板**，Esc 或点外部就回去。
 *
 * ## 顺手把「判断能不能删」要用的东西放进来
 *
 * 列表里放不下、却决定一张图能不能删的信息是：体积、在不在两边、**谁在引用它**。
 * 这三样本来就在 `ImageRecord` 里，复制过来几乎不花成本 —— 而放大看清一张图之后
 * 紧接着要做的判断就是「留还是删」。所以弹窗不是只有一张图。
 *
 * ## 尺寸：弹窗跟着图片长大，到上限为止，再大才靠拖动（这块返工过两次）
 *
 * - **第一版**：`transform: scale()` 放大 + 舞台 `overflow: hidden`，靠拖动平移。
 *   错在 `transform` **不改变布局** —— 图片放大后只是被裁掉，而且没有任何
 *   「还有多少没看到」的参照。用户报的是「放大的图片被遮挡」。
 * - **第二版**：改成等比放大 `max-width` / `max-height` + 舞台 `overflow: auto`。
 *   被裁的部分能看到了，但要滚动条 —— 用户不要滚动。
 * - **现在**：弹窗宽度是 `fit-content`（见 styles.css），舞台尺寸由 JS 按倍率设置，
 *   于是弹窗**整体跟着图片长大**，直到可用空间的上限；封顶之后图片还更大，才出现
 *   「按住拖动」的抓手与提示。
 *
 * 所以 100% 的定义是「图片**完整**装进可用空间」（`fitSize`），打开即可见全貌；
 * 放大是把这个尺寸**等比放大**，而不是去裁它。
 *
 * 自然尺寸与可用空间只在 `onload` 之后才有值 —— 没测到时舞台不设尺寸，退回 CSS
 * 的兜底（`max-width: 100%` + `max-height`），而不是按 0 去设（那会让图消失）。
 *
 * ## 缩放：档位而不是连续值
 *
 * 倍率取自一张固定的档位表（25% … 400%），滚轮与按钮走同一套。连续缩放会给出
 * `156%` 这种读数，用户看不出「现在到底多大」；而档位是可枚举的，于是「到顶了没有」
 * 能直接体现在按钮的可用性上（到头就灰掉），不必让用户按了半天才发现没反应。
 *
 * ## 滚轮直接缩放
 *
 * 舞台自己**不滚动**（`overflow: hidden`），所以滚轮落在图片上时唯一有意义的动作就是
 * 缩放 —— 普通滚轮直接缩放，Ctrl / Cmd + 滚轮也一样。
 *
 * 唯一的例外是窗口很矮、弹窗整体放不下的时候：那时滚轮让给弹窗内容去滚动，因为用户
 * 想的是「往下看」，而不是「放大」。
 *
 * ## 本地没有那一份时不画图
 *
 * `getResourcePath` 只认库里的文件，云端独有的行拿不到 URL。那种行在列表里本来
 * 就没有缩略图（也就没有入口），正常走不到这里 —— 不画图（连带不画工具条），
 * 而不是画一个破图或一排点了没反应的按钮。
 */

/**
 * 缩放档位。
 *
 * 取整百分数（25 / 50 / 75 / 100 / 150 / 200 / 300 / 400），读数好认，也不会
 * 出现 `156%` 这种数。下限 25% 是「一眼看全大图的构图」够用的量级，
 * 上限 400% 是「看清细节」够用的量级。
 */
const ZOOM_STEPS: readonly number[] = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];

/** 初始倍率 = 适应可用空间（打开即见全貌）。 */
const ZOOM_DEFAULT = 1;

/**
 * 弹窗宽度的上限。
 *
 * ⚠ 与 `styles.css` 里 `.obsync-image-preview-modal` 的 `max-width` 是**同一套数字**，
 * 改一个必须改另一个 —— 否则算出来的舞台尺寸会被 CSS 再裁一次，或者反过来留出
 * 一大块空白。
 */
const MAX_MODAL_WIDTH = 1400;

/**
 * 弹窗里**图片之外**的固定开销（标题栏 + 工具条 + 元信息 + 内边距），像素。
 *
 * ⚠ 与 `styles.css` 里 `--obsync-preview-viewport` 的 `calc(100vh - 220px)` 是同一个
 * 数字，改一个要改另一个 —— 否则舞台会比真正放得下的高度大，弹窗就被迫出现滚动条
 * （而用户明确不要滚动）。
 */
const CHROME_HEIGHT = 220;

/** 弹窗宽度占视口的比例。同上，与 `max-width` 里的 `92vw` 一致。 */
const VIEWPORT_WIDTH_RATIO = 0.92;

export class ImagePreviewModal extends Modal {
    private zoom = ZOOM_DEFAULT;
    /** 相对居中位置的平移量（像素）。只在图片比舞台大时才有意义。 */
    private offset = { x: 0, y: 0 };
    /** 100% 那一档的显示尺寸。`onload` 之后才有值。 */
    private base: PreviewSize | undefined;
    /** 可用空间（舞台的上限）。与 CSS 里那套数字同源，见上面的常量。 */
    private available: PreviewSize = { width: 0, height: 0 };

    private img: HTMLImageElement | undefined;
    private stage: HTMLElement | undefined;
    private panHint!: HTMLElement;
    private zoomLabel!: HTMLElement;
    private zoomOutButton!: HTMLButtonElement;
    private zoomInButton!: HTMLButtonElement;
    private resetButton!: HTMLButtonElement;

    constructor(
        app: App,
        private readonly t: LocaleStrings,
        private readonly record: ImageRecord
    ) {
        super(app);
    }

    onOpen(): void {
        this.modalEl.addClass("obsync-image-preview-modal");
        // 标题只放文件名：完整路径在下面那一行（弹窗标题栏放不下长路径，
        // 而它一换行就把弹窗顶部撑成两行）。
        this.titleEl.setText(fileNameOf(this.record.path));

        const file = this.app.vault.getAbstractFileByPath(this.record.path);
        if (file instanceof TFile) {
            this.renderToolbar();

            this.stage = this.contentEl.createDiv({ cls: "obsync-image-preview-stage" });
            const image = this.stage.createEl("img", { cls: "obsync-image-preview-img" });
            image.setAttribute("src", this.app.vault.getResourcePath(file));
            // 这张图不是装饰：它是这个弹窗的主体，读屏该念出它是谁。
            image.setAttribute("alt", this.record.path);
            image.addEventListener("pointerdown", (event) => this.beginPan(event));
            // 尺寸要等解码完才知道 —— 在那之前走 CSS 兜底（见 applyZoom）。
            image.addEventListener("load", () => this.measure());

            // 显式 `passive: false`：只有 Ctrl / Cmd + 滚轮才拦（见 onWheel），而
            // `preventDefault()` 在 passive 监听器里会被浏览器**静默忽略**（只在控制台
            // 留一条警告）。这个监听器挂在 div 上，眼下不是 passive；写出来是为了让它
            // 以后被挪到 `document` 上（那里 `wheel` 默认 passive）也不会静默失效。
            this.stage.addEventListener("wheel", (event) => this.onWheel(event), { passive: false });

            this.img = image;
        }

        this.renderMeta();
        // 画完才刷一遍：按钮的可用性（能不能再放大 / 缩小、有没有东西可重置）
        // 完全由当前倍率决定，而那要等工具条存在之后才谈得上 ——
        // 所以这一步只能在**画了工具条**的这个分支里做。
        this.applyZoom();
    }

    onClose(): void {
        this.contentEl.empty();
    }

    // ── 尺寸与缩放 ────────────────────────────────────────────────────────

    private renderToolbar(): void {
        const t = this.t.images.manager;
        const bar = this.contentEl.createDiv({ cls: "obsync-image-preview-toolbar" });

        this.zoomOutButton = this.toolbarButton(bar, "zoom-out", t.previewZoomOut, () =>
            this.stepZoom(-1)
        );
        this.zoomLabel = bar.createSpan({ cls: "obsync-image-preview-zoom", text: "100%" });
        this.resetButton = this.toolbarButton(bar, "rotate-ccw", t.previewZoomReset, () =>
            this.setZoom(ZOOM_DEFAULT)
        );
        this.zoomInButton = this.toolbarButton(bar, "zoom-in", t.previewZoomIn, () =>
            this.stepZoom(1)
        );

        // 「图片比窗口大」时唯一能做的事就是拖 —— 但用户看不出这一点（被裁掉的
        // 部分不会自己喊）。所以这里给一个看得见的提示，而不是只靠光标形状。
        this.panHint = bar.createSpan({ cls: "obsync-image-preview-hint" });
        setIcon(this.panHint, "move");
        this.panHint.createSpan({ text: t.previewPannable });
        this.panHint.setAttribute("title", t.previewPannableHint);
    }

    /** 工具条上的图标按钮。只有图标，所以标签同时挂 `aria-label` 与 `title`。 */
    private toolbarButton(
        parent: HTMLElement,
        icon: string,
        label: string,
        onClick: () => void
    ): HTMLButtonElement {
        const button = parent.createEl("button", { cls: "obsync-image-preview-button" });
        setIcon(button, icon);
        button.setAttribute("aria-label", label);
        button.setAttribute("title", label);
        button.addEventListener("click", onClick);
        return button;
    }

    /**
     * 图片解码完，量出「100% 该多大」。
     *
     * 可用空间**必须**与 CSS 里那套上限一致（`MAX_MODAL_WIDTH` / 两个 RATIO 的注释
     * 里写了对应的 CSS 位置）—— 否则要么算出来的舞台被 CSS 再裁一次，要么反过来
     * 留一大块空白。
     */
    private measure(): void {
        const img = this.img;
        if (!img) return;

        const natural = { width: img.naturalWidth, height: img.naturalHeight };
        if (natural.width <= 0 || natural.height <= 0) return;

        this.available = {
            width: Math.min(window.innerWidth * VIEWPORT_WIDTH_RATIO, MAX_MODAL_WIDTH),
            // 兜底 120px：窗口极矮时 `innerHeight - CHROME_HEIGHT` 会变成负数，
            // 而负的可用高度会让图片整个消失。
            height: Math.max(120, window.innerHeight - CHROME_HEIGHT),
        };
        this.base = fitSize(natural, this.available);
        this.applyZoom();
    }

    /** 往相邻档位走一步。到表头表尾就停住（那时按钮已经是灰的）。 */
    private stepZoom(direction: 1 | -1): void {
        const index = ZOOM_STEPS.indexOf(this.zoom);
        // 倍率一定来自档位表，所以 `index` 不会是 -1；真出现了就当 100% 处理，
        // 而不是让 `-1 + 1 = 0` 把用户一把拽到 25%。
        const from = index < 0 ? ZOOM_STEPS.indexOf(ZOOM_DEFAULT) : index;
        // `next` 已经被夹在 `[0, length-1]` 里，所以取到的档位一定存在。
        const next = Math.min(Math.max(from + direction, 0), ZOOM_STEPS.length - 1);
        this.setZoom(ZOOM_STEPS[next]);
    }

    private setZoom(value: number): void {
        this.zoom = value;
        // 倍率一变，原来的平移量就没有意义了（图片的尺寸都变了）—— 回到居中，
        // 免得用户看到一张「莫名其妙偏在角落」的图。
        this.offset = { x: 0, y: 0 };
        this.applyZoom();
    }

    private onWheel(event: WheelEvent): void {
        // 舞台自己**不滚动**（`overflow: hidden`），所以滚轮落在这一格上时，
        // 唯一有意义的动作就是缩放 —— 普通滚轮直接缩放（Ctrl / Cmd + 滚轮也一样）。
        //
        // 唯一的例外：窗口很矮、弹窗整体放不下时，滚轮该去滚弹窗内容而不是缩放 ——
        // 那时用户想的是「往下看」。
        if (this.contentEl.scrollHeight > this.contentEl.clientHeight) return;
        event.preventDefault();
        this.stepZoom(event.deltaY < 0 ? 1 : -1);
    }

    /**
     * 按住拖动平移 —— 只在图片比舞台大时有意义。
     *
     * 没溢出时直接不做：否则光标会变成抓手，用户以为能把图挪走，实际什么都不会发生。
     */
    private beginPan(event: PointerEvent): void {
        if (!this.isOverflowing()) return;
        event.preventDefault();

        const originX = event.clientX;
        const originY = event.clientY;
        const baseX = this.offset.x;
        const baseY = this.offset.y;
        const limit = this.limits();

        const onMove = (move: PointerEvent): void => {
            this.offset = {
                x: clamp(baseX + (move.clientX - originX), -limit.x, limit.x),
                y: clamp(baseY + (move.clientY - originY), -limit.y, limit.y),
            };
            this.applyOffset();
        };
        const onUp = (): void => {
            document.removeEventListener("pointermove", onMove);
            document.removeEventListener("pointerup", onUp);
        };

        document.addEventListener("pointermove", onMove);
        document.addEventListener("pointerup", onUp);
    }

    /** 图片当前有没有比舞台大（= 有没有看不见的部分）。 */
    private isOverflowing(): boolean {
        const base = this.base;
        if (!base || base.width <= 0) return false;
        return stageSize(base, this.available, this.zoom).overflowing;
    }

    /** 各方向还能拖多远（拖动时用它限位）。 */
    private limits(): { x: number; y: number } {
        const base = this.base;
        if (!base || base.width <= 0) return { x: 0, y: 0 };
        return panLimit(base, this.available, this.zoom);
    }

    /**
     * 把倍率落到尺寸上，并同步读数、提示与按钮可用性。
     *
     * 舞台跟着图片长大（到上限为止），弹窗宽度是 `fit-content` 所以跟着舞台走 ——
     * 这就是「弹窗整体跟着变大」。封顶之后图片还更大，多出来的部分被舞台裁掉，
     * 靠拖动看（`overflow: hidden` 是刻意的：用户不要滚动条）。
     */
    private applyZoom(): void {
        // 本地没有这一份时**整个工具条都没画**（见 onOpen），也就没有读数与按钮可刷。
        // 守卫放在**被调方**的开头，而不是靠调用方记得放进分支里 ——
        // 「onOpen 末尾统一刷一遍」这个写法已经栽过两次（两个版本都在同一条早退
        // 分支上炸），把判据收在这里才是稳的。
        if (!this.zoomLabel) return;

        const base = this.base;
        // `base.width > 0` 已经隐含「可用空间也算出来了」（见 fitSize）——
        // 没测到就什么都不设，让 CSS 的兜底接管。
        const size = base && base.width > 0 ? stageSize(base, this.available, this.zoom) : undefined;

        if (this.stage && size) {
            this.stage.style.width = `${size.width}px`;
            this.stage.style.height = `${size.height}px`;
        }

        if (this.img && base && base.width > 0) {
            // 尺寸一旦量到，就要**解除** CSS 里那两条 `max-width` / `max-height` 兜底：
            // 留着它们会把图片压回舞台大小，于是永远没有溢出、也就永远拖不动。
            // 用类而不是 `style.maxWidth = "none"` —— 静态样式该待在 CSS 里，
            // 而且这本来就该是一条规则（社区审核的 `no-static-styles-assignment`
            // 拦的就是字面量赋值）。
            this.img.addClass("obsync-image-preview-measured");
            // 像素尺寸是**算出来的**，这种才需要写内联。
            this.img.style.width = `${Math.round(base.width * this.zoom)}px`;
            this.img.style.height = `${Math.round(base.height * this.zoom)}px`;
        }

        const overflowing = size?.overflowing ?? false;
        // 抓手与提示只在真能拖的时候给。
        this.stage?.toggleClass("obsync-image-preview-pannable", overflowing);
        this.panHint.toggleClass("obsync-image-preview-hint-off", !overflowing);

        this.zoomLabel.setText(`${Math.round(this.zoom * 100)}%`);
        this.zoomOutButton.disabled = this.zoom <= ZOOM_STEPS[0];
        this.zoomInButton.disabled = this.zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1];
        // 100% 时图片完整装得下、没有溢出，所以那一档就是「没什么可重置的」。
        // 灰掉，而不是让它点了没反应。
        this.resetButton.disabled = this.zoom === ZOOM_DEFAULT;

        this.applyOffset();
    }

    /** 只更新平移。拖动时每帧都调它，所以别在这里重算尺寸。 */
    private applyOffset(): void {
        if (this.img) {
            this.img.style.transform = `translate(${this.offset.x}px, ${this.offset.y}px)`;
        }
    }

    // ── 元信息 ────────────────────────────────────────────────────────────

    private renderMeta(): void {
        const t = this.t.images.manager;
        const meta = this.contentEl.createDiv({ cls: "obsync-image-preview-meta" });
        meta.createSpan({ cls: "obsync-image-preview-path", text: this.record.path });
        meta.createSpan({
            cls: "obsync-image-preview-size",
            text: formatBytes(imageSizeOf(this.record)),
        });

        const badges = meta.createDiv({ cls: "obsync-image-badges" });
        if (this.record.local) {
            badges.createSpan({
                cls: "obsync-image-badge obsync-image-badge-local",
                text: t.badgeLocal,
            });
        }
        if (this.record.remote) {
            badges.createSpan({
                cls: "obsync-image-badge obsync-image-badge-remote",
                text: t.badgeRemote,
            });
        }
        if (this.record.refs.length > 0) {
            const badge = badges.createSpan({
                cls: "obsync-image-badge obsync-image-badge-linked",
                text: t.badgeLinked(this.record.refs.length),
            });
            // 与列表里同一个理由：谁在引用它决定这张图能不能删，而这里同样放不下。
            badge.title = this.record.refs.join("\n");
        } else {
            badges.createSpan({
                cls: "obsync-image-badge obsync-image-badge-orphan",
                text: t.badgeOrphan,
            });
        }
    }
}

/** 把值夹在 `[min, max]` 里。拖动限位用。 */
function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}
