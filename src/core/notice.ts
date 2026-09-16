import { Notice } from "obsidian";
import type { LocaleStrings } from "./i18n";
import { logger } from "./logger";
import {
    AuthError,
    NetworkError,
    NotFoundError,
    ObsyncError,
    ParseError,
    RateLimitError,
    UnsupportedHostError,
} from "../host/errors";
import { formatRepoId } from "../host/repoRef";
import type { RepoRef } from "../host/types";

/**
 * 统一的用户提示。
 *
 * 两个职责：
 * 1. 受「显示操作结果提示」设置控制 —— 成功/进度提示可以静音，**错误始终显示**。
 * 2. 把 host 层的错误类型翻译成用户能看懂的话。
 *
 * 第 2 点是这个类存在的主要理由：host 层抛的是英文的技术错误，
 * 而用户看到的是「Gitee 接口调用次数已达上限，将于 xx 恢复」这种可行动的提示。
 */

const ERROR_NOTICE_TIMEOUT_MS = 8000;

export interface NotifierHost {
    /** 读当前设置。 */
    getShowNotices(): boolean;
    /** 读当前语言的翻译表。 */
    getT(): LocaleStrings;
}

export class Notifier {
    constructor(private readonly host: NotifierHost) {}

    private get showNotices(): boolean {
        return this.host.getShowNotices();
    }

    private get t(): LocaleStrings {
        return this.host.getT();
    }

    /** 成功提示。可被设置静音。 */
    success(message: string): void {
        if (!this.showNotices) return;
        new Notice(message);
    }

    /** 一般信息。可被设置静音。 */
    info(message: string): void {
        if (!this.showNotices) return;
        new Notice(message);
    }

    /** 警告。可被设置静音。 */
    warn(message: string): void {
        if (!this.showNotices) return;
        new Notice(message, ERROR_NOTICE_TIMEOUT_MS);
    }

    /** 错误。**不受设置影响** —— 静音错误会让人以为操作成功了。 */
    error(message: string): void {
        new Notice(message, ERROR_NOTICE_TIMEOUT_MS);
    }

    /**
     * 把任意异常翻译成用户提示并展示。
     *
     * @param err 捕获到的异常
     * @param fallback 无法归类时使用的兜底文案
     */
    reportError(err: unknown, fallback?: string): void {
        logger.error("operation failed", err);
        this.error(this.describeError(err, fallback));
    }

    /** 只做翻译，不展示 —— 供需要自己决定怎么显示的调用方使用。 */
    describeError(err: unknown, fallback?: string): string {
        const t = this.t;

        if (err instanceof RateLimitError) {
            const hostName = t.host[err.host];
            const resetAt = err.resetAt
                ? new Date(err.resetAt).toLocaleString()
                : t.common.unknown;
            return t.host.rateLimited(hostName, resetAt);
        }

        if (err instanceof AuthError) {
            return t.host.tokenInvalid(t.host[err.host]);
        }

        if (err instanceof NotFoundError) {
            const hostName = err.repo ? "GitHub / Gitee" : t.host.unknown;
            return t.host.notFound(hostName, err.repo ?? t.common.unknown);
        }

        if (err instanceof ParseError) {
            // ParseError 的消息里带原始输入，但那是英文的 —— 这里给中文的通用提示。
            return t.host.parseFailed(String(err.message).replace(/^.*?"(.*?)".*$/, "$1"));
        }

        if (err instanceof UnsupportedHostError) {
            return t.host.unsupportedHost(err.input);
        }

        if (err instanceof NetworkError) {
            return t.host.networkFailed(err.message);
        }

        if (err instanceof ObsyncError) {
            return err.message;
        }

        if (err instanceof Error) {
            return fallback ? `${fallback}：${err.message}` : err.message;
        }

        return fallback ?? String(err);
    }

    /** 提示用户某个仓库需要令牌。 */
    promptForToken(ref: RepoRef): void {
        const t = this.t;
        this.warn(t.host.tokenMissing(t.host[ref.host]));
    }

    /** 展示仓库标识的辅助方法，保证提示文案里格式统一。 */
    repoLabel(ref: RepoRef): string {
        return formatRepoId(ref);
    }
}
