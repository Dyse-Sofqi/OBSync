/**
 * 分级日志。
 *
 * 只在「输出调试日志」打开时写 debug/info，warn/error 始终输出 ——
 * 参考项目 BRAT 有一个 verbose 开关，但错误信息无论如何都该留下痕迹。
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const PREFIX = "[SyncHub]";

export class Logger {
    private verbose = false;

    setVerbose(verbose: boolean): void {
        this.verbose = verbose;
    }

    get isVerbose(): boolean {
        return this.verbose;
    }

    debug(message: string, ...args: unknown[]): void {
        if (!this.verbose) return;
        console.debug(PREFIX, message, ...args);
    }

    info(message: string, ...args: unknown[]): void {
        if (!this.verbose) return;
        // `console.debug` 而不是 `console.info`：社区审核的 `no-console` 规则
        // 只放行 debug / warn / error（info 与 log 会被报成
        // 「Avoid unnecessary logging to console」）。两者都是 verbose 门控的，
        // 行为上没有差别，所以按审核允许的那个写。
        console.debug(PREFIX, message, ...args);
    }

    warn(message: string, ...args: unknown[]): void {
        console.warn(PREFIX, message, ...args);
    }

    error(message: string, ...args: unknown[]): void {
        console.error(PREFIX, message, ...args);
    }
}

export const logger = new Logger();
