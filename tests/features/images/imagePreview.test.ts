import { describe, expect, it } from "vitest";
import { fitSize, panLimit, stageSize } from "../../../src/features/images/imagePreview";

/**
 * 预览弹窗的尺寸计算。
 *
 * 这三个函数决定「弹窗该多大、图什么时候算溢出、能拖多远」—— 而它们在真机上
 * **很难验**（要开 Obsidian、还要真的有一张 6000px 的图）。这块返工过两次
 * （先是 `transform: scale()` 把图裁掉、再是加了滚动条），所以规则本身必须
 * 单独钉住，不能只靠真机看。
 */

/** 一块「可用空间」：1000 × 800。 */
const room = { width: 1000, height: 800 };

describe("fitSize：100% 那一档该多大", () => {
    it("大图缩到装得下，并保持比例", () => {
        // 4000×2000 装进 1000×800 → 受宽度约束，得到 1000×500。
        expect(fitSize({ width: 4000, height: 2000 }, room)).toEqual({ width: 1000, height: 500 });
    });

    it("竖图受高度约束", () => {
        expect(fitSize({ width: 1000, height: 4000 }, room)).toEqual({ width: 200, height: 800 });
    });

    it("小图**不放大** —— 填满窗口是用户按放大键之后才发生的事", () => {
        expect(fitSize({ width: 200, height: 100 }, room)).toEqual({ width: 200, height: 100 });
    });

    it("刚好装得下时原样返回", () => {
        expect(fitSize({ width: 1000, height: 800 }, room)).toEqual({ width: 1000, height: 800 });
    });

    it("量不到自然尺寸（0）时返回 0，让调用方走 CSS 兜底", () => {
        // 返回 0 而不是「随便给一个」：调用方据此判断「还没量到」，
        // 于是不写行内尺寸 —— 按 0 去设会让图片整个消失。
        expect(fitSize({ width: 0, height: 0 }, room)).toEqual({ width: 0, height: 0 });
    });

    it("可用空间是 0 时也返回 0（否则会算出 Infinity / NaN）", () => {
        expect(fitSize({ width: 100, height: 100 }, { width: 0, height: 0 })).toEqual({
            width: 0,
            height: 0,
        });
    });
});

describe("stageSize：某个倍率下舞台该多大", () => {
    const base = { width: 1000, height: 500 };

    it("100% 就是那一档的尺寸（弹窗贴合图片）", () => {
        expect(stageSize(base, room, 1)).toEqual({ width: 1000, height: 500, overflowing: false });
    });

    it("放大 → 舞台跟着长大（弹窗靠 CSS 的 fit-content 跟着走）", () => {
        expect(stageSize({ width: 400, height: 200 }, room, 2)).toEqual({
            width: 800,
            height: 400,
            overflowing: false,
        });
    });

    it("封顶在可用空间，并标出「有看不见的部分」", () => {
        // 1000×500 放大到 200% 想要 2000×1000，但只有 1000×800。
        expect(stageSize(base, room, 2)).toEqual({ width: 1000, height: 800, overflowing: true });
    });

    it("缩小也照常（弹窗跟着变小）", () => {
        expect(stageSize(base, room, 0.5)).toEqual({ width: 500, height: 250, overflowing: false });
    });

    it("只有一边超了也算溢出", () => {
        // 100×200 放大 5 倍 → 500×1000：宽装得下，高超出了 200。
        expect(stageSize({ width: 100, height: 200 }, room, 5).overflowing).toBe(true);
        // 200×100 放大 5 倍 → 1000×500：两边都装得下（宽正好 1000，不算超）。
        expect(stageSize({ width: 200, height: 100 }, room, 5).overflowing).toBe(false);
    });

    it("取整后的浮点差不会被误判成溢出", () => {
        // 800 × 1.25 = 1000，正好等于可用宽度 —— 不该报溢出（否则一按放大
        // 就冒出抓手，而其实一点都没被裁）。
        expect(stageSize({ width: 800, height: 100 }, room, 1.25).overflowing).toBe(false);
    });
});

describe("panLimit：还能拖多远", () => {
    it("没溢出时是 0（拖不动，也不该给抓手）", () => {
        expect(panLimit({ width: 400, height: 200 }, room, 1)).toEqual({ x: 0, y: 0 });
    });

    it("是溢出量的一半 —— 图片居中，两侧各有一半", () => {
        // 1000×500 放大到 200% 想要 2000×1000，舞台是 1000×800：
        // 宽多 1000、高多 200 → 各方向能拖一半。
        expect(panLimit({ width: 1000, height: 500 }, room, 2)).toEqual({ x: 500, y: 100 });
    });

    it("只有一个方向溢出时就只在那一个方向能拖", () => {
        // 200×200 放大 5 倍 → 1000×1000：宽正好装下，高溢出 200。
        const limit = panLimit({ width: 200, height: 200 }, room, 5);
        expect(limit.x).toBe(0);
        expect(limit.y).toBe(100);
    });

    it("限位是必须的：不限的话用户能把图整个拖出视野", () => {
        // 这条用例的存在意义就是把「必须有上限」写进测试 ——
        // 只要 `panLimit` 有一天返回 Infinity 或「不设限」，这里就会红。
        const limit = panLimit({ width: 1000, height: 500 }, room, 4);
        expect(Number.isFinite(limit.x)).toBe(true);
        expect(Number.isFinite(limit.y)).toBe(true);
    });
});
