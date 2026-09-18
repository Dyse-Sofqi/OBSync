import { isSameRepo } from "../host/repoRef";
import { SUPPORTED_HOSTS, type HostKind, type RepoRef } from "../host/types";
import {
    TRACKED_KINDS,
    itemRepoRef,
    type InstallChannel,
    type TrackedItem,
    type TrackedKind,
} from "../features/installer/types";
import type { LanguageSetting } from "./i18n";
import { isValidPluginId } from "./pluginId";
import { isValidThemeName } from "./themeName";

/**
 * 插件设置。
 *
 * 与参考项目 obsidian-git 的做法一致：**敏感项不进这里**。
 * 访问令牌存在 `core/secretStore`（SecretStorage 或 localStorage），
 * 这样 `data.json` 可以安全地随仓库同步到多设备而令牌不跟着走。
 */

export const SETTINGS_VERSION = 3;

export interface InstallerSettings {
    enabled: boolean;
    /**
     * 启动后是否自动检查已跟踪插件的更新。**默认关闭**（v2 起）——
     * 由「进入设置页时自动检查」承接，后者时机更准（用户正在看列表）。
     */
    autoCheckOnStartup: boolean;
    /** 启动检查的延迟秒数 —— 避开 Obsidian 自身的启动流程。 */
    autoCheckDelaySeconds: number;
    /** 打开 OBSync 设置页时自动检查更新。默认开启。 */
    autoCheckOnSettingsOpen: boolean;
    /** 安装 GitHub 插件时是否优先探测 Gitee 镜像。 */
    discoverGiteeMirrors: boolean;
    /**
     * 上次成功跑完一轮更新检查的时间戳（毫秒）。
     *
     * 给「进入设置页自动检查」做节流：设置页的重绘很频繁，
     * 没有它会在反复开合设置页时把 API 配额打光（Gitee 匿名配额尤其紧张）。
     */
    lastUpdateCheckAt: number;
    /**
     * 上次把 OBSync 自己更新到了哪个版本、但还没重启（空串 = 没有待重启的更新）。
     *
     * OBSync **不重载自己**：对普通插件是 disable → enable，对自己则是先卸载正在
     * 执行这段代码的实例（剩下半段靠闭包才活着）—— 能成也是靠副作用成功，
     * 失败就停在「已禁用」。所以更新只写文件，由用户重启完成剩下的事，
     * 而这段时间磁盘上的版本比运行中的代码新，这个字段就是唯一的凭据：
     * 设置页据此常驻提示，**每次加载时清空**（加载成功即代表跑的就是磁盘那份）。
     *
     * 用字符串而不是 `{ version, at }` 对象：`mergeWithDefaults` 对「默认值为
     * undefined 的对象字段」无法透传（类型对不上就回落默认值），而这里并不需要
     * 时间戳 —— 加载即清除，没有过期判断要做。
     */
    pendingRestartVersion: string;
    /**
     * 已跟踪的插件与主题（同一个列表，靠 `kind` 判别）。
     *
     * 类型定义在 `features/installer/types.ts`（那里才是它的业务归属），
     * 这里是 type-only 引入 —— 设置模块负责的是「持久化什么形状」，
     * 不必也不该把业务类型复制一份。
     */
    tracked: TrackedItem[];
    /**
     * 最近一次更新检查发现的可更新项，键为 `availableUpdateKey()` 的结果
     * （`<kind>:<id>`，见那里的注释）。
     *
     * 持久化而不是只存内存：徽标要常驻在已跟踪列表里（Notice 一闪就错过），
     * 且启动时的自动检查也能写入。更新成功后由 recordInstalled 清除。
     */
    availableUpdates: Record<string, { latestVersion: string; checkedAt: number }>;
    /**
     * **待用户确认**的疑似 Gitee 镜像（键同 `availableUpdates`：`<kind>:<id>`）。
     *
     * 镜像发现**从不自动采用**一个镜像：它只把「疑似镜像」记在这里，由用户在界面上
     * 确认（`InstallerService.confirmMirror`）之后才改写记录、把下载与更新检查切过去。
     *
     * 为什么值得多这一层：判据只是「两边 manifest 的 `id` 相同」，那只证明**是同一个
     * 插件**，不证明是同一份代码、同一个作者、同一个新鲜度 —— fork、或者别人用同一个
     * `id` 重新上传都能通过，而插件是能读写整个库的代码。地址又常常来自「猜 owner」，
     * 所以这一步必须由人拍板。
     */
    mirrorSuggestions: Record<string, RepoRef>;
}

export interface SyncSettings {
    /**
     * 总开关。**由 `SyncModule` 的装配读走**（注入 `Automatics`），
     * 关掉后后台自动动作全部停表。
     *
     * 这一行是给下一个人的提醒：这个字段曾经**只被写、从没被读过** ——
     * 设置页有开关、`data.json` 里存着值、README 也列着它，但代码里没有
     * 任何一处读它，于是「关掉同步」之后自动提交照样每 N 分钟把笔记推到远端。
     * 加字段时顺手确认一下有没有读取方（`installer.enabled` 是正例）。
     *
     * 边界：只管后台自动动作，不管命令面板里的显式命令（与 `installer.enabled`
     * 同一个边界 —— 那一份管的是「启动时自动检查」，手动入口始终可用）。
     */
    enabled: boolean;
    /**
     * 自动提交**并同步**间隔（分钟）。0 表示关闭。
     *
     * 名字里的「并同步」是有信息量的：到点执行的是完整链路
     * `提交 → 拉取 → 推送`，而不是只提交。所以 `autoPushMinutes` /
     * `autoPullMinutes` 设为 0 **不会**阻止推送与拉取 —— 它们只是
     * 在此之上额外多加的定时器。
     */
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
        // v2 起默认关闭：把「检查」放在用户真正在看列表的时刻（进入设置页），
        // 而不是每次启动都无条件打一遍各平台的 API。
        autoCheckOnStartup: false,
        autoCheckDelaySeconds: 60,
        autoCheckOnSettingsOpen: true,
        // 默认关闭。实测抽样 40 个社区插件，Gitee 上同 owner 同名的镜像命中 0 个 ——
        // 这个功能服务的是「用户知道某插件有镜像」的少数场景，不是普遍优化，
        // 而每次探测都要花掉 Gitee 稀缺的配额。详见 features/installer/mirrorFinder.ts。
        discoverGiteeMirrors: false,
        lastUpdateCheckAt: 0,
        pendingRestartVersion: "",
        tracked: [],
        availableUpdates: {},
        mirrorSuggestions: {},
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

/** 读磁盘数据里的设置版本号；缺失或非法时当作 0（最老的形态）。 */
function readVersion(loaded: unknown): number {
    if (!isPlainObject(loaded)) return 0;
    const version = loaded.version;
    return typeof version === "number" && Number.isFinite(version) ? version : 0;
}

/**
 * 深拷贝一份默认值。
 *
 * **必须有这一步**：`mergeWithDefaults` 返回的是 `{ ...defaults }` 浅拷贝，
 * 嵌套对象仍是 `DEFAULT_SETTINGS` 里那两个引用。早先的写法在「磁盘数据里缺这个
 * 键」时直接把默认值本身放进结果，于是运行时的写入 —— `installer.tracked.push()`、
 * 拨一个同步开关 —— 会**就地改写模块级的 DEFAULT_SETTINGS**。
 *
 * 症状很隐蔽：此后每次 `normalizeSettings`（重载设置、读第二遍）都从一份脏的
 * 默认值开始，于是「这次会话里加过的跟踪条目」会在一个全新库（没有 data.json）
 * 里凭空出现。测试里表现为跨用例污染，生产里表现为「删掉的条目又回来了」。
 */
function cloneDefault<T>(value: T): T {
    if (Array.isArray(value)) return [...value] as unknown as T;
    if (isPlainObject(value)) {
        const copy: Record<string, unknown> = {};
        for (const [key, nested] of Object.entries(value)) copy[key] = cloneDefault(nested);
        return copy as T;
    }
    return value;
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
    if (!isPlainObject(loaded)) return cloneDefault(defaults);

    const result = { ...defaults } as Record<string, unknown>;
    for (const [key, defaultValue] of Object.entries(defaults)) {
        const loadedValue = loaded[key];
        if (loadedValue === undefined) {
            // 缺这个键 —— 连默认值也要拷贝一份，理由见 cloneDefault。
            result[key] = cloneDefault(defaultValue);
            continue;
        }

        if (isPlainObject(defaultValue)) {
            // 空对象默认值是「映射表」（如 installer.availableUpdates）——
            // 形状由数据决定，必须整体透传给下游校验，否则遍历 defaults 的键
            // 会把整张表丢掉。校验仍由专门的 sanitize 函数负责。
            result[key] =
                Object.keys(defaultValue).length === 0
                    ? (isPlainObject(loadedValue) ? { ...loadedValue } : cloneDefault(defaultValue))
                    : mergeWithDefaults(defaultValue, loadedValue);
        } else if (typeof loadedValue === typeof defaultValue) {
            result[key] = loadedValue;
        } else {
            // 类型不匹配的旧值直接丢弃，回退到默认值。
            // 静默接受错误类型会在后面引发难以定位的问题。
            result[key] = cloneDefault(defaultValue);
        }
    }
    return result as T;
}

/** 把磁盘上读到的原始数据变成一份完整、可信的设置对象。 */
export function normalizeSettings(loaded: unknown): ObsyncSettings {
    // 迁移判断要在覆盖 version 之前取原始值。
    const loadedVersion = readVersion(loaded);

    const merged = mergeWithDefaults(
        DEFAULT_SETTINGS as unknown as Record<string, unknown>,
        loaded
    ) as unknown as ObsyncSettings;

    merged.version = SETTINGS_VERSION;

    // v1 → v2：启动检查改为默认关闭，由「进入设置页自动检查」承接。
    // 老 data.json 里往往已经持久化了旧的默认 true（用户从没动过这个开关），
    // 不纠正的话新默认形同虚设 —— 所以这里对 v1 数据一并置为 false。
    // 用户之后手动打开不会再被改回。
    if (loadedVersion < 2) {
        merged.installer.autoCheckOnStartup = false;
    }

    // v2 → v3：启用主题支持。必须在 sanitize 之前 —— 见 migrateV2ToV3。
    if (loadedVersion < 3) {
        migrateV2ToV3(merged.installer);
    }

    // 数值范围钳制 —— data.json 是用户可以手改的。
    merged.installer.autoCheckDelaySeconds = clamp(
        merged.installer.autoCheckDelaySeconds,
        0,
        3600
    );
    if (!Number.isFinite(merged.installer.lastUpdateCheckAt) || merged.installer.lastUpdateCheckAt < 0) {
        merged.installer.lastUpdateCheckAt = 0;
    }
    if (typeof merged.installer.pendingRestartVersion !== "string") {
        merged.installer.pendingRestartVersion = "";
    }
    merged.sync.autoCommitMinutes = clamp(merged.sync.autoCommitMinutes, 0, 24 * 60);
    merged.sync.autoPushMinutes = clamp(merged.sync.autoPushMinutes, 0, 24 * 60);
    merged.sync.autoPullMinutes = clamp(merged.sync.autoPullMinutes, 0, 24 * 60);

    if (!["merge", "rebase", "reset"].includes(merged.sync.syncStrategy)) {
        merged.sync.syncStrategy = "merge";
    }

    // 数组不能靠递归合并校验 —— 它会被整体替换，条目内容没人检查过。
    merged.installer.tracked = sanitizeTrackedItems(merged.installer.tracked);

    // 可更新记录同理：逐条校验，并剪掉已不在跟踪列表里的条目。
    merged.installer.availableUpdates = sanitizeAvailableUpdates(
        merged.installer.availableUpdates,
        merged.installer.tracked
    );

    // 待确认的镜像提议同上一行：值要逐条校验（`data.json` 可以手改），
    // 键也要剪掉已不跟踪的条目（否则列表里会留下一条没有对应行的提议）。
    merged.installer.mirrorSuggestions = sanitizeMirrorSuggestions(
        merged.installer.mirrorSuggestions,
        merged.installer.tracked
    );

    return merged;
}

/**
 * 从 `SUPPORTED_HOSTS` 派生 —— **不要**在这里再列一遍平台名。
 *
 * 这份名单决定 `data.json` 里哪些跟踪条目能活下来：漏掉一个平台的后果是
 * 用户在**那个平台**上装的插件下次加载时被当成非法条目**无声丢弃**
 * （不是报错，是列表里就没了）。它和「有哪些平台」本来就是同一个事实。
 */
const VALID_HOSTS = new Set<string>(SUPPORTED_HOSTS);
const VALID_CHANNELS = new Set(["release", "raw"]);

/**
 * 从 `TRACKED_KINDS` 派生 —— **不要**在这里再列一遍种类。
 *
 * 与平台名单同理：漏掉一个 kind 的后果是用户在**那种对象**上的跟踪记录
 * 下次加载时被当成非法条目**无声丢弃**（不报错，列表里就没了）。
 */
const VALID_KINDS = new Set<string>(TRACKED_KINDS);

/**
 * 身份键：`<kind>:<id>`。更新记录（`availableUpdates`）与各处去重都用它。
 *
 * **必须带 kind 前缀**：插件 id 与主题目录名是两个独立的命名空间，而
 * `availableUpdates` 是一张表。不带前缀的话，一个 id 为 `minimal` 的插件与一个
 * 目录名为 `minimal` 的主题会共用一条记录 —— 更新完其中一个清掉徽标，
 * 另一个的徽标跟着消失，且没人看得出为什么。
 *
 * **主题的 id 归一成小写**：主题的身份是目录名，而 macOS / Windows 的文件系统
 * 不区分大小写 —— `resolveThemeFolder` / `listInstalledThemes` / `getActiveTheme`
 * 都按这个口径办，身份键也必须跟上。不归一的话同一个主题能存在两条记录：它们
 * 指向**同一个目录**（更新其中一个等于更新两个），却各有一个徽标，
 * 列表上就是两行一模一样的主题，用户分不出哪行是真的。
 *
 * 插件侧**不**归一：`manifest.id` 有 `/^[a-z0-9-]+$/` 的校验，本来就不可能出现大写。
 */
export function availableUpdateKey(item: { kind: TrackedKind; id: string }): string {
    const id = item.kind === "theme" ? item.id.toLowerCase() : item.id;
    return `${item.kind}:${id}`;
}

/**
 * v2 → v3：引入主题支持。
 *
 * 三件事：
 * 1. 老条目补上 `kind: "plugin"` —— v2 的列表里只可能有插件；
 * 2. 把 v2 的 `pluginId` 字段改名为 `id`（判别联合里两种 kind 用同一个名字，
 *    见 `TrackedBase.id`）。**漏了这一条 `data.json` 会被清空**：迁移之后
 *    sanitize 按 `id` 取值，拿不到就按「结构不完整」把每一条都丢掉，
 *    用户的跟踪列表会在一轮重启后无声消失；
 * 3. `availableUpdates` 的键从裸 `id` 换成 `<kind>:<id>`（见 availableUpdateKey）。
 *
 * 必须在 sanitize **之前**做，而不是让 sanitize 兼容两种形状：那样会把
 * 「版本较老」和「格式非法」混成同一件事，而这两者要采取的行动完全不同
 * （前者该迁移，后者该丢弃）。
 */
function migrateV2ToV3(installer: InstallerSettings): void {
    for (const entry of installer.tracked as unknown[]) {
        if (!isPlainObject(entry)) continue;

        if (entry.kind === undefined) entry.kind = "plugin";

        if (entry.id === undefined && typeof entry.pluginId === "string") {
            entry.id = entry.pluginId;
            delete entry.pluginId;
        }
    }

    const legacy = installer.availableUpdates;
    const upgraded: InstallerSettings["availableUpdates"] = {};
    for (const [key, value] of Object.entries(legacy)) {
        // 已经带前缀的键原样保留。正常情况下 v2 数据的键都是裸 id，
        // 但 `data.json` 可以手改、也会随笔记仓库同步 —— 万一版本号缺失
        // （或被人删掉）而键已经是新格式，再套一层前缀会让**所有徽标消失**，
        // 且看不出原因。
        const alreadyKeyed = TRACKED_KINDS.some((kind) => key.startsWith(`${kind}:`));
        upgraded[alreadyKeyed ? key : availableUpdateKey({ kind: "plugin", id: key })] = value;
    }
    installer.availableUpdates = upgraded;
}

/**
 * 校验已跟踪列表，丢弃结构不完整的条目。
 *
 * 这里的取舍是「宁可少一个条目，也不要一个半坏的条目」：一个缺 `id` 的记录
 * 会让移除功能删错目录，风险远大于重新添加一次。
 *
 * ## 为什么 `id` 必须查内容，不能只查「是非空字符串」
 *
 * 这个字段会成为**路径的一截**，而这条路径上仍然有**递归删除**：
 *
 * - 主题：`updateTheme()` 按 `tracked.id` 解析目录 → 写盘失败时回滚 →
 *   若目录原本不存在就 `rmdir(folder, true)` **递归**删掉它；
 * - 插件：全新安装失败时同样会递归删掉刚建的目录（那条路径用的是
 *   `manifest.id`，已被 `parseManifest` 校验过）。
 *
 * 于是一个手改出来的 `"../../evil"` 会让主题那条路的删除目标跑出 `themes/`
 * （路径算术与「真的会发出这个 rmdir」的证明见 `tests/features/itemFolder.test.ts`）。
 *
 * > 注意别把「取消跟踪」算进这条理由里 —— 它**不删任何文件**（见
 * > `InstallerService.unbind`）。真正需要校验的是上面那些**写入失败后的回滚**路径。
 *
 * > 有一处**没有**验证：真机上 Obsidian 的 adapter 会不会主动拒绝越界路径。
 * > 所以要守的是「移除只碰插件 / 主题目录」这条不变量本身 —— 至于它是靠这里
 * > 拦住、还是靠 adapter 兜住，不该由我们来赌。
 *
 * 而 `data.json` 恰恰是这个字段**唯一**不经过 manifest 解析的来源 —— 它可以被手改，
 * 也会随笔记仓库同步到别的设备（包括那些设备上版本更旧的插件写出的旧格式）。
 *
 * ## 两种 kind 的判据不同，**不能**共用一个正则
 *
 * 插件 id 是作者自己定的技术标识（`/^[a-z0-9-]+$/`），而主题没有 id 字段 ——
 * 它的身份来自 manifest 的 `name`，`Minimal`、`Blue Topaz` 这种带空格与大写的
 * 名字才是常态。共用一个正则的后果是「主题一条都绑不上」。两者的完整理由分别写在
 * `core/pluginId.ts` 与 `core/themeName.ts`。
 */
function sanitizeTrackedItems(value: unknown): TrackedItem[] {
    if (!Array.isArray(value)) return [];

    const result: TrackedItem[] = [];
    const seen = new Set<string>();

    for (const entry of value) {
        if (!isPlainObject(entry)) continue;

        const { host, owner, repo, id, kind, name } = entry;
        if (typeof host !== "string" || !VALID_HOSTS.has(host)) continue;
        if (typeof owner !== "string" || !owner) continue;
        if (typeof repo !== "string" || !repo) continue;
        if (!isTrackedKind(kind)) continue;
        if (!isValidId(kind, id)) continue;

        // 同一个身份只保留第一条 —— 重复记录会让更新检查跑两遍。
        const key = availableUpdateKey({ kind, id });
        if (seen.has(key)) continue;
        seen.add(key);

        const channel =
            typeof entry.channel === "string" && VALID_CHANNELS.has(entry.channel)
                ? (entry.channel as InstallChannel)
                : undefined;

        const common = {
            host: host as HostKind,
            owner,
            repo,
            origin: sanitizeOrigin(entry.origin, { host: host as HostKind, owner, repo }),
            id,
            name: typeof name === "string" && name ? name : id,
            installedVersion:
                typeof entry.installedVersion === "string" ? entry.installedVersion : "",
            frozen: entry.frozen === true,
            installedAt:
                typeof entry.installedAt === "number" && Number.isFinite(entry.installedAt)
                    ? entry.installedAt
                    : 0,
        };

        if (kind === "plugin") {
            result.push({
                ...common,
                kind: "plugin",
                // 绑定进来的插件（v2 时代就有的路径）历史未知，沿用 release。
                // 列表只在通道为 raw 时追加来源说明，这个默认值不会造成误报。
                channel: channel ?? "release",
                requestedVersion:
                    typeof entry.requestedVersion === "string" && entry.requestedVersion
                        ? entry.requestedVersion
                        : "latest",
            });
        } else {
            // 主题：channel 允许为空（绑定进来的那批还没走过更新）。
            result.push({ ...common, kind: "theme", channel });
        }
    }

    return result;
}

function isTrackedKind(value: unknown): value is TrackedKind {
    return typeof value === "string" && VALID_KINDS.has(value);
}

/**
 * 校验条目上的 `origin`（走了 Gitee 镜像时记下的**源仓库地址**）。
 *
 * 两条规则，都不是洁癖：
 *
 * 1. **坏值只丢它自己，不丢整个条目** —— 它纯粹是展示用的补充信息，
 *    为了一个多余的地址把用户在跟的插件扔出列表，代价完全不成比例。
 * 2. **与主来源相同的值视为没写** —— 否则列表会画出两行一模一样的地址
 *    （一行「GitHub」一行「Gitee 镜像」，指的却是同一个仓库）。
 *    `data.json` 可以被手改，也会随笔记仓库同步到别的设备，所以这条得在
 *    读取时兜住，而不是只靠写入方自觉。
 */
function sanitizeOrigin(value: unknown, primary: RepoRef): RepoRef | undefined {
    if (!isPlainObject(value)) return undefined;

    const { host, owner, repo } = value;
    if (typeof host !== "string" || !VALID_HOSTS.has(host)) return undefined;
    if (typeof owner !== "string" || !owner) return undefined;
    if (typeof repo !== "string" || !repo) return undefined;

    const origin: RepoRef = { host: host as HostKind, owner, repo };
    return isSameRepo(origin, primary) ? undefined : origin;
}

/** 两种 kind 的身份判据不同 —— 理由见上面的函数注释与 `core/themeName.ts`。 */
function isValidId(kind: TrackedKind, value: unknown): value is string {
    return kind === "plugin" ? isValidPluginId(value) : isValidThemeName(value);
}

/**
 * 校验可更新记录：形状不对的丢弃，不在跟踪列表里的剪掉。
 *
 * 剪枝是关键 —— 跟踪列表是「哪些对象该有徽标」的唯一事实来源，记录里残留
 * 已移除对象的条目会在重新装上同名对象时显示过期徽标。
 */
function sanitizeAvailableUpdates(
    value: unknown,
    tracked: TrackedItem[]
): Record<string, { latestVersion: string; checkedAt: number }> {
    if (!isPlainObject(value)) return {};

    const trackedKeys = new Set(tracked.map((item) => availableUpdateKey(item)));
    const result: Record<string, { latestVersion: string; checkedAt: number }> = {};

    for (const [key, entry] of Object.entries(value)) {
        if (!trackedKeys.has(key)) continue;
        if (!isPlainObject(entry)) continue;
        if (typeof entry.latestVersion !== "string" || !entry.latestVersion) continue;
        if (typeof entry.checkedAt !== "number" || !Number.isFinite(entry.checkedAt)) continue;
        result[key] = { latestVersion: entry.latestVersion, checkedAt: entry.checkedAt };
    }

    return result;
}

/**
 * 校验「待确认的疑似镜像」记录：值逐条校验，键不在跟踪列表里的剪掉。
 *
 * 与 `sanitizeAvailableUpdates` 同一套取舍，但多一条**自洽性**检查：
 * 提议的地址不能与记录当前用的地址相同（那说明它早就被采用了，留着这条提议
 * 只会在列表上挂一句「疑似镜像」而地址和上面那行一模一样）。
 */
function sanitizeMirrorSuggestions(
    value: unknown,
    tracked: TrackedItem[]
): Record<string, RepoRef> {
    if (!isPlainObject(value)) return {};

    const primary = new Map(tracked.map((item) => [availableUpdateKey(item), itemRepoRef(item)]));
    const result: Record<string, RepoRef> = {};

    for (const [key, entry] of Object.entries(value)) {
        const current = primary.get(key);
        if (!current) continue;

        const suggestion = sanitizeOrigin(entry, current);
        // sanitizeOrigin 已经把「坏值」与「与主来源相同」两种情况都判成 undefined，
        // 正好是这里要的两条规则。
        if (suggestion) result[key] = suggestion;
    }

    return result;
}

function clamp(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min;
    return Math.min(max, Math.max(min, Math.round(value)));
}