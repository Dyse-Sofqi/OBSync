import type { LocaleStrings } from "../../core/i18n";
import { ObsyncError } from "../../host/errors";

/**
 * 图片同步 / R2 客户端的错误类型。
 *
 * ## 为什么用「类型码 + 参数」而不是一堆子类
 *
 * 这里的分支比 git 层多（配置缺失、鉴权、桶不存在、列举失败、逐文件的读/写/传/删
 * 失败、图片解码失败…），而每一个分支的文案都要带上**不同的参数**
 * （路径、状态码、服务端说明）。写成一堆子类的话，`describeImageSyncError` 里
 * 就是一条 `instanceof` 长链，新增一个分支忘了加文案**不会有任何提示**。
 *
 * 用可辨识联合 + `switch` + `const exhaustive: never = detail`，新增类型码而忘了
 * 加文案会**编译报错** —— 这是这个项目里已经验证过的写法（见 `installer/errors.ts`）。
 *
 * ## 消息文案的归属
 *
 * 抛出点（`r2Client` / `imageSyncService`）是纯逻辑，拿不到 `t`，所以 `message`
 * 只放**技术性描述（英文）**，进日志用；用户看到的话由展示层按类型码拼。
 * 不做这层的话，症状是**英文界面下冒出一句中文错误**。
 */

export type ImageSyncErrorKind =
    /** R2 的配置不全（缺账号 / 桶 / 密钥）。 */
    | "notConfigured"
    /** 一个图片文件夹都没配。 */
    | "noFolders"
    /** 鉴权失败（AK/SK 不对，或没有该桶的权限）。 */
    | "authFailed"
    /** 桶不存在或不可访问。 */
    | "bucketNotFound"
    /** 列举对象失败。 */
    | "listFailed"
    /** 上传失败。 */
    | "uploadFailed"
    /** 下载失败。 */
    | "downloadFailed"
    /** 删除远端对象失败。 */
    | "deleteFailed"
    /** 传输层失败（连不上、超时）。 */
    | "network"
    /** 读本地文件失败。 */
    | "localReadFailed"
    /** 写本地文件失败。 */
    | "localWriteFailed"
    /** 图片解码失败（文件损坏，或浏览器不认这个格式）。 */
    | "decodeFailed";

/** 每种类型码携带的参数。参数形状由类型码决定 —— 这是可辨识联合的价值。 */
export interface ImageSyncErrorDetail {
    notConfigured: { missing: string };
    noFolders: Record<string, never>;
    authFailed: { status: number };
    bucketNotFound: { bucket: string };
    listFailed: { status: number; detail: string };
    uploadFailed: { path: string; status: number; detail: string };
    downloadFailed: { path: string; status: number; detail: string };
    deleteFailed: { path: string; status: number; detail: string };
    network: { detail: string };
    localReadFailed: { path: string; detail: string };
    localWriteFailed: { path: string; detail: string };
    decodeFailed: { path: string };
}

export class ImageSyncError extends ObsyncError {
    readonly kind: ImageSyncErrorKind;
    readonly params: ImageSyncErrorDetail[ImageSyncErrorKind];

    constructor(
        kind: ImageSyncErrorKind,
        params: ImageSyncErrorDetail[ImageSyncErrorKind] = {} as never,
        options?: { cause?: unknown }
    ) {
        // `message` 是给日志的英文技术描述；`kind` 才是给展示层的。
        super(`Image sync failed: ${kind} ${JSON.stringify(params)}`, options);
        this.kind = kind;
        this.params = params;
    }
}

/** 少一个配置项就报一次的辅助函数 —— 让「缺什么」在文案里说得出来。 */
export function requireConfig(
    values: Record<string, string>,
    required: string[]
): ImageSyncError | undefined {
    const missing = required.filter((name) => !values[name]);
    if (missing.length === 0) return undefined;
    return new ImageSyncError("notConfigured", { missing: missing.join(", ") });
}

/**
 * 把图片模块的错误翻译成用户可读文案。
 *
 * 在 `createImageSyncModule` 里注册进 `Notifier`，于是任何调用点
 * （命令、设置页、工具条）报错都会自动走这里，不会漏。
 */
export function describeImageSyncError(
    err: unknown,
    t: LocaleStrings
): string | undefined {
    if (!(err instanceof ImageSyncError)) return undefined;

    const e = t.images.errors;
    const detail = err.params;

    switch (err.kind) {
        case "notConfigured": {
            const missing = (detail as ImageSyncErrorDetail["notConfigured"]).missing;
            return e.notConfigured(missing);
        }
        case "noFolders":
            return e.noFolders;
        case "authFailed":
            return e.authFailed;
        case "bucketNotFound": {
            const bucket = (detail as ImageSyncErrorDetail["bucketNotFound"]).bucket;
            return e.bucketNotFound(bucket);
        }
        case "listFailed": {
            const d = detail as ImageSyncErrorDetail["listFailed"];
            return e.listFailed(d.status, d.detail);
        }
        case "uploadFailed": {
            const d = detail as ImageSyncErrorDetail["uploadFailed"];
            return e.uploadFailed(d.path, d.status, d.detail);
        }
        case "downloadFailed": {
            const d = detail as ImageSyncErrorDetail["downloadFailed"];
            return e.downloadFailed(d.path, d.status, d.detail);
        }
        case "deleteFailed": {
            const d = detail as ImageSyncErrorDetail["deleteFailed"];
            return e.deleteFailed(d.path, d.status, d.detail);
        }
        case "network": {
            const d = detail as ImageSyncErrorDetail["network"];
            return e.network(d.detail);
        }
        case "localReadFailed": {
            const d = detail as ImageSyncErrorDetail["localReadFailed"];
            return e.localReadFailed(d.path, d.detail);
        }
        case "localWriteFailed": {
            const d = detail as ImageSyncErrorDetail["localWriteFailed"];
            return e.localWriteFailed(d.path, d.detail);
        }
        case "decodeFailed": {
            const d = detail as ImageSyncErrorDetail["decodeFailed"];
            return e.decodeFailed(d.path);
        }
    }

    // 新增类型码却忘了加文案时，这一行会编译报错 —— 不会留到运行时。
    const exhaustive: never = err.kind;
    return exhaustive;
}
