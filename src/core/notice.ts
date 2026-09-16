import { Notice } from "obsidian";
import type { LocaleStrings } from "./i18n";
import { logger } from "./logger";
import {
    AuthError,
    HttpStatusError,
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

/**
 * 错误翻译器：把某个功能模块自己的错误类型翻译成用户可读文案。
 *
 * 返回 `undefined` 表示「不是我认识的错误」，交给下一个翻译器或兜底逻辑。
 */
export type ErrorTranslator = (err: unknown, t: LocaleStrings) => string | undefined;

export interface NotifierHost {
    /** 读当前设置。 */
    getShowNotices(): boolean;
    /** 读当前语言的翻译表。 */
    getT(): LocaleStrings;
}

export class Notifier {
    /**
     * 已注册的翻译器，按注册顺序尝试。
     *
     * 为什么做成注册制而不是在这里 `import` 各功能的错误类型：
     * `core/` 不该知道任何 `features/` 的东西。功能模块在装配时把自己那套
     * 错误 → 文案的映射注册进来，core 保持无知。
     *
     * 这条链路是必需的：像 git 层这种地方拿不到 `t`（它是纯逻辑，不该依赖 i18n），
     * 只能抛「带类型的错误 + 技术性描述」；用户能看懂的话在展示层才拼出来。
     * 不做这层的话，症状是**英文界面下冒出一句中文错误**。
     */
    private readonly translators: ErrorTranslator[] = [];

    constructor(private readonly host: NotifierHost) {}

    /** 功能模块在装配时调用。 */
    registerErrorTranslator(translator: ErrorTranslator): void {
        this.translators.push(translator);
    }

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

        // 先问各功能模块自己的翻译器 —— 它们比下面的通用规则更懂自己的错误类型。
        for (const translate of this.translators) {
            const described = translate(err, t);
            if (described !== undefined) return described;
        }

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

        if (err instanceof HttpStatusError) {
            // 意料之外的 HTTP 状态码（500 / 502 / 422 之类）。
            // 不带这一条的话会落到下面的 `ObsyncError → err.message`，
            // 中文用户在界面上看到的就是一句英文技术描述。
            return t.host.requestFailed(err.status, err.detail);
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
