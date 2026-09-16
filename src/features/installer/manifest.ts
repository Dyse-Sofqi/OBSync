import { ObsyncError } from "../../host/errors";
import type { PluginManifest } from "./types";

/**
 * manifest.json 的解析与校验。
 *
 * 参考项目 BRAT 的校验散在 `validateRepository` 与 `addPlugin` 两处，
 * 且只在「缺 version」和「main.js 为 null」时中止。这里集中成一个函数，
 * 并明确区分「不是插件仓库」和「是插件仓库但缺少某个字段」——
 * 前者要提示用户地址可能给错了，后者是数据问题。
 */

const REQUIRED_FIELDS = ["id", "name", "version", "minAppVersion"] as const;

export class InvalidManifestError extends ObsyncError {}

/** Obsidian 的插件 id 规则：小写字母、数字、连字符。 */
const PLUGIN_ID_RE = /^[a-z0-9-]+$/;

export function parseManifest(raw: string, context: string): PluginManifest {
    let data: unknown;
    try {
        data = JSON.parse(raw);
    } catch (cause) {
        throw new InvalidManifestError(`${context} 的 manifest.json 不是合法的 JSON。`, {
            cause,
        });
    }

    if (typeof data !== "object" || data === null || Array.isArray(data)) {
        throw new InvalidManifestError(`${context} 的 manifest.json 不是对象。`);
    }

    const record = data as Record<string, unknown>;

    for (const field of REQUIRED_FIELDS) {
        const value = record[field];
        if (typeof value !== "string" || value.trim() === "") {
            throw new InvalidManifestError(
                `${context} 的 manifest.json 缺少必需字段 "${field}"。`
            );
        }
    }

    const id = record.id as string;
    if (!PLUGIN_ID_RE.test(id)) {
        // id 会被用作目录名，非法字符会造成路径问题，必须在写入前拦下。
        throw new InvalidManifestError(
            `${context} 的插件 id "${id}" 不合法（只允许小写字母、数字和连字符）。`
        );
    }

    return {
        id,
        name: record.name as string,
        version: record.version as string,
        minAppVersion: record.minAppVersion as string,
        description: typeof record.description === "string" ? record.description : undefined,
        author: typeof record.author === "string" ? record.author : undefined,
        authorUrl: typeof record.authorUrl === "string" ? record.authorUrl : undefined,
        isDesktopOnly: record.isDesktopOnly === true,
    };
}

/**
 * 校验 manifest 是否与当前 Obsidian 版本兼容。
 *
 * 只做「太低」的判断，不做「太高」的猜测 —— `requireApiVersion` 由调用方
 * 在能访问 Obsidian API 的地方调用（便于测试）。
 */
export function isManifestCompatible(
    manifest: PluginManifest,
    requireApiVersion: (version: string) => boolean
): boolean {
    return requireApiVersion(manifest.minAppVersion);
}

/**
 * 判断两个版本号是否等价。
 *
 * manifest 里的 version 与 release tag 经常不一致（tag 带 `v` 前缀、
 * 带 `-beta.1` 后缀），所以比较前先做归一化。返回 false 不代表有问题，
 * 只是提示调用方"以 manifest 为准"。
 */
export function versionsLookEquivalent(a: string, b: string): boolean {
    return normalizeVersion(a) === normalizeVersion(b);
}

function normalizeVersion(version: string): string {
    return version.trim().replace(/^v/i, "").toLowerCase();
}
