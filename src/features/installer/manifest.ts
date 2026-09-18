import { PLUGIN_ID_RE } from "../../core/pluginId";
import type { PluginManifest, ThemeManifest } from "./types";
import { InstallerError } from "./errors";

/**
 * manifest.json 的解析与校验 —— 插件与主题各一个入口。
 *
 * 参考项目 BRAT 的校验散在 `validateRepository` 与 `addPlugin` 两处，
 * 且只在「缺 version」和「main.js 为 null」时中止。这里集中成函数，
 * 并明确区分「不是这类仓库」和「是这类仓库但缺少某个字段」——
 * 前者要提示用户地址可能给错了，后者是数据问题。
 *
 * ## 为什么主题是**另一个函数**，而不是给插件那个加个 kind 参数
 *
 * 必需字段本就不同（主题没有 `id`、`minAppVersion` 可选、多一个 `fundingUrl`），
 * 返回类型也不同。合并成一个函数意味着返回联合类型，于是每个调用点都要再判一次
 * kind —— 那正是 `types.ts` 用判别联合要避免的事。
 */

const PLUGIN_REQUIRED_FIELDS = ["id", "name", "version", "minAppVersion"] as const;

/** 解析出 JSON 对象，失败与「不是对象」各自报成自己的类型码。 */
function parseJsonObject(raw: string, context: string): Record<string, unknown> {
    let data: unknown;
    try {
        data = JSON.parse(raw);
    } catch (cause) {
        throw new InstallerError({ kind: "manifestNotJson", context }, { cause });
    }

    if (typeof data !== "object" || data === null || Array.isArray(data)) {
        throw new InstallerError({ kind: "manifestNotObject", context });
    }

    return data as Record<string, unknown>;
}

/** 取一个可选字符串字段：非空字符串才要，其余一律 undefined。 */
function optionalString(value: unknown): string | undefined {
    return typeof value === "string" && value ? value : undefined;
}

export function parsePluginManifest(raw: string, context: string): PluginManifest {
    const record = parseJsonObject(raw, context);

    for (const field of PLUGIN_REQUIRED_FIELDS) {
        const value = record[field];
        if (typeof value !== "string" || value.trim() === "") {
            throw new InstallerError({ kind: "manifestMissingField", context, field });
        }
    }

    const id = record.id as string;
    if (!PLUGIN_ID_RE.test(id)) {
        // id 会被用作目录名，非法字符会造成路径问题，必须在写入前拦下。
        throw new InstallerError({ kind: "manifestBadId", context, id });
    }

    return {
        id,
        name: record.name as string,
        version: record.version as string,
        minAppVersion: record.minAppVersion as string,
        description: optionalString(record.description),
        author: optionalString(record.author),
        authorUrl: optionalString(record.authorUrl),
        isDesktopOnly: record.isDesktopOnly === true,
    };
}

/**
 * 主题的 manifest.json。
 *
 * 必需字段只有 `name` —— 理由是实测出来的：
 *
 * - 主题**没有 id**，身份就是目录名（见 `TrackedBase.id`），所以这里不需要
 *   `PLUGIN_ID_RE` 那样的校验，也不该借用它；
 * - `version` 三份真实 manifest 都有（Minimal 9.1.0 / Things 2.2.4 /
 *   AnuPpuccin 1.5.0），但官方类型定义里缺 manifest 时的默认值就是 `"0.0.0"`。
 *   我们照 Obsidian 的规矩来：读不到就按 `0.0.0`，不去拦一个 Obsidian 自己
 *   会正常加载的仓库；
 * - `minAppVersion` 同样常见但非规范强制，故可选（兼容性检查只在它存在时做）。
 *
 * 这里的 `name` **只用于显示**：远端 manifest 的 name 不参与路径构造
 * （写盘落在本地已装的那个目录名上），所以名字古怪也不该拦住更新。
 */
export function parseThemeManifest(raw: string, context: string): ThemeManifest {
    const record = parseJsonObject(raw, context);

    const name = record.name;
    if (typeof name !== "string" || name.trim() === "") {
        throw new InstallerError({ kind: "manifestMissingField", context, field: "name" });
    }

    const version = record.version;
    if (version !== undefined && (typeof version !== "string" || version.trim() === "")) {
        throw new InstallerError({ kind: "manifestMissingField", context, field: "version" });
    }

    return {
        name,
        version: version ?? "0.0.0",
        minAppVersion: optionalString(record.minAppVersion),
        author: optionalString(record.author),
        authorUrl: optionalString(record.authorUrl),
        fundingUrl: optionalString(record.fundingUrl),
    };
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
