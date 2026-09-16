import os from "node:os";

/**
 * 提交信息模板展开。
 *
 * 支持的变量与 obsidian-git 对齐（用户从它迁移过来时模板不用改）：
 * - `{{date}}`   —— 提交时刻（本地时区，`YYYY-MM-DD HH:mm:ss`）
 * - `{{hostname}}` —— 机器名，多设备同步时能看出是哪台设备提交的
 * - `{{numFiles}}` —— 本次提交的文件数
 * - `{{files}}`    —— 文件名列表（逗号 + 空格分隔），文件多时截断
 *
 * 参考项目的 date 用 moment 自定义格式设置项，这里固定一种紧凑格式 ——
 * 提交信息不是给人阅读的日志主体，不值得为它开一个设置项。
 */

/** 文件名列表最多展示的字符数，超出截断（obsidian-git 的默认行为是 200）。 */
const FILES_LIST_LIMIT = 200;

export function renderCommitMessage(
    template: string,
    input: {
        /** 已暂存的文件路径。 */
        files: string[];
        /** 提交时刻，默认当前时间。测试可注入。 */
        now?: Date;
        /** 机器名，默认 `os.hostname()`。测试可注入。 */
        hostname?: string;
    }
): string {
    const now = input.now ?? new Date();
    const hostname = input.hostname ?? hostnameOf();
    const files = input.files;

    let fileList = files.join(", ");
    if (fileList.length > FILES_LIST_LIMIT) {
        fileList = `${fileList.slice(0, FILES_LIST_LIMIT)}…`;
    }

    return template
        .replaceAll("{{date}}", formatDate(now))
        .replaceAll("{{hostname}}", hostname)
        .replaceAll("{{numFiles}}", String(files.length))
        .replaceAll("{{files}}", fileList);
}

function formatDate(date: Date): string {
    const pad = (value: number): string => String(value).padStart(2, "0");
    return (
        `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
        `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    );
}

function hostnameOf(): string {
    try {
        // node:os 在 Electron 渲染进程可用（阶段一构建配置已把 node 内置模块列为外部依赖）。
        return os.hostname();
    } catch {
        return "unknown";
    }
}
