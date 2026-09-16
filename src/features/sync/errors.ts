import { ObsyncError } from "../../host/errors";

/**
 * git 层的错误类型。
 *
 * 与 host 层的划分同理（见 `host/errors.ts`）：按**应对方式**分类，
 * 上层 UI 靠 `instanceof` 分派提示文案，而不是解析错误消息字符串。
 *
 * 这些错误必须从 `gitManager` 的实现里抛出，`syncService` 才能做出正确的
 * 用户引导 —— 比如 `GitBinaryMissingError` 要引导去设置页填 gitPath，
 * `ConflictError` 要引导打开冲突清单，普通 git 失败则展示原始错误。
 */

/** 当前 vault 不是 git 仓库（或 git 目录损坏）。引导用户执行「初始化仓库」。 */
export class GitNotRepoError extends ObsyncError {}

/** 找不到 git 可执行文件。引导用户去设置页指定 gitPath。 */
export class GitBinaryMissingError extends ObsyncError {}

/** 拉取时遇到未解决的冲突。`files` 是冲突文件列表，用于生成冲突引导。 */
export class ConflictError extends ObsyncError {
    constructor(
        message: string,
        readonly files: string[],
        options?: { cause?: unknown }
    ) {
        super(message, options);
    }
}

/** 鉴权失败：令牌缺失 / 无效 / 权限不足。引导用户去设置页填令牌。 */
export class GitAuthError extends ObsyncError {}

/** 远端拒绝推送（本地落后，需要先 pull）。 */
export class PushRejectedError extends ObsyncError {}
