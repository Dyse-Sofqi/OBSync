import { beforeEach, describe, expect, it, vi } from "vitest";
import { createdSettings, resetCreatedSettings } from "../../stubs/obsidian";
import { zhCN } from "../../../src/core/i18n/locales/zh-cn";
import { en } from "../../../src/core/i18n/locales/en";
import { ConfirmDeleteRemoteModal } from "../../../src/features/images/ui/ConfirmDeleteRemoteModal";
import { createFakeApp } from "../../helpers/fakeApp";

/**
 * 「要不要连云端一起删」的确认弹窗。
 *
 * ## 要钉住三件事
 *
 * 1. **清单列出来**（用户得知道自己在回答哪几张图）—— 一次删十张图时
 *    弹的是一个窗，看不到列表就无从判断。
 * 2. **「云端不可撤销」在场** —— 本地删除多半还能从库的回收站找回，
 *    而 R2 没有回收站。不写出来，用户会按本地删除的经验去点。
 * 3. **三个出口都通，且都会有决定**：删 / 留 / 直接把窗关掉。
 *    第三个尤其重要 —— 不表态时如果不记下「保留云端」，下一轮同步会把
 *    那张图下载回来，看起来像「删除没生效」。
 */

beforeEach(() => {
    resetCreatedSettings();
});

function openModal(
    paths: string[],
    onDecide = vi.fn()
): { modal: ConfirmDeleteRemoteModal; onDecide: ReturnType<typeof vi.fn> } {
    const modal = new ConfirmDeleteRemoteModal(createFakeApp().app, zhCN, paths, onDecide);
    modal.open();
    return { modal, onDecide };
}

/** 弹窗内容区里所有文本（含列表项）。 */
function modalTexts(modal: ConfirmDeleteRemoteModal): string[] {
    const content = (modal as unknown as { contentEl: { children: unknown[] } }).contentEl;
    const walk = (node: unknown): string[] => {
        const el = node as { text?: string; children?: unknown[] };
        const own = el.text ? [el.text] : [];
        return [...own, ...(el.children ?? []).flatMap(walk)];
    };
    return (content.children as unknown[]).flatMap(walk);
}

function modalButtons(): { text: string; warning: boolean; click: () => unknown }[] {
    const setting = createdSettings[createdSettings.length - 1]!;
    return setting.buttons as never;
}

function contentElOf(modal: ConfirmDeleteRemoteModal): { children: unknown[] } {
    return (modal as unknown as { contentEl: { children: unknown[] } }).contentEl;
}

/**
 * 标题文字。
 *
 * `titleEl` 的真实类型是 `HTMLElement`（没有 `text`）—— 那是 Obsidian 在
 * HTMLElement 上加的扩展，所以这里按 DOM shim 的形状取值。
 */
function titleOf(modal: ConfirmDeleteRemoteModal): string | undefined {
    return (modal.titleEl as unknown as { text?: string }).text;
}

describe("ConfirmDeleteRemoteModal", () => {
    it("标题带数量（一次删多张时用户要知道自己在回答什么）", () => {
        const single = openModal(["images/a.png"]);
        expect(titleOf(single.modal)).toBe(zhCN.images.deleteRemote.title(1));

        const many = openModal(["images/a.png", "images/b.png"]);
        expect(titleOf(many.modal)).toBe(zhCN.images.deleteRemote.title(2));
        // 两个标题必须不一样 —— 否则「带数量」是假的
        expect(zhCN.images.deleteRemote.title(1)).not.toBe(
            zhCN.images.deleteRemote.title(2)
        );
    });

    it("把要处理的文件逐个列出来", () => {
        const paths = ["images/a.png", "images/b.png", "images/c.png"];
        const { modal } = openModal(paths);

        const texts = modalTexts(modal);
        for (const path of paths) expect(texts).toContain(path);
    });

    it("超过 20 条时只列前 20 个，并说明还有多少", () => {
        // 删 200 张图时列全了既没人看，也会把弹窗撑爆。
        const paths = Array.from({ length: 25 }, (_, index) => `images/${index}.png`);
        const { modal } = openModal(paths);

        const texts = modalTexts(modal);
        expect(texts).toContain("images/0.png");
        expect(texts).toContain("images/19.png");
        expect(texts).not.toContain("images/20.png");
        expect(texts).toContain(zhCN.images.deleteRemote.more(5));
    });

    /**
     * **「云端不可撤销」必须在场。**
     *
     * 这是这个弹窗与普通确认框的区别：本地那次删除多半还躺在库的回收站里，
     * 而 R2 没有回收站。少了这段，用户会按本地删除的经验去点。
     */
    it("写清「云端删除不可撤销」以及两个出口各意味着什么", () => {
        const { modal } = openModal(["images/a.png"]);
        const texts = modalTexts(modal);

        expect(texts).toContain(zhCN.images.deleteRemote.warningHeading);
        expect(texts).toContain(zhCN.images.deleteRemote.warning);
        expect(zhCN.images.deleteRemote.warning).toContain("回收站");
    });

    it("两个按钮：保留 / 删除，且删除那个是警示色", () => {
        openModal(["images/a.png"]);
        const buttons = modalButtons();

        expect(buttons.map((button) => button.text)).toEqual([
            zhCN.images.deleteRemote.keep,
            zhCN.images.deleteRemote.delete,
        ]);
        // 危险动作不能用主操作色 —— 那在暗示「点这个就对了」
        expect(buttons[0]!.warning).toBe(false);
        expect(buttons[1]!.warning).toBe(true);
    });

    it("点「保留云端备份」→ 回调 false，并关掉弹窗", () => {
        const { modal, onDecide } = openModal(["images/a.png"]);

        modalButtons()[0]!.click();

        expect(onDecide).toHaveBeenCalledWith(false);
        expect(contentElOf(modal).children).toEqual([]);
    });

    it("点「同时删除云端备份」→ 回调 true，并关掉弹窗", () => {
        const { modal, onDecide } = openModal(["images/a.png"]);

        modalButtons()[1]!.click();

        expect(onDecide).toHaveBeenCalledWith(true);
        expect(contentElOf(modal).children).toEqual([]);
    });

    /**
     * **直接把窗关掉（Esc / 点外面）也要有一个决定。**
     *
     * 不表态时如果什么都不做，本地文件已经删了、云端那一份还在，下一轮同步
     * 就会把它下载回来 —— 看起来像「删除没生效」，而用户完全不知道为什么。
     * 所以按最保守的一档处理：保留云端副本。
     */
    it("没点按钮就关掉 → 按「保留云端备份」处理", () => {
        const { modal, onDecide } = openModal(["images/a.png"]);

        modal.close();

        expect(onDecide).toHaveBeenCalledTimes(1);
        expect(onDecide).toHaveBeenCalledWith(false);
    });

    it("回调只会发生一次（点了按钮再关闭不会重复）", () => {
        const { modal, onDecide } = openModal(["images/a.png"]);

        modalButtons()[1]!.click();
        // 关窗时 onClose 会再跑一次，但它不该再回调
        modal.close();

        expect(onDecide).toHaveBeenCalledTimes(1);
        expect(onDecide).toHaveBeenCalledWith(true);
    });

    it("跟随 locale（英文界面下不出现中文）", () => {
        const modal = new ConfirmDeleteRemoteModal(
            createFakeApp().app,
            en,
            ["images/a.png"],
            vi.fn()
        );
        modal.open();

        for (const text of modalTexts(modal)) {
            expect(text).not.toMatch(/[\u4e00-\u9fff]/);
        }
    });
});
