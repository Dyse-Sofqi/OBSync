import type { HostKind, RepoRef } from "../../host/types";

/**
 * 安装器的领域类型。
 *
 * 与参考项目 BRAT 的一个结构差异：BRAT 用**两个平行列表**表示已跟踪插件
 * （`pluginList: string[]` + `pluginSubListFrozenVersion: PluginVersion[]`），
 * 于是每次读取都要按 repo 名在两处做关联查找，冻结状态、token 名、兼容性标记
 * 散在第二个列表里。这里改成单一对象列表 —— 没有兼容包袱要背。
 *
 * ## 为什么插件与主题是判别联合，而不是一个带 `kind` 字段的宽接口
 *
 * 两者的差异不是「几个字段留空」，而是**身份来源与生命周期都不同**：插件的身份
 * 来自 `manifest.id`（目录名可能与它错位），主题没有 id、身份就是目录名；插件装完
 * 要 enable / reload，主题没有「启用」，只有「当前用的是哪个」。用宽接口容纳两者，
 * 每个使用点都得先假设字段存在；用判别联合 + `switch` 的穷尽检查，漏掉一个分支会
 * **编译不过** —— 与 `InstallerErrorDetail` 是同一个理由。
 */

/** 文件的来源通道。 */
export type InstallChannel = "release" | "raw";

/**
 * 被跟踪对象的种类。
 *
 * 这里给出**运行时**的一份，`TrackedKind` 由它推导：`data.json` 的校验需要一份
 * 可遍历的名单（哪些 kind 合法），而漏掉一个 kind 的后果是用户在那种对象上的
 * 记录被无声丢弃 —— 与 `SUPPORTED_HOSTS` 是同一类风险，所以同样只留一处。
 */
export const TRACKED_KINDS = ["plugin", "theme"] as const;
export type TrackedKind = (typeof TRACKED_KINDS)[number];

/** 两种被跟踪对象共有的部分。 */
interface TrackedBase {
    kind: TrackedKind;
    /**
     * **实际使用**的来源平台 —— 命中 Gitee 镜像时这里就是 Gitee。
     *
     * 下载、更新检查、重装全部按它走（镜像的价值就在于它们都改道），
     * 所以「这个插件的家在哪」不在这里，而在下面的 `origin`。
     */
    host: HostKind;
    owner: string;
    repo: string;
    /**
     * 用户当初填的地址（源仓库）—— **只有走了镜像时才有**。
     *
     * 为什么需要它：`host/owner/repo` 只有一个位置，镜像命中后就被镜像占了，
     * 源地址随即从记录里消失。那意味着用户装完之后既看不到插件的家在哪，
     * 也无从判断「SyncHub 到底在跟谁说话」—— 列表要把两个地址都摆出来，
     * 就得有人记着另一个。
     *
     * 用户直接填 Gitee 地址时它是 `undefined`：那没有第二个地址可展示。
     * 与主来源相同的值也会被 `normalizeSettings` 剪掉（记冗余只会多出一行
     * 一模一样的地址）。
     */
    origin?: RepoRef;
    /**
     * 身份，也是磁盘上的目录名。
     *
     * - 插件：`manifest.id`。目录名**不保证**等于它（实测本机 32 个插件里 5 个
     *   错位：`MDRazor/` → `md-razor`），所以插件得扫目录才能定位，见
     *   `itemFolder.resolveItemFolder`。
     * - 主题：**主题没有 id 字段**，`themes/` 下的目录名就是身份。
     *
     * 两者统一叫 `id` 是刻意的：它在这里被当作「同一个东西的同一件事」使用
     * （更新记录的主键、查找、去重）。拆成两个名字就得在每个使用点分叉。
     */
    id: string;
    /** 显示名：manifest 的 `name`，缺失时回落目录名。 */
    name: string;
    /** 本地已安装的版本。主题拿不到 manifest 时为空串，表示「未知」。 */
    installedVersion: string;
    /**
     * 冻结。冻结的条目不参与「检查更新」与「更新全部」，
     * 但可以手动重装。
     */
    frozen: boolean;
    /**
     * 上次取文件走的通道。**绑定进来的主题为 undefined**（历史未知）——
     * 第一次更新后才有值。不编造一个没发生过的「release」说法：
     * 列表会据此显示「来源：仓库源码文件」。
     */
    channel?: InstallChannel;
    /** 上次安装/更新/绑定的时间戳（毫秒）。 */
    installedAt: number;
}

/** 一个被 SyncHub 跟踪的插件仓库。 */
export interface TrackedPlugin extends TrackedBase {
    kind: "plugin";
    /** 用户要求的版本：`"latest"` 或具体 tag。主题没有版本钉选，故只有插件有。 */
    requestedVersion: string;
}

/** 一个被 SyncHub 跟踪的主题仓库。 */
export interface TrackedTheme extends TrackedBase {
    kind: "theme";
}

export type TrackedItem = TrackedPlugin | TrackedTheme;

/**
 * 条目**实际使用**的来源（`host/owner/repo`），即下载与更新检查走的那一个。
 *
 * 抽出来是因为它有两个容易写歪的地方：手写 `{host: item.host, ...}` 会在各处
 * 重复（检查、重装、打开仓库各一份），而一旦有人「顺手」改成 `origin`
 * （读起来更像「来源」），下载和检查就会分叉到两个平台 ——
 * 那正是这个项目记过的「检查与安装必须同源」那条不变式。
 * 要拿「用户填的地址」请显式读 `item.origin`。
 */
export function itemRepoRef(item: TrackedItem): RepoRef {
    return { host: item.host, owner: item.owner, repo: item.repo };
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

/**
 * Obsidian 主题的 manifest.json。
 *
 * 与插件 manifest 的差异都是**实测**出来的（kepano/obsidian-minimal 9.1.0、
 * colineckert/obsidian-things 2.2.4、AnubisNekhet/AnuPpuccin 1.5.0 三份真实
 * manifest 都是这个形状）：
 *
 * - **没有 `id`** —— 主题身份是目录名，见 `TrackedBase.id`；
 * - `minAppVersion` 常见但不是规范要求（插件侧是必需字段），故可选；
 * - 没有 `description` / `isDesktopOnly`，多一个 `fundingUrl`。
 *
 * 注意 `name` 在这里**只用于显示**：远端 manifest 的 name 不参与路径构造
 * （主题的目录名以本地已装的那个为准），所以它没有 `manifestBadId` 那样的
 * 格式校验 —— 更新一个名字古怪的主题不该被拦住。
 */
export interface ThemeManifest {
    name: string;
    version: string;
    minAppVersion?: string;
    author?: string;
    authorUrl?: string;
    fundingUrl?: string;
}

/** manifest 的文件名。两种对象都用它，不属于可配置项。 */
export const MANIFEST_FILE = "manifest.json";

export type PluginFileName = "manifest.json" | "main.js" | "styles.css";
export type ThemeFileName = "manifest.json" | "theme.css";
export type ItemFileName = PluginFileName | ThemeFileName;

/** 一种对象要取哪些文件。`all` 的顺序就是取文件的顺序。 */
export interface FileSet<N extends string> {
    /** 缺一个就安装失败。 */
    readonly required: readonly N[];
    /** 取不到就静默跳过（含网络错误）。 */
    readonly optional: readonly N[];
    readonly all: readonly N[];
}

/**
 * 每种对象的文件清单 —— 整条取文件链路（资产通道 / 源码回退 / 备份 / 写盘）
 * 都从这里取，而不是各自硬编码。
 *
 * 主题的必需文件是 `manifest.json` + `theme.css`，**没有 `main.js`**
 * （那是插件代码入口）；反过来主题也不会 grep 到 `styles.css`。
 */
export const FILE_SETS = {
    plugin: {
        required: ["manifest.json", "main.js"],
        optional: ["styles.css"],
        all: ["manifest.json", "main.js", "styles.css"],
    },
    theme: {
        required: ["manifest.json", "theme.css"],
        optional: [],
        all: ["manifest.json", "theme.css"],
    },
} as const satisfies Record<TrackedKind, FileSet<ItemFileName>>;

/** 每种对象在 `configDir` 下的子目录。 */
export const SUBDIR = {
    plugin: "plugins",
    theme: "themes",
} as const satisfies Record<TrackedKind, string>;

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
    /**
     * 这次**实际**下载用的地址（命中镜像时就是镜像）。
     *
     * 与下面的 `origin` 成对：`origin` 说用户填的那个家在哪，这个说东西真正从哪来。
     * 完成提示要报的是**这个** —— 用户问「到底走没走镜像」时，答案在这里，
     * 而且它可能与跟踪记录里的 `host` 不同（更新时才发现镜像）。
     */
    repoRef: RepoRef;
    /**
     * 走了 Gitee 镜像时的**源仓库地址**（没走镜像就是 `undefined`）。
     * 与 `TrackedItem.origin` 是同一件事。
     */
    origin?: RepoRef;
    /**
     * **疑似镜像**：通过了 manifest `id` 校验、但**没有被采用**的候选
     * （采用与否由用户确认，见 `InstallerService.confirmMirror`）。
     *
     * 调用方拿它提示「发现疑似镜像，去列表里确认」，不要自己切过去。
     */
    mirror?: RepoRef;
}

/** 主题更新的结果。 */
export interface ThemeUpdateResult {
    manifest: ThemeManifest;
    channel: InstallChannel;
    version: string;
    /** 是否发生了替换（更新/重装）而非第一次写入。 */
    replaced: boolean;
    /**
     * 这个主题是否正是当前正在使用的主题。
     *
     * `true` 表示写盘后触发了主题重载 —— 否则用户会看到「更新成功」但页面
     * 观感没变（Obsidian 自己不会去读被替换掉的 CSS）。
     */
    wasActive: boolean;
    /** 这次实际下载用的地址。主题不走镜像发现，所以它等于跟踪记录里那个地址。 */
    repoRef: RepoRef;
    /** 走了镜像时的源地址（用户在确认弹窗里选了镜像之后才会有）。 */
    origin?: RepoRef;
    /** **疑似镜像**（通过了主题的判据但没被采用）—— 由用户确认，见 `ResolvedRepo.mirror`。 */
    mirror?: RepoRef;
}

/** 更新检查的结果。 */
export interface UpdateCheckResult {
    tracked: TrackedItem;
    /** 远端最新版本。 */
    latestVersion: string;
    hasUpdate: boolean;
    /** 检查失败时的原因。 */
    error?: string;
}

/**
 * 「SyncHub 自身」的更新检查结果。
 *
 * 单独一个类型而不是复用 `UpdateCheckResult`：后者带着一个 `tracked` 条目，
 * 而 SyncHub **不在跟踪列表里**（那张表是「用户装了什么」，见 `selfUpdate.ts`）。
 */
export interface SelfUpdateCheck {
    /** **运行中**的版本（插件 manifest 里那个，不是磁盘上那份）。 */
    currentVersion: string;
    /** 远端最新版本；无从比较时与 `currentVersion` 相同。 */
    latestVersion: string;
    hasUpdate: boolean;
    /** 检查失败时的原因（限流、网络…）。 */
    error?: string;
}
