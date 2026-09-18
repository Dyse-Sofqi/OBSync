import type { LocaleStrings } from "../../core/i18n";
import { logger } from "../../core/logger";
import type { ObsyncSettings } from "../../core/settings";
import type { RepoRef } from "../../host/types";
import type { SelfUpdateCheck } from "./types";

/**
 * OBSync 自身的更新：检查、写盘、以及「待重启」这件事的记账。
 *
 * ## 为什么不把它自己塞进跟踪列表
 *
 * 跟踪列表是「用户装了什么」的清单，每一项旁边都挂着「冻结 / 取消绑定」这类操作 ——
 * 对自己没有意义；而绑定弹窗也刻意跳过自己（见 `existingPlugins.ts` 的
 * `SELF_PLUGIN_ID`）。所以自己走设置页里单独的一节：当前版本 + 检查更新 + 更新。
 *
 * ## 更新只写文件，**不重载自己**（这块的核心取舍）
 *
 * 别的插件更新完是 disable → enable 重载；对自己这么干是**先卸载正在执行这段
 * 更新代码的实例**，剩下半段靠闭包才活着。它能成，但那是靠副作用成功 ——
 * 中途任一步失败就停在「已禁用」，而来得及提示你的代码已经不在了。
 *
 * 所以这里写盘后只做一件事：把版本号记进设置（`pendingRestartVersion`）。
 * 用户重启 Obsidian 后加载的就是新代码；在那之前，设置页那一行会一直显示
 * 「已下载 x，重启后生效」——**不能默默把徽标清掉**，否则用户以为已经在用新版本了，
 * 实际跑的还是旧的。
 *
 * 标记在**每次加载时清空**：加载成功即代表跑的就是磁盘上那份（见 `clearPendingRestart`）。
 */

/**
 * OBSync 自己的仓库坐标。
 *
 * 写死在代码里，不从 manifest / authorUrl 推导 —— manifest 没有 repo 字段，
 * 而 `authorUrl` 是作者主页。也正因如此，`updateSelf` 在写盘前必须校验远端
 * manifest 的 id 是不是 `obsync`：这个常量万一指错了地方，拦住远比
 * 按错的 id 去解析目录、覆盖掉别的插件强。
 */
export const SELF_REPO: RepoRef = {
    host: "github",
    owner: "Dyse-Sofqi",
    repo: "OBSync",
};

/**
 * 我们自己的插件 id —— 必须与 `manifest.json` 的 `id` 一致。
 *
 * 两个用途：绑定列表跳过自己（`existingPlugins.ts`），
 * 以及自我更新时校验远端身份（不是这个 id 就不写盘）。
 */
export const SELF_PLUGIN_ID = "obsync";

/** 上次会话下载了新版本但还没重启时，记录的是哪个版本（空串 = 没有）。 */
export function readPendingRestart(settings: ObsyncSettings): string {
    return settings.installer.pendingRestartVersion;
}

/** 记下「磁盘上的新版本已就位、等重启」。 */
export function setPendingRestart(settings: ObsyncSettings, version: string): void {
    settings.installer.pendingRestartVersion = version;
}

/**
 * 加载时清掉待重启标记。
 *
 * 每次加载都该清：这次加载跑的就是磁盘上的那份（写盘失败会回滚，不会留下
 * 「磁盘新、运行旧」而标记没设上的组合）。反过来，不清的话设置页会一直挂着
 * 「待重启」——用户重启了却发现提示还在，那才是真的说不清。
 *
 * @returns 是否真的清掉了（调用方据此决定要不要落盘）。
 */
export function clearPendingRestart(settings: ObsyncSettings): boolean {
    const pending = settings.installer.pendingRestartVersion;
    if (!pending) return false;

    logger.info(`OBSync ${pending} is running now; clearing the pending-restart flag`);
    settings.installer.pendingRestartVersion = "";
    return true;
}

/** 设置页那一行状态该显示什么。 */
export interface SelfStateInput {
    /** 运行中的版本。 */
    currentVersion: string;
    /** 最近一次检查的结果（没查过时为 undefined）。 */
    check?: SelfUpdateCheck;
    /** 待重启的版本（`readPendingRestart`）。 */
    pendingRestartVersion: string;
    /** 正在做什么 —— 忙碌时状态行要让位给进度提示。 */
    busy?: "checking" | "updating";
}

/**
 * 把上面那些状态拼成一行给用户看的话。
 *
 * 抽成纯函数是为了能单测：真正渲染的那一段依赖 Obsidian 的设置页 DOM，
 * 在 node 环境里测不了（与 `shouldCheckOnSettingsOpen` 同一个理由）。
 *
 * 优先级：忙碌 > 待重启 > 未检查 > 出错 > 有更新 > 已是最新。
 * 「待重启」压在检查结果之上是刻意的：它讲的是**现在跑的**不是最新的那份，
 * 远端有没有更新的都要等重启之后再说。
 */
export function describeSelfState(input: SelfStateInput, t: LocaleStrings): string {
    if (input.busy === "checking") return t.installer.checking;
    if (input.busy === "updating") return t.installer.selfUpdating;

    if (input.pendingRestartVersion) {
        return t.installer.selfPendingRestart(input.pendingRestartVersion);
    }
    if (!input.check) return t.installer.selfNotChecked(input.currentVersion);
    if (input.check.error !== undefined) {
        return t.installer.selfCheckFailed(input.check.error);
    }
    if (input.check.hasUpdate) {
        return t.installer.selfUpdateAvailable(
            input.currentVersion,
            input.check.latestVersion
        );
    }
    return t.installer.selfUpToDate(input.currentVersion);
}
