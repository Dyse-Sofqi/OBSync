import type { TrackedPlugin } from "../features/installer/types";
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
    /**
     * 已跟踪的插件。
     *
     * 类型定义在 `features/installer/types.ts`（那里才是它的业务归属），
     * 这里是 type-only 引入 —— 设置模块负责的是「持久化什么形状」，
     * 不必也不该把业务类型复制一份。
     */
    tracked: TrackedPlugin[];
}

export interface SyncSettings {
    enabled: boolean;
    /** 自动提交间隔（分钟）。0 表示关闭。 */
    autoCommitMinutes: number;
    autoPushMinutes: number;
    autoPullMinutes: number;
    commitMessage: string;
    /** 拉取整合策略：merge（默认）/ rebase / reset（本地以远端为准）。 */
    syncStrategy: "merge" | "rebase" | "reset";
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
        // 默认关闭。实测抽样 40 个社区插件，Gitee 上同 owner 同名的镜像命中 0 个 ——
        // 这个功能服务的是「用户知道某插件有镜像」的少数场景，不是普遍优化，
        // 而每次探测都要花掉 Gitee 稀缺的配额。详见 features/installer/mirrorFinder.ts。
        discoverGiteeMirrors: false,
        tracked: [],
    },
    sync: {
        enabled: true,
        autoCommitMinutes: 0,
        autoPushMinutes: 0,
        autoPullMinutes: 0,
        commitMessage: "vault backup: {{date}}",
        // merge 是 git 的默认行为，对普通用户最不容易丢数据；
        // rebase/reset 交给明确知道自己要什么的用户。
        syncStrategy: "merge",
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

    if (!["merge", "rebase", "reset"].includes(merged.sync.syncStrategy)) {
        merged.sync.syncStrategy = "merge";
    }

    // 数组不能靠递归合并校验 —— 它会被整体替换，条目内容没人检查过。
    merged.installer.tracked = sanitizeTrackedPlugins(merged.installer.tracked);

    return merged;
}

const VALID_HOSTS = new Set(["github", "gitee"]);
const VALID_CHANNELS = new Set(["release", "raw"]);

/**
 * 校验已跟踪插件列表，丢弃结构不完整的条目。
 *
 * 这里的取舍是「宁可少一个条目，也不要一个半坏的条目」：
 * 一个缺 `pluginId` 的记录会让卸载功能删错目录，风险远大于重新添加一次。
 */
function sanitizeTrackedPlugins(value: unknown): TrackedPlugin[] {
    if (!Array.isArray(value)) return [];

    const result: TrackedPlugin[] = [];
    const seen = new Set<string>();

    for (const entry of value) {
        if (!isPlainObject(entry)) continue;

        const { host, owner, repo, pluginId, name } = entry;
        if (typeof host !== "string" || !VALID_HOSTS.has(host)) continue;
        if (typeof owner !== "string" || !owner) continue;
        if (typeof repo !== "string" || !repo) continue;
        if (typeof pluginId !== "string" || !pluginId) continue;

        // 同一个插件 id 只保留第一条 —— 重复记录会让更新检查跑两遍。
        if (seen.has(pluginId)) continue;
        seen.add(pluginId);

        const channel = typeof entry.channel === "string" && VALID_CHANNELS.has(entry.channel)
            ? (entry.channel as TrackedPlugin["channel"])
            : "release";

        result.push({
            host: host as TrackedPlugin["host"],
            owner,
            repo,
            pluginId,
            name: typeof name === "string" && name ? name : pluginId,
            installedVersion: typeof entry.installedVersion === "string" ? entry.installedVersion : "",
            requestedVersion:
                typeof entry.requestedVersion === "string" && entry.requestedVersion
                    ? entry.requestedVersion
                    : "latest",
            frozen: entry.frozen === true,
            channel,
            installedAt:
                typeof entry.installedAt === "number" && Number.isFinite(entry.installedAt)
                    ? entry.installedAt
                    : 0,
        });
    }

    return result;
}

function clamp(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min;
    return Math.min(max, Math.max(min, Math.round(value)));
}
