import type { LanguageSetting } from "./i18n";

/**
 * 插件设置。
 *
 * 与参考项目 obsidian-git 的做法一致：**敏感项不进这里**。
 * 访问令牌存在 `core/secretStore`（SecretStorage 或 localStorage），
 * 这样 `data.json` 可以安全地随仓库同步到多设备而令牌不跟着走。
 */

export const SETTINGS_VERSION = 1;

export interface InstallerSettings {
    enabled: boolean;
    /** 启动后是否自动检查已跟踪插件的更新。 */
    autoCheckOnStartup: boolean;
    /** 启动检查的延迟秒数 —— 避开 Obsidian 自身的启动流程。 */
    autoCheckDelaySeconds: number;
    /** 安装 GitHub 插件时是否优先探测 Gitee 镜像。 */
    discoverGiteeMirrors: boolean;
}

export interface SyncSettings {
    enabled: boolean;
    /** 自动提交间隔（分钟）。0 表示关闭。 */
    autoCommitMinutes: number;
    autoPushMinutes: number;
    autoPullMinutes: number;
    commitMessage: string;
    /** git 可执行文件路径。空表示用 PATH 里的 git。 */
    gitPath: string;
}

export interface ObsyncSettings {
    version: number;
    language: LanguageSetting;
    showNotices: boolean;
    debugLogging: boolean;
    installer: InstallerSettings;
    sync: SyncSettings;
}

export const DEFAULT_SETTINGS: ObsyncSettings = {
    version: SETTINGS_VERSION,
    language: "auto",
    showNotices: true,
    debugLogging: false,
    installer: {
        enabled: true,
        autoCheckOnStartup: true,
        autoCheckDelaySeconds: 60,
        discoverGiteeMirrors: true,
    },
    sync: {
        enabled: true,
        autoCommitMinutes: 0,
        autoPushMinutes: 0,
        autoPullMinutes: 0,
        commitMessage: "vault backup: {{date}}",
        gitPath: "",
    },
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        Object.getPrototypeOf(value) === Object.prototype
    );
}

/**
 * 用默认值补全缺失字段。
 *
 * 参考项目 obsidian-git 的做法是「浅合并 + 对个别嵌套对象深合并」，
 * 结果是每加一个嵌套设置就要手动补一行。这里改成通用递归合并 ——
 * 新增设置项时不需要动任何迁移代码。
 */
function mergeWithDefaults<T extends Record<string, unknown>>(
    defaults: T,
    loaded: unknown
): T {
    if (!isPlainObject(loaded)) return { ...defaults };

    const result = { ...defaults } as Record<string, unknown>;
    for (const [key, defaultValue] of Object.entries(defaults)) {
        const loadedValue = loaded[key];
        if (loadedValue === undefined) continue;

        if (isPlainObject(defaultValue)) {
            result[key] = mergeWithDefaults(defaultValue, loadedValue);
        } else if (typeof loadedValue === typeof defaultValue) {
            result[key] = loadedValue;
        }
        // 类型不匹配的旧值直接丢弃，回退到默认值。
        // 静默接受错误类型会在后面引发难以定位的问题。
    }
    return result as T;
}

/** 把磁盘上读到的原始数据变成一份完整、可信的设置对象。 */
export function normalizeSettings(loaded: unknown): ObsyncSettings {
    const merged = mergeWithDefaults(
        DEFAULT_SETTINGS as unknown as Record<string, unknown>,
        loaded
    ) as unknown as ObsyncSettings;

    merged.version = SETTINGS_VERSION;

    // 数值范围钳制 —— data.json 是用户可以手改的。
    merged.installer.autoCheckDelaySeconds = clamp(
        merged.installer.autoCheckDelaySeconds,
        0,
        3600
    );
    merged.sync.autoCommitMinutes = clamp(merged.sync.autoCommitMinutes, 0, 24 * 60);
    merged.sync.autoPushMinutes = clamp(merged.sync.autoPushMinutes, 0, 24 * 60);
    merged.sync.autoPullMinutes = clamp(merged.sync.autoPullMinutes, 0, 24 * 60);

    return merged;
}

function clamp(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min;
    return Math.min(max, Math.max(min, Math.round(value)));
}
