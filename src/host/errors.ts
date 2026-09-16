import type { HostKind, RepoId } from "./types";

/**
 * host 层的错误类型。
 *
 * 刻意区分这几种，是因为它们的**应对方式完全不同**：
 * - `RateLimitError` → 告诉用户什么时候恢复，不要重试
 * - `AuthError` → 引导用户去设置页填令牌
 * - `NotFoundError` → 提示地址写错了
 * - `NetworkError` → 可以重试
 * 上层 UI 靠 `instanceof` 分派到不同的提示文案，而不是靠解析错误消息字符串。
 */

export class ObsyncError extends Error {
    /**
     * `Error.cause` 是 ES2022 才进 lib 的，而本项目的 target/lib 是 ES2018。
     * 显式声明一次，避免 `this.cause = ...` 报 TS2339。
     */
    declare readonly cause?: unknown;

    constructor(message: string, options?: { cause?: unknown }) {
        super(message);
        this.name = new.target.name;
        if (options?.cause !== undefined) this.cause = options.cause;
        // 保证 instanceof 在降级编译后依然可靠。
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

/** 网络层失败：连不上、超时、DNS 失败等。可重试。 */
export class NetworkError extends ObsyncError {}

/** 鉴权失败：令牌无效、缺失或权限不足。 */
export class AuthError extends ObsyncError {
    constructor(
        message: string,
        readonly host: HostKind,
        options?: { cause?: unknown }
    ) {
        super(message, options);
    }
}

/** 资源不存在。 */
export class NotFoundError extends ObsyncError {
    constructor(
        message: string,
        readonly repo?: RepoId,
        options?: { cause?: unknown }
    ) {
        super(message, options);
    }
}

/** 触发平台限流。`resetAt` 是恢复时间戳（毫秒），拿不到时为 undefined。 */
export class RateLimitError extends ObsyncError {
    constructor(
        message: string,
        readonly host: HostKind,
        readonly resetAt?: number,
        options?: { cause?: unknown }
    ) {
        super(message, options);
    }
}

/** 仓库地址无法解析。 */
export class ParseError extends ObsyncError {}

/** 平台不受支持（例如用户粘了 GitLab 链接）。 */
export class UnsupportedHostError extends ObsyncError {
    constructor(
        message: string,
        readonly input: string,
        options?: { cause?: unknown }
    ) {
        super(message, options);
    }
}

/**
 * 意料之外的 HTTP 状态码（既不是 401/403/404/429 那几类，也不是网络失败）。
 *
 * 单独一个类型是为了能本地化：这类错误的原始文案是英文技术描述
 * （`Unexpected HTTP 500 from ... while ...`），直接抛出去会让中文用户
 * 在界面上看到一句英文。带上 `status` 与 `detail`，展示层就能拼出中文。
 */
export class HttpStatusError extends ObsyncError {
    constructor(
        message: string,
        readonly status: number,
        readonly detail: string,
        options?: { cause?: unknown }
    ) {
        super(message, options);
    }
}
