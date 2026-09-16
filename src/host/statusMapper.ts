import { AuthError, HttpStatusError, NotFoundError, RateLimitError } from "./errors";
import { extractServerMessage } from "./http";
import type { HostKind, RepoId } from "./types";

/**
 * 把 HTTP 状态码翻译成 host 层的错误类型。
 *
 * 两个平台共用这段逻辑，但**判定条件由各自的 host 提供** —— 因为
 * GitHub 与 Gitee 表达「限流」和「无权限」的方式不同：
 * - GitHub：403 且 `x-ratelimit-remaining: 0` 才是限流，否则是权限问题；
 *             另有 429 表示二级限流。
 * - Gitee：403/429 都可能是限流，且不保证给出恢复时间。
 *
 * 如果把这套判断写成共用函数，就得在里面 `if (host === "github")`，
 * 那抽象层就白做了。所以只共用「映射结果」，不共用「判定输入」。
 */

export interface StatusContext {
    host: HostKind;
    displayName: string;
    status: number;
    headers: Record<string, string>;
    text: string;
    repo?: RepoId;
    /** 判定为限流时为 true。 */
    isRateLimited: boolean;
    /** 限流恢复时间戳（毫秒），拿不到则 undefined。 */
    resetAt?: number;
    /** 描述这次请求在做什么，用于拼错误信息。 */
    action?: string;
}

export function throwForStatus(ctx: StatusContext): never {
    const { status, displayName, repo, action } = ctx;
    const serverMessage = extractServerMessage(ctx.text);
    const where = repo ? `${repo} (${displayName})` : displayName;
    const what = action ? ` while ${action}` : "";
    const suffix = serverMessage ? `: ${serverMessage}` : "";

    if (ctx.isRateLimited) {
        throw new RateLimitError(
            `${displayName} API rate limit reached${what} for ${where}${suffix}`,
            ctx.host,
            ctx.resetAt
        );
    }

    switch (status) {
        case 401:
            throw new AuthError(
                `Authentication failed for ${where}${what}. Check the access token in settings${suffix}`,
                ctx.host
            );
        case 403:
            // 不是限流，那就是权限不够（例如令牌缺少 scope）
            throw new AuthError(
                `Access denied for ${where}${what}. The token may lack the required scope${suffix}`,
                ctx.host
            );
        case 404:
            throw new NotFoundError(
                `${where} was not found${what}${suffix}`,
                repo
            );
        case 429:
            throw new RateLimitError(
                `Too many requests to ${displayName}${what} for ${where}${suffix}`,
                ctx.host,
                ctx.resetAt
            );
        default:
            // 意料之外的状态码。带上 status 与服务端说明，让展示层能拼出中文 ——
            // 直接抛英文技术描述的话，中文用户在界面上会看到一句英文。
            throw new HttpStatusError(
                `Unexpected HTTP ${status} from ${where}${what}${suffix}`,
                status,
                serverMessage,
                { cause: undefined }
            );
    }
}
