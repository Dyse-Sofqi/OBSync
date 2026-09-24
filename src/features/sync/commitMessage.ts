import { Platform } from "obsidian";

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

/**
 * 机器名。
 *
 * **不静态 import `node:os`** —— 审核规则 `obsidianmd/no-nodejs-modules` 禁止
 * 静态导入 Node 内置模块（移动端没有 Node，静态导入会让整个插件在移动端加载失败），
 * 它要求的写法正是「`require` 落在 `Platform.isDesktop` 守卫内」。这里照办。
 *
 * 非桌面端返回空串：`{{hostname}}` 被替换成空，而不是让提交失败。
 * 取不到（Electron 之外的宿主）时退回 `"unknown"`，同样是「不阻断提交」。
 */
function hostnameOf(): string {
    if (!Platform.isDesktop) return "";
    try {
        const os = require("node:os") as typeof import("node:os");
        return os.hostname();
    } catch {
        return "unknown";
    }
}
