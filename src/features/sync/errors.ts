import type { LocaleStrings } from "../../core/i18n";
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
 *
 * ## 消息文案的归属
 *
 * 抛错处（`simpleGitManager`）**拿不到 `t`** —— 它是纯逻辑层，不该依赖 i18n。
 * 所以那里抛的 `message` 是**技术性描述**（英文、给日志和排查用），
 * 面向用户的话由 `describeSyncError` 在展示层按类型拼出来。
 *
 * 不做这层的话，症状是**英文界面下冒出一句中文错误** —— 因为早期实现把
 * 中文文案直接烘焙进了 `message`，而 `Notifier` 对 `ObsyncError` 是原样返回。
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

/**
 * 平台不接受凭据里的**用户名** —— 与令牌本身无关。
 *
 * 为什么不并进 `GitAuthError`：**应对方式不同**。
 * `GitAuthError` 引导用户去查令牌，那是对的（令牌确实可能是问题）；
 * 但这一条里令牌是好的，问题在插件填的用户名 —— 并进前者会让用户
 * 去反复检查一个没问题的令牌。**错误类型用错比没有类型更糟。**
 *
 * 实测依据：Gitee 只接受 账号名 / `oauth2` / `gitee.com` 三种用户名，
 * 其余一律拒绝（服务端原文见 `docs/reference-analysis.md` 差异 6）。
 * 症状极隐蔽：公开仓库照常能读，只有推送失败。
 */
export class GitCredentialUsernameRejectedError extends ObsyncError {}

/** 远端拒绝推送（本地落后，需要先 pull）。 */
export class PushRejectedError extends ObsyncError {}

/**
 * 当前分支没有跟踪的远端分支，无法拉取。
 *
 * 单独一个类型而不是复用 `GitNotRepoError`：那是「压根不是 git 仓库」，
 * 提示语是「请先初始化仓库」—— 用在这里会让用户去初始化一个已经存在的仓库，
 * 完全指错方向。**错误类型用错比没有类型更糟**。
 */
export class NoUpstreamError extends ObsyncError {}

/** 处于游离 HEAD 状态（没有指向任何分支），无法推送。 */
export class DetachedHeadError extends ObsyncError {}

/**
 * git 命令卡住了（长时间没有任何输出）而被中止。
 *
 * 为什么要单独一个类型：它的**应对方式与别的错误都不一样**。用户看到的
 * 症状是「状态栏一直在推送/拉取，什么都没有发生」，而这句话本身不含任何
 * 可行动信息 —— 不知道是网络、是凭据、还是插件坏了。明确说「超时、已中止、
 * 检查网络或代理」才是他能做的事。
 *
 * 现实触发路径：网络中断后的连接悬挂、需要凭据却无人可问（见
 * `simpleGitManager` 里的 `GIT_NONINTERACTIVE_ENV`）、巨大的仓库在传输中僵住。
 */
export class GitTimeoutError extends ObsyncError {}

/**
 * 把 git 层的错误翻译成用户可读文案。
 *
 * 在 `createSyncModule` 里注册进 `Notifier`，这样任何调用点
 * （命令、状态栏、视图）报错时都会自动走这里，不会漏。
 *
 * @returns 认不出的错误返回 undefined，交回 `Notifier` 的通用规则。
 */
export function describeSyncError(err: unknown, t: LocaleStrings): string | undefined {
    if (err instanceof GitBinaryMissingError) return t.sync.gitNotFound;
    if (err instanceof GitNotRepoError) return t.sync.notARepo;
    if (err instanceof GitCredentialUsernameRejectedError) {
        return t.sync.gitCredentialUsernameRejected;
    }
    if (err instanceof GitAuthError) return t.sync.gitAuthFailed;
    if (err instanceof PushRejectedError) return t.sync.pushRejected;
    if (err instanceof NoUpstreamError) return t.sync.noUpstream;
    if (err instanceof DetachedHeadError) return t.sync.detachedHead;
    if (err instanceof GitTimeoutError) return t.sync.gitTimeout;
    if (err instanceof ConflictError) return t.sync.conflictDetected(err.files.length);
    return undefined;
}
