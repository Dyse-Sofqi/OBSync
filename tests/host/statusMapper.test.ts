import { describe, expect, it } from "vitest";
import { throwForStatus, type StatusContext } from "../../src/host/statusMapper";
import {
    AuthError,
    HttpStatusError,
    NotFoundError,
    RateLimitError,
} from "../../src/host/errors";

/**
 * 状态码 → 错误类型的映射。
 *
 * 这段逻辑此前**没有任何测试** —— 补它的起因是一次变异验证：我把
 * `HttpStatusError` 换回 `ObsyncError` 后发现用例照样全绿，才意识到
 * 那些用例直接构造错误对象，压根没走这条映射路径。
 *
 * 「判定条件由各 host 提供」是这里的核心设计（见 statusMapper 的说明），
 * 所以用例要覆盖两个平台各自的限流表达方式。
 */

function context(overrides: Partial<StatusContext>): StatusContext {
    return {
        host: "github",
        displayName: "GitHub",
        status: 200,
        headers: {},
        text: "",
        isRateLimited: false,
        ...overrides,
    };
}

/** 断言抛出的是某类错误，并返回它以便继续断言字段。 */
function catchError(ctx: StatusContext): Error {
    try {
        throwForStatus(ctx);
    } catch (err) {
        return err as Error;
    }
    throw new Error("期望抛错，但没有");
}

describe("throwForStatus", () => {
    it("401 → AuthError", () => {
        expect(catchError(context({ status: 401 }))).toBeInstanceOf(AuthError);
    });

    it("403 且未判定为限流 → AuthError（权限问题，不是限流）", () => {
        const error = catchError(context({ status: 403, isRateLimited: false }));

        expect(error).toBeInstanceOf(AuthError);
        expect(error).not.toBeInstanceOf(RateLimitError);
    });

    it("403 且判定为限流 → RateLimitError（判定条件由各 host 提供）", () => {
        expect(
            catchError(context({ status: 403, isRateLimited: true }))
        ).toBeInstanceOf(RateLimitError);
    });

    it("404 → NotFoundError，并带上仓库标识", () => {
        const error = catchError(context({ status: 404, repo: "o/r" }));

        expect(error).toBeInstanceOf(NotFoundError);
        expect((error as NotFoundError).repo).toBe("o/r");
    });

    it("429 → RateLimitError", () => {
        expect(catchError(context({ status: 429 }))).toBeInstanceOf(RateLimitError);
    });

    it("**意料之外的状态码 → HttpStatusError**（而不是裸 ObsyncError）", () => {
        // 这条是关键：若退回 ObsyncError，展示层就会把英文技术描述直接给用户看。
        for (const status of [500, 502, 422, 418]) {
            const error = catchError(context({ status, text: '{"message":"boom"}' }));

            expect(error, `HTTP ${status}`).toBeInstanceOf(HttpStatusError);
            expect((error as HttpStatusError).status).toBe(status);
        }
    });

    it("HttpStatusError 带上服务端说明，供展示层拼中文文案", () => {
        const error = catchError(
            context({ status: 500, text: '{"message":"internal server error"}' })
        ) as HttpStatusError;

        expect(error.detail).toBe("internal server error");
    });

    it("服务端没给说明时 detail 是空串（不是 undefined）", () => {
        const error = catchError(context({ status: 502, text: "" })) as HttpStatusError;

        expect(error.detail).toBe("");
    });

    it("限流错误原样带上调用方给的恢复时间", () => {
        // 注意：响应头的解析（`parseRateLimitReset`）是各 host 的职责，
        // 这里只验证「传进来的 resetAt 会被带进错误」。
        const error = catchError(
            context({ status: 403, isRateLimited: true, resetAt: 1_800_000_000_000 })
        ) as RateLimitError;

        expect(error.resetAt).toBe(1_800_000_000_000);
    });

    it("错误信息里带上仓库与正在做的事，便于排查", () => {
        const error = catchError(
            context({ status: 404, repo: "o/r", action: "listing releases" })
        );

        expect(error.message).toContain("o/r");
        expect(error.message).toContain("listing releases");
    });
});
