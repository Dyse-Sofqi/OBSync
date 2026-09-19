import { describe, expect, it } from "vitest";
// 从替身导入（不是 `"obsidian"`）：`Notice.instances` 是替身才有的登记表，
// 真实 API 里没有它 —— 而「有没有建出提示」正是要断言的东西。
import { Notice } from "../stubs/obsidian";
import { Notifier } from "../../src/core/notice";
import { en } from "../../src/core/i18n/locales/en";
import { zhCN } from "../../src/core/i18n/locales/zh-cn";
import {
    AuthError,
    HttpStatusError,
    NetworkError,
    NotFoundError,
    ParseError,
    RateLimitError,
    UnsupportedHostError,
} from "../../src/host/errors";

/**
 * `Notifier` 对 host 层错误的翻译。
 *
 * 这些分支决定「用户看到的是中文还是英文技术文案」。其中 `HttpStatusError`
 * 是补上的一环：**意料之外的 HTTP 状态码**（500 / 502 / 422 之类）原本会落到
 * `ObsyncError → err.message`，也就是把 `Unexpected HTTP 500 from ... while ...`
 * 这句英文原样显示给中文用户。
 *
 * 死键扫描发现了这个缺口：`host.requestFailed` 这个键写了却从没接上 ——
 * 一个没人用的 i18n 键，背后通常真有问题。
 */

function notifier(locale: typeof zhCN | typeof en): Notifier {
    return new Notifier({ getShowNotices: () => true, getT: () => locale as typeof zhCN });
}

describe("host 层错误的本地化", () => {
    it("限流错误带上恢复时间", () => {
        const resetAt = new Date("2026-09-16T12:00:00Z").getTime();
        const text = notifier(zhCN).describeError(new RateLimitError("x", "gitee", resetAt));

        // 用户需要知道「什么时候能恢复」，光说"限流了"没法行动。
        expect(text).toContain(zhCN.host.gitee);
        expect(text).toContain("2026");
    });

    it("限流但拿不到恢复时间时，不出现 undefined", () => {
        const text = notifier(zhCN).describeError(new RateLimitError("x", "gitee"));

        expect(text).toContain(zhCN.host.gitee);
        expect(text).not.toContain("undefined");
    });

    it("鉴权 / 找不到 / 解析失败 / 不支持的平台各有对应文案", () => {
        const n = notifier(zhCN);

        expect(n.describeError(new AuthError("x", "github"))).toBe(
            zhCN.host.tokenInvalid(zhCN.host.github)
        );
        expect(n.describeError(new NotFoundError("x", "o/r"))).toBe(
            zhCN.host.notFound("GitHub / Gitee", "o/r")
        );
        expect(n.describeError(new ParseError('bad "input"'))).toBeTruthy();
        expect(n.describeError(new UnsupportedHostError("x", "gitlab.com"))).toBe(
            zhCN.host.unsupportedHost("gitlab.com")
        );
        expect(n.describeError(new NetworkError("boom"))).toBe(
            zhCN.host.networkFailed("boom")
        );
    });

    it("**意料之外的 HTTP 状态码给出本地化文案**（不是英文技术描述）", () => {
        const error = new HttpStatusError(
            "Unexpected HTTP 500 from o/r (GitHub) while listing releases: server error",
            500,
            "server error"
        );

        const zh = notifier(zhCN).describeError(error);
        expect(zh).toBe(zhCN.host.requestFailed(500, "server error"));
        expect(zh).not.toContain("Unexpected HTTP");

        const english = notifier(en).describeError(error);
        expect(english).toBe(en.host.requestFailed(500, "server error"));
    });

    it("服务端没给说明时也不出现 undefined", () => {
        const error = new HttpStatusError("Unexpected HTTP 502", 502, "");
        const text = notifier(zhCN).describeError(error);

        expect(text).toContain("502");
        expect(text).not.toContain("undefined");
    });
});

/**
 * 进度提示（`Notifier.progress`）。
 *
 * 由来是用户的一句原话：「获取插件时，请显示加载动画，不然我根本不知道你是不是
 * 在更新」。装一个插件的网络等待可以到 17~20 秒（GitHub 资产域名的冷连接，
 * 见 HANDOVER 第七节第 19 条），这段时间必须有东西在动、而且要说清在等什么。
 */
describe("进度提示", () => {
    /** 提示条里的全部文本。 */
    function noticeTexts(notice: { noticeEl: HTMLElement }): string[] {
        const walk = (node: unknown): string[] => {
            const el = node as { text?: string; children?: unknown[] };
            return [...(el.text ? [el.text] : []), ...(el.children ?? []).flatMap(walk)];
        };
        return ((notice.noticeEl.children as unknown) as unknown[]).flatMap(walk);
    }

    /** 提示条里有没有那个会转的圆环。 */
    function hasSpinner(notice: { noticeEl: HTMLElement }): boolean {
        const walk = (node: unknown): boolean => {
            const el = node as { cls?: string; children?: unknown[] };
            if ((el.cls ?? "").includes("obsync-spinner")) return true;
            return (el.children ?? []).some(walk);
        };
        return ((notice.noticeEl.children as unknown) as unknown[]).some(walk);
    }

    it("建一个带圆环、不自动消失的提示，并把文案写进去", () => {
        const before = Notice.instances.length;
        notifier(zhCN).progress("Trefoil：正在获取 main.js…");

        expect(Notice.instances.length).toBe(before + 1);
        const notice = Notice.instances[Notice.instances.length - 1]!;
        expect(hasSpinner(notice)).toBe(true);
        expect(noticeTexts(notice)).toContain("Trefoil：正在获取 main.js…");
        // 超时 0 = 不自动消失：它由 done() 收起，不该在下载中途自己跑掉
        expect(notice.timeout).toBe(0);
    });

    it("update 换文案（复用同一个提示，不再新建一个）", () => {
        const progress = notifier(zhCN).progress("第一句");
        const count = Notice.instances.length;
        const notice = Notice.instances[count - 1]!;

        progress.update("第二句");

        expect(Notice.instances.length).toBe(count);
        expect(noticeTexts(notice)).toEqual(["第二句"]);
        expect(hasSpinner(notice)).toBe(true);
    });

    it("**关掉提示设置时不建任何提示**（与其它提示一致，见设置页的说明）", () => {
        // 那种情况下「还在跑」由行上的图标按钮自己转来承担（见 TrackedItemsList）。
        const silent = new Notifier({ getShowNotices: () => false, getT: () => zhCN });
        const before = Notice.instances.length;

        const progress = silent.progress("不该出现");
        progress.update("也不该出现");
        progress.done();

        expect(Notice.instances.length).toBe(before);
    });
});
