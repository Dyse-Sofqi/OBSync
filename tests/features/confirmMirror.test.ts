import { beforeEach, describe, expect, it, vi } from "vitest";
import { createdSettings, resetCreatedSettings } from "../stubs/obsidian";
import { normalizeSettings } from "../../src/core/settings";
import { zhCN } from "../../src/core/i18n/locales/zh-cn";
import { ConfirmMirrorModal } from "../../src/features/installer/ui/ConfirmMirrorModal";
import type { TrackedItem } from "../../src/features/installer/types";
import { createFakeApp } from "../helpers/fakeApp";

/**
 * 「疑似镜像」的确认弹窗 —— **镜像被采用的唯一入口**。
 *
 * 要钉住三件事，缺一条这个保险就是摆设：
 *
 * 1. **两个地址都摆在界面上**（现在跟的是谁、想换成谁）—— 用户才能核对；
 * 2. **警示说明在场**（判据有多弱、绑错的代价、怎么自己核对）—— 这段文字是
 *    用户做判断的全部依据，不能只留一句「要改用镜像吗」；
 * 3. **两个出口都通**：改用镜像 / 保持现状，且**不改**也能正常关掉。
 */

function tracked(): TrackedItem {
    return {
        kind: "plugin",
        host: "github",
        owner: "dyse-sofqi",
        repo: "MDRazor",
        id: "md-razor",
        name: "MDRazor",
        installedVersion: "2.6.4",
        requestedVersion: "latest",
        frozen: false,
        channel: "release",
        installedAt: 0,
    };
}

const MIRROR = { host: "gitee", owner: "sofqi", repo: "MDRazor" } as const;

function openModal(onDecide = vi.fn()): ConfirmMirrorModal {
    const modal = new ConfirmMirrorModal(
        createFakeApp().app,
        zhCN,
        tracked(),
        MIRROR,
        onDecide
    );
    modal.open();
    return modal;
}

/** 弹窗内容区里所有文本（含列表项）。 */
function modalTexts(modal: ConfirmMirrorModal): string[] {
    const content = (modal as unknown as { contentEl: { children: unknown[] } }).contentEl;
    const walk = (node: unknown): string[] => {
        const el = node as { text?: string; children?: unknown[] };
        const own = el.text ? [el.text] : [];
        return [...own, ...(el.children ?? []).flatMap(walk)];
    };
    return (content.children as unknown[]).flatMap(walk);
}

beforeEach(() => {
    resetCreatedSettings();
});

describe("ConfirmMirrorModal", () => {
    it("两个地址都摆在界面上（要核对的就是这两个）", () => {
        const modal = openModal();

        const texts = modalTexts(modal).join("\n");
        expect(texts).toContain("GitHub");
        expect(texts).toContain("dyse-sofqi/MDRazor");
        expect(texts).toContain("Gitee");
        expect(texts).toContain("sofqi/MDRazor");
    });

    it("**警示说明在场**：判据有多弱、代价是什么、怎么自己核对", () => {
        const modal = openModal();

        const texts = modalTexts(modal).join("\n");
        expect(texts).toContain(zhCN.installer.mirrorWarnHeading);
        expect(texts).toContain(zhCN.installer.mirrorWarnChecks);
        expect(texts).toContain(zhCN.installer.mirrorWarnRisk);
        expect(texts).toContain(zhCN.installer.mirrorWarnHowTo);
        // 判据那条必须点明「只能证明是同一个插件」—— 这是用户最容易误解的地方
        expect(zhCN.installer.mirrorWarnChecks).toContain("同一个插件");
    });

    it("点「改用镜像」→ 决定是 useMirror=true，弹窗关闭", () => {
        const onDecide = vi.fn();
        openModal(onDecide);

        const useButton = createdSettings
            .flatMap((setting) => setting.buttons)
            .find((button) => button.text === zhCN.installer.mirrorConfirmUse("Gitee"))!;
        useButton.click();

        expect(onDecide).toHaveBeenCalledWith(true);
    });

    it("点「保持现状」→ 决定是 useMirror=false（不改也能关掉，不该逼用户做决定）", () => {
        const onDecide = vi.fn();
        openModal(onDecide);

        const keepButton = createdSettings
            .flatMap((setting) => setting.buttons)
            .find((button) => button.text === zhCN.installer.mirrorConfirmKeep)!;
        keepButton.click();

        expect(onDecide).toHaveBeenCalledWith(false);
    });

    it("默认不动记录：只是打开弹窗时什么决定都没做出", () => {
        const onDecide = vi.fn();
        openModal(onDecide);

        expect(onDecide).not.toHaveBeenCalled();
    });
});

describe("installer.mirrorSuggestions 的读取侧校验", () => {
    const trackedRecord = {
        kind: "plugin",
        host: "github",
        owner: "owner",
        repo: "demo",
        id: "demo",
        name: "Demo",
        installedVersion: "1.0.0",
        requestedVersion: "latest",
        frozen: false,
        installedAt: 0,
    };

    it("坏值丢弃、不在跟踪列表里的键剪掉（data.json 可以手改）", () => {
        const settings = normalizeSettings({
            installer: {
                tracked: [trackedRecord],
                mirrorSuggestions: {
                    "plugin:demo": { host: "gitee", owner: "someone", repo: "demo" },
                    "plugin:gone": { host: "gitee", owner: "ghost", repo: "gone" },
                    "plugin:bad": { host: "gitee" },
                    "plugin:notobject": "gitee.com/x/y",
                },
            },
        });

        expect(settings.installer.mirrorSuggestions).toEqual({
            "plugin:demo": { host: "gitee", owner: "someone", repo: "demo" },
        });
    });

    it("与当前来源相同的提议视为没写（否则列表会挂一句和上一行一样的地址）", () => {
        const settings = normalizeSettings({
            installer: {
                tracked: [trackedRecord],
                mirrorSuggestions: {
                    "plugin:demo": { host: "github", owner: "owner", repo: "demo" },
                },
            },
        });

        expect(settings.installer.mirrorSuggestions).toEqual({});
    });
});
