import type { LocaleStrings } from "../../core/i18n";
import { ObsyncError } from "../../host/errors";
import type { TrackedKind } from "./types";

/**
 * 安装器的错误类型。
 *
 * ## 为什么要带「类型码」而不是直接写文案
 *
 * 抛出点（`manifest.ts` / `pluginFiles.ts` / `pluginFolder.ts`）是**纯函数**，
 * 拿不到 `t`，也不该依赖 i18n。早期实现的做法是把中文文案直接烘焙进 `message`，
 * 而 `Notifier` 对 `ObsyncError` 是原样返回 —— 结果是**英文界面下冒出中文错误**。
 *
 * 所以：错误只携带**结构化的类型码与参数**（`message` 里放技术性描述供日志排查），
 * 面向用户的话由 `describeInstallerError` 在展示层按类型拼。
 *
 * 用可辨识联合 + `switch` 穷尽检查：新增一个类型码时，翻译函数漏了会**编译不过**。
 * 这是这套机制比「直接写文案」强的地方 —— 漏翻译不会留到运行时。
 *
 * 主题加入后多了一类参数：`of: TrackedKind`。凡是「插件」与「主题」会共用同一个
 * 类型码的地方（缺文件、写盘失败……），文案必须按 `of` 选词 —— 早期版本的文案
 * 直接把「插件」写死在 locale 里，主题一进来就会说「插件 Minimal 缺少必需文件」。
 */

export type InstallerErrorDetail =
    | { kind: "manifestNotJson"; context: string }
    | { kind: "manifestNotObject"; context: string }
    | { kind: "manifestMissingField"; context: string; field: string }
    | { kind: "manifestBadId"; context: string; id: string }
    | { kind: "missingManifest"; repo: string; of: TrackedKind }
    | { kind: "missingRequiredFiles"; repo: string; files: string; of: TrackedKind }
    /**
     * release 里**挂着**该文件，但这次没取回来（网络/传输层问题）。
     *
     * 与 `missingRequiredFiles` 分开是因为两者给用户的下一步完全不同：
     * 那条是「作者没发这个文件」（去改发布流程），这条是「下载失败」
     * （检查网络后重试，或换 Gitee 镜像）。实测踩过 2026-09-19：GitHub 的
     * release 资产冷连接超时而报成「找不到 main.js」。
     */
    | { kind: "assetDownloadFailed"; repo: string; files: string; of: TrackedKind }
    /**
     * 手填的镜像地址里，插件 id 与跟踪的那一项不一致 —— **拒绝采用**。
     *
     * 只比仓库名会装错东西：同名不同项目在 Gitee 上很常见，而插件是能读写整个库的
     * 代码。所以这条不是客气的提醒，是硬拦（与自动探测同一条判据）。
     */
    | { kind: "mirrorIdMismatch"; repo: string; expected: string; found: string }
    | { kind: "missingBuildArtifacts" }
    | { kind: "incompatibleApp"; name: string; minVersion: string }
    | { kind: "pluginIdConflict"; pluginId: string; repo: string }
    | { kind: "folderMissingRequired"; id: string; file: string; of: TrackedKind }
    | { kind: "writeFailedRolledBack"; id: string; of: TrackedKind }
    | { kind: "writeFailedRollbackFailed"; id: string; of: TrackedKind }
    | { kind: "cannotEnablePlugin" }
    | { kind: "selfIdMismatch"; repo: string; id: string }
    | { kind: "selfUpdateDowngrade"; current: string; latest: string }
    | { kind: "communityIndexFailed"; status: number }
    | { kind: "rateLimitFallback"; host: string }
    | { kind: "apiUnavailableFallback"; host: string }
    | { kind: "rateLimited"; host: string };

export class InstallerError extends ObsyncError {
    constructor(
        readonly detail: InstallerErrorDetail,
        options?: { cause?: unknown }
    ) {
        // message 只服务于日志与排查：带上类型码和参数，不写面向用户的文案。
        super(`installer error [${detail.kind}] ${JSON.stringify(detail)}`, options);
    }
}

/**
 * 把安装器的错误翻译成用户可读文案。
 *
 * 在 `createInstallerModule` 里注册进 `Notifier`，所有调用点自动生效。
 *
 * @returns 认不出的错误返回 undefined，交回 `Notifier` 的通用规则。
 */
export function describeInstallerError(
    err: unknown,
    t: LocaleStrings
): string | undefined {
    if (!(err instanceof InstallerError)) return undefined;

    const detail = err.detail;
    const e = t.installer.errors;
    /**
     * 「插件 / 主题」这两个词本身也要跟着语言走 —— 在这里选一次，
     * 避免每个 case 各写一遍三元表达式。
     */
    const ofKind = (kind: TrackedKind): string =>
        kind === "plugin" ? t.installer.kindPlugin : t.installer.kindTheme;

    switch (detail.kind) {
        case "manifestNotJson":
            return e.manifestNotJson(detail.context);
        case "manifestNotObject":
            return e.manifestNotObject(detail.context);
        case "manifestMissingField":
            return e.manifestMissingField(detail.context, detail.field);
        case "manifestBadId":
            return e.manifestBadId(detail.context, detail.id);
        case "missingManifest":
            return e.missingManifest(detail.repo, ofKind(detail.of));
        case "missingRequiredFiles":
            return e.missingRequiredFiles(detail.repo, detail.files, ofKind(detail.of));
        case "assetDownloadFailed":
            return e.assetDownloadFailed(detail.repo, detail.files, ofKind(detail.of));
        case "mirrorIdMismatch":
            return e.mirrorIdMismatch(detail.repo, detail.expected, detail.found);
        case "missingBuildArtifacts":
            return e.missingBuildArtifacts;
        case "incompatibleApp":
            return e.incompatibleApp(detail.name, detail.minVersion);
        case "pluginIdConflict":
            return e.pluginIdConflict(detail.pluginId, detail.repo);
        case "folderMissingRequired":
            return e.folderMissingRequired(detail.id, detail.file, ofKind(detail.of));
        case "writeFailedRolledBack":
            return e.writeFailedRolledBack(detail.id, ofKind(detail.of));
        case "writeFailedRollbackFailed":
            return e.writeFailedRollbackFailed(detail.id, ofKind(detail.of));
        case "cannotEnablePlugin":
            return e.cannotEnablePlugin;
        case "selfIdMismatch":
            return e.selfIdMismatch(detail.repo, detail.id);
        case "selfUpdateDowngrade":
            return e.selfUpdateDowngrade(detail.current, detail.latest);
        case "communityIndexFailed":
            return e.communityIndexFailed(detail.status);
        case "rateLimitFallback":
            return e.rateLimitFallback(detail.host);
        case "apiUnavailableFallback":
            return e.apiUnavailableFallback(detail.host);
        case "rateLimited":
            return e.rateLimited(detail.host);
        default: {
            // 穷尽检查：新增 kind 却忘了在上面处理时，这里会编译报错。
            const exhaustive: never = detail;
            void exhaustive;
            return undefined;
        }
    }
}
