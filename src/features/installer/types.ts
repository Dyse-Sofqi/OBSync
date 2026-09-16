import type { HostKind } from "../../host/types";

/**
 * 安装器的领域类型。
 *
 * 与参考项目 BRAT 的一个结构差异：BRAT 用**两个平行列表**表示已跟踪插件
 * （`pluginList: string[]` + `pluginSubListFrozenVersion: PluginVersion[]`），
 * 于是每次读取都要按 repo 名在两处做关联查找，冻结状态、token 名、兼容性标记
 * 散在第二个列表里。这里改成单一对象列表 —— 没有兼容包袱要背。
 */

/** 插件文件的来源通道。 */
export type InstallChannel = "release" | "raw";

/** 一个被 OBSync 跟踪（安装过或添加过）的插件仓库。 */
export interface TrackedPlugin {
    host: HostKind;
    owner: string;
    repo: string;
    /** 插件的 manifest id，也是它在 `{configDir}/plugins/` 下的目录名。 */
    pluginId: string;
    /** 插件显示名（来自 manifest）。 */
    name: string;
    /** 实际安装的版本。 */
    installedVersion: string;
    /** 用户要求的版本：`"latest"` 或具体 tag。 */
    requestedVersion: string;
    /**
     * 冻结。冻结的插件不参与「检查更新」与「更新全部」，
     * 但可以手动重装。
     */
    frozen: boolean;
    /** 上次安装走的通道。 */
    channel: InstallChannel;
    /** 上次安装时间戳（毫秒）。 */
    installedAt: number;
}

/** Obsidian 插件的 manifest.json。 */
export interface PluginManifest {
    id: string;
    name: string;
    version: string;
    minAppVersion: string;
    description?: string;
    author?: string;
    authorUrl?: string;
    isDesktopOnly?: boolean;
}

/** 插件安装所需的三个文件。前两个必需，第三个可选。 */
export const REQUIRED_FILES = ["manifest.json", "main.js"] as const;
export const OPTIONAL_FILES = ["styles.css"] as const;
export const PLUGIN_FILES = [...REQUIRED_FILES, ...OPTIONAL_FILES] as const;

export type PluginFileName = (typeof PLUGIN_FILES)[number];

/** 一次安装的目标来源。 */
export type InstallSource =
    | {
          kind: "release";
          /** release tag。 */
          tag: string;
          /** 用于 raw 回退时的 ref。 */
          ref: string;
      }
    | {
          kind: "raw";
          /** 读取源码文件用的 ref；`HEAD` 表示默认分支。 */
          ref: string;
      };

/** 安装/更新的结果。 */
export interface InstallResult {
    manifest: PluginManifest;
    channel: InstallChannel;
    /** 实际安装的版本（manifest 里的 version）。 */
    version: string;
    /** 是否发生了替换（更新/重装）而非全新安装。 */
    replaced: boolean;
    /** 是否已启用。 */
    enabled: boolean;
    /** 是否走了 Gitee 镜像。 */
    mirror?: { host: HostKind; owner: string; repo: string };
}

/** 更新检查的结果。 */
export interface UpdateCheckResult {
    tracked: TrackedPlugin;
    /** 远端最新版本。 */
    latestVersion: string;
    hasUpdate: boolean;
    /** 检查失败时的原因。 */
    error?: string;
}
