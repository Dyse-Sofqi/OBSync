/**
 * 分级日志。
 *
 * 只在「输出调试日志」打开时写 debug/info，warn/error 始终输出 ——
 * 参考项目 BRAT 有一个 verbose 开关，但错误信息无论如何都该留下痕迹。
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const PREFIX = "[OBSync]";

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
        console.info(PREFIX, message, ...args);
    }

    warn(message: string, ...args: unknown[]): void {
        console.warn(PREFIX, message, ...args);
    }

    error(message: string, ...args: unknown[]): void {
        console.error(PREFIX, message, ...args);
    }
}

export const logger = new Logger();
