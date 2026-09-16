import type { LocaleStrings } from "../../core/i18n";
import { ObsyncError } from "../../host/errors";

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
 */

export type InstallerErrorDetail =
    | { kind: "manifestNotJson"; context: string }
    | { kind: "manifestNotObject"; context: string }
    | { kind: "manifestMissingField"; context: string; field: string }
    | { kind: "manifestBadId"; context: string; id: string }
    | { kind: "missingManifest"; repo: string }
    | { kind: "missingRequiredFiles"; repo: string; files: string }
    | { kind: "missingBuildArtifacts" }
    | { kind: "incompatibleApp"; name: string; minVersion: string }
    | { kind: "pluginIdConflict"; pluginId: string; repo: string }
    | { kind: "folderMissingRequired"; pluginId: string; file: string }
    | { kind: "writeFailedRolledBack"; pluginId: string }
    | { kind: "writeFailedRollbackFailed"; pluginId: string }
    | { kind: "cannotEnablePlugin" }
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
            return e.missingManifest(detail.repo);
        case "missingRequiredFiles":
            return e.missingRequiredFiles(detail.repo, detail.files);
        case "missingBuildArtifacts":
            return e.missingBuildArtifacts;
        case "incompatibleApp":
            return e.incompatibleApp(detail.name, detail.minVersion);
        case "pluginIdConflict":
            return e.pluginIdConflict(detail.pluginId, detail.repo);
        case "folderMissingRequired":
            return e.folderMissingRequired(detail.pluginId, detail.file);
        case "writeFailedRolledBack":
            return e.writeFailedRolledBack(detail.pluginId);
        case "writeFailedRollbackFailed":
            return e.writeFailedRollbackFailed(detail.pluginId);
        case "cannotEnablePlugin":
            return e.cannotEnablePlugin;
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
