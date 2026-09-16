import { describe, expect, it } from "vitest";
import { redactUrl } from "../../src/host/redact";

/**
 * 凭据脱敏。
 *
 * ## 为什么这层值得单独测
 *
 * 它不是「锦上添花」，而是**令牌唯一不出门的关卡**。Gitee 的鉴权必须把令牌
 * 放查询串（`?access_token=...`），而 `http.ts` 会把 URL 写进错误消息 ——
 * 而错误消息会被 `Notifier` 原样弹到屏幕上、也会进 `console` 输出，
 * 后者正是用户报 issue 时要贴的东西。
 *
 * 两个方向都会出问题，所以都要有用例：
 *
 * - **漏脱**（该脱的没脱）→ 令牌泄漏，正是要防的事；
 * - **过脱**（不该脱的脱了）→ 排查问题时看不出请求打的是哪个地址、
 *   哪个分页、哪个分支，日志变废纸。
 *
 * 另外这里断言的多是**逐字相等**而不是「包含 `***`」：这层只做定点替换，
 * 不能顺手把 URL 规范化（补斜杠、重排参数）—— 否则日志里显示的地址
 * 与实际发出去的不是同一个，排查时会怀疑人生。
 */

describe("redactUrl：查询串里的凭据", () => {
    it("Gitee 的 access_token 被替换，其余逐字保留", () => {
        expect(
            redactUrl("https://gitee.com/api/v5/repos/o/r?access_token=abc123&page=2")
        ).toBe("https://gitee.com/api/v5/repos/o/r?access_token=***&page=2");
    });

    it("令牌在第一个参数位置时也命中", () => {
        expect(redactUrl("https://gitee.com/a?access_token=abc")).toBe(
            "https://gitee.com/a?access_token=***"
        );
    });

    it("认得出常见的几种凭据参数名", () => {
        const cases: Array<[string, string]> = [
            ["private_token", "***"],
            ["access-token", "***"],
            ["api_key", "***"],
            ["apikey", "***"],
            ["token", "***"],
            ["password", "***"],
            ["secret", "***"],
            ["auth", "***"],
        ];
        for (const [name] of cases) {
            expect(redactUrl(`https://example.invalid/a?${name}=SECRET`)).toBe(
                `https://example.invalid/a?${name}=***`
            );
        }
    });

    it("参数名大小写不敏感", () => {
        expect(redactUrl("https://example.invalid/a?Access_Token=SECRET")).toBe(
            "https://example.invalid/a?Access_Token=***"
        );
    });

    it("**不**碰非凭据参数 —— 排查时就看这些", () => {
        expect(
            redactUrl(
                "https://gitee.com/api/v5/repos/o/r/releases?direction=desc&page=1&per_page=100"
            )
        ).toBe(
            "https://gitee.com/api/v5/repos/o/r/releases?direction=desc&page=1&per_page=100"
        );
    });

    it("参数名里含 token 但不以它结尾的也认得出", () => {
        // `access_token` 靠「按分隔符切词段」命中，而不是逐个列举全名。
        expect(redactUrl("https://x.invalid/a?refresh_token_id=v")).toBe(
            "https://x.invalid/a?refresh_token_id=***"
        );
    });

    it("片段（#）不被当成查询串处理", () => {
        expect(redactUrl("https://x.invalid/a?access_token=S#token=frag")).toBe(
            "https://x.invalid/a?access_token=***#token=frag"
        );
    });

    it("没有查询串时**逐字**返回 —— 不做任何规范化", () => {
        // 故意用一个带重复斜杠、大小写混合的地址：规范化会改掉它。
        const url = "https://Gitee.com//api/v5/Repos/o/r.js";
        expect(redactUrl(url)).toBe(url);
    });

    it("空串原样返回", () => {
        expect(redactUrl("")).toBe("");
    });
});

describe("redactUrl：URL 里的 userinfo", () => {
    it("只脱密码，保留用户名（排查用户名被拒时要用）", () => {
        expect(redactUrl("https://oauth2:TOKEN@gitee.com/o/r.git")).toBe(
            "https://oauth2:***@gitee.com/o/r.git"
        );
    });

    it("没有冒号时整段脱掉（那种形态下它本身就是令牌）", () => {
        expect(redactUrl("https://ghp_abc123@github.com/o/r.git")).toBe(
            "https://***@github.com/o/r.git"
        );
    });

    it("用户名里带冒号时按最后一个冒号切（令牌可能含冒号）", () => {
        expect(redactUrl("https://user:a:b@gitee.com/o/r")).toBe(
            "https://user:a:***@gitee.com/o/r"
        );
    });

    it("userinfo 与查询串同时存在时都处理", () => {
        expect(redactUrl("https://oauth2:T@gitee.com/o/r?access_token=U&page=2")).toBe(
            "https://oauth2:***@gitee.com/o/r?access_token=***&page=2"
        );
    });

    it("普通地址（无 userinfo）不受影响", () => {
        const url = "https://api.github.com/repos/o/r/releases/latest";
        expect(redactUrl(url)).toBe(url);
    });
});

describe("redactUrl：自由文本里的地址", () => {
    /**
     * 用户会把整条命令粘进「仓库地址」输入框（从教程、聊天记录里复制），
     * 而这些输入会被 `Notifier` 原样回显到提示里。
     */
    it("整条 git clone 命令里的令牌也会被脱敏", () => {
        expect(
            redactUrl("git clone https://oauth2:TOKEN@gitee.com/o/r.git")
        ).toBe("git clone https://oauth2:***@gitee.com/o/r.git");
    });

    it("多处出现时全都处理", () => {
        expect(
            redactUrl("从 https://oauth2:T@gitee.com/o/r 克隆，或 git@gitee.com:o/r.git")
        ).toBe("从 https://oauth2:***@gitee.com/o/r 克隆，或 git@gitee.com:o/r.git");
    });

    /**
     * 下面两条是**过脱**的回归用例 —— 它们是写这层时真实踩到的：
     * 第一版按「`?` 之后全是查询串」处理，于是消息里地址后面的说明文字
     * 整段被当成参数值吃掉，日志退化成只剩地址，看不出那次是超时还是失败。
     *
     * 脱敏的失败方式有两种，只防一种是不够的。
     */
    it("地址后面的说明文字要留着（不是查询串的一部分）", () => {
        expect(
            redactUrl("Request to https://gitee.com/o/r?access_token=T timed out after 30000ms.")
        ).toBe(
            "Request to https://gitee.com/o/r?access_token=*** timed out after 30000ms."
        );
    });

    it("一条消息里出现两个带令牌的地址时，两个都要脱", () => {
        expect(
            redactUrl(
                "Request to https://gitee.com/a?access_token=ONE failed after 2 attempt(s): " +
                    "Request to https://gitee.com/b?access_token=TWO timed out."
            )
        ).toBe(
            "Request to https://gitee.com/a?access_token=*** failed after 2 attempt(s): " +
                "Request to https://gitee.com/b?access_token=*** timed out."
        );
    });
});
