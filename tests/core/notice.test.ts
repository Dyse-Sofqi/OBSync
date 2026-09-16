import { describe, expect, it } from "vitest";
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
