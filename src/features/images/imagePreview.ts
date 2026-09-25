/**
 * 预览弹窗的尺寸计算（**纯计算**，不碰 DOM）。
 *
 * ## 三件事的先后关系
 *
 * 1. `fitSize` —— 100% 那一档：图片**完整**装进可用空间（但不放大超过自然尺寸）。
 *    这就是「打开就能看到全貌」。
 * 2. `stageSize` —— 某个倍率下舞台该多大：图片尺寸等比放大，**封顶在可用空间**。
 *    弹窗宽度是 `fit-content`（见 styles.css），所以舞台长大 = 弹窗长大。
 * 3. `overflowing` —— 封顶之后图片还更大，就说明有看不见的部分，
 *    那时才需要给「按住拖动」的提示与抓手光标。
 *
 * ## 为什么抽成纯函数
 *
 * 真正的测量（`img.naturalWidth`、`window.innerHeight`）在单测里**拿不到**：
 * 垫片没有布局引擎，`onload` 也不会触发。算法本身必须单独钉住，否则
 * 「放大之后到底该多大、什么时候算溢出」这条规则只能靠真机看 ——
 * 而这正是上一版做错的地方（用 `transform: scale()` 放大，图片被裁掉，
 * 被用户报成「放大的图片被遮挡」）。
 */

export interface PreviewSize {
    width: number;
    height: number;
}

/**
 * 100% 那一档的显示尺寸。
 *
 * **只缩不放**（`min(..., 1)`）：一张 200px 的小图在 100% 时就该是 200px ——
 * 放大到填满窗口是用户按放大键之后才发生的事，不该替他决定。
 *
 * 自然尺寸拿不到时（`naturalWidth` 为 0）返回 0：调用方据此走 CSS 兜底，
 * 而不是按 0 尺寸去设样式（那会让图片整个消失）。
 */
export function fitSize(natural: PreviewSize, available: PreviewSize): PreviewSize {
    if (natural.width <= 0 || natural.height <= 0) return { width: 0, height: 0 };
    if (available.width <= 0 || available.height <= 0) return { width: 0, height: 0 };

    const scale = Math.min(
        available.width / natural.width,
        available.height / natural.height,
        1
    );
    return {
        width: Math.round(natural.width * scale),
        height: Math.round(natural.height * scale),
    };
}

export interface StageSize extends PreviewSize {
    /** 图片比舞台大 —— 有看不见的部分，需要拖动。 */
    overflowing: boolean;
}

/**
 * 舞台在某个倍率下的尺寸（封顶在可用空间）。
 *
 * 封顶而不是继续长大：弹窗总得留在屏幕里。封顶之后多出来的那部分就是
 * `overflowing` —— 它决定要不要给拖动手柄。
 *
 * 容差 0.5px 是为了别被取整后的浮点差误判成溢出（`base.width * 1.25` 很容易
 * 落在某个整数边上）。
 */
export function stageSize(base: PreviewSize, available: PreviewSize, zoom: number): StageSize {
    const wanted = { width: base.width * zoom, height: base.height * zoom };
    return {
        width: Math.round(Math.min(wanted.width, available.width)),
        height: Math.round(Math.min(wanted.height, available.height)),
        overflowing:
            wanted.width > available.width + 0.5 || wanted.height > available.height + 0.5,
    };
}

/**
 * 各方向还能拖多远（图片居中，所以是溢出量的一半）。
 *
 * **必须限位**：不限的话用户能把图整个拖出视野 —— 那时他既看不到图，
 * 也找不到「怎么拖回来」。
 */
export function panLimit(
    base: PreviewSize,
    available: PreviewSize,
    zoom: number
): { x: number; y: number } {
    const size = stageSize(base, available, zoom);
    return {
        x: Math.max(0, (base.width * zoom - size.width) / 2),
        y: Math.max(0, (base.height * zoom - size.height) / 2),
    };
}
