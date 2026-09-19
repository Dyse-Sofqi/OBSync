import { describe, expect, it } from "vitest";
import {
    availableUpdateKey,
    DEFAULT_SETTINGS,
    SETTINGS_VERSION,
    normalizeSettings,
} from "../../src/core/settings";

describe("availableUpdateKey（身份键）", () => {
    it("带 kind 前缀 —— 插件 id 与主题目录名是两个命名空间", () => {
        expect(availableUpdateKey({ kind: "plugin", id: "minimal" })).toBe("plugin:minimal");
        expect(availableUpdateKey({ kind: "theme", id: "minimal" })).toBe("theme:minimal");
    });

    /**
     * **两边刻意不对称**，与 `pluginId.ts` / `themeName.ts` 那对判据同一个道理：
     * 主题的身份是目录名，而 macOS / Windows 的文件系统不区分大小写；
     * 插件的身份是 `manifest.id`，有 `/^[a-z0-9-]+$/` 的校验，本来就只可能是小写。
     *
     * 所以「把两边并成一个 `toLowerCase()`」看起来像简化，实际是把插件侧
     * 「id 不同就是不同的对象」这条语义也一起改掉了。这条用例把它钉住。
     */
    it("只有主题归一成小写，插件原样保留", () => {
        expect(availableUpdateKey({ kind: "theme", id: "Minimal" })).toBe("theme:minimal");
        expect(availableUpdateKey({ kind: "plugin", id: "Minimal" })).toBe("plugin:Minimal");
    });
});

describe("normalizeSettings", () => {
    it("空数据返回完整默认值", () => {
        expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
        expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
        expect(normalizeSettings("garbage")).toEqual(DEFAULT_SETTINGS);
    });

    it("保留用户已设置的值", () => {
        const settings = normalizeSettings({
            language: "zh-cn",
            debugLogging: true,
            sync: { autoCommitMinutes: 15 },
        });

        expect(settings.language).toBe("zh-cn");
        expect(settings.debugLogging).toBe(true);
        expect(settings.sync.autoCommitMinutes).toBe(15);
        // 同一层里没提到的字段要被补上，而不是整层被替换
        expect(settings.sync.commitMessage).toBe(DEFAULT_SETTINGS.sync.commitMessage);
        expect(settings.sync.gitPath).toBe("");
    });

    it("补齐新增的嵌套设置项，不需要写迁移代码", () => {
        // 模拟「旧版本 data.json 里没有 installer.autoCheckDelaySeconds」
        const settings = normalizeSettings({
            installer: { enabled: false },
        });

        expect(settings.installer.enabled).toBe(false);
        expect(settings.installer.autoCheckDelaySeconds).toBe(
            DEFAULT_SETTINGS.installer.autoCheckDelaySeconds
        );
    });

    it("丢弃类型不匹配的旧值", () => {
        const settings = normalizeSettings({
            language: 42,
            showNotices: "yes",
            installer: { enabled: "true" },
        });

        expect(settings.language).toBe(DEFAULT_SETTINGS.language);
        expect(settings.showNotices).toBe(DEFAULT_SETTINGS.showNotices);
        expect(settings.installer.enabled).toBe(DEFAULT_SETTINGS.installer.enabled);
    });

    it("旧的 data.json 里没有「状态栏占满整屏宽」时补成默认值（**保持既有观感**）", () => {
        // 这个开关是后加的：老用户的库里没有这个字段，而他们看到的一直是全宽状态栏。
        // 补成 false 会**悄悄改掉所有人的界面** —— 那不是加开关该有的行为。
        const settings = normalizeSettings({ language: "zh-cn" });

        expect(settings.statusBarFullWidth).toBe(true);
        expect(DEFAULT_SETTINGS.statusBarFullWidth).toBe(true);
    });

    it("用户关掉它之后会被保留（不会被当成非法值丢掉）", () => {
        expect(normalizeSettings({ statusBarFullWidth: false }).statusBarFullWidth).toBe(
            false
        );
    });

    it("钳制越界或非法的数值", () => {
        const settings = normalizeSettings({
            installer: { autoCheckDelaySeconds: -10 },
            sync: {
                autoCommitMinutes: 99999,
                autoPushMinutes: Number.NaN,
                autoPullMinutes: 12.7,
            },
        });

        expect(settings.installer.autoCheckDelaySeconds).toBe(0);
        expect(settings.sync.autoCommitMinutes).toBe(24 * 60);
        expect(settings.sync.autoPushMinutes).toBe(0);
        expect(settings.sync.autoPullMinutes).toBe(13);
    });

    it("返回的设置**不与 DEFAULT_SETTINGS 共享嵌套对象**（改它不会污染默认值）", () => {
        // 守的是一个很隐蔽的 bug：`mergeWithDefaults` 只做浅拷贝，
        // 「磁盘数据里缺这个键」时它直接把默认值本身放进结果 —— 于是
        // `installer.tracked.push(...)`、拨一个同步开关，都写进了模块级的
        // DEFAULT_SETTINGS。此后每次 normalizeSettings（重载、读第二遍）都从
        // 一份脏默认值开始，表现为「删掉的条目又回来了」或全新库凭空多出条目。
        const first = normalizeSettings({});
        first.installer.tracked.push({
            kind: "theme",
            host: "github",
            owner: "owner",
            repo: "repo",
            id: "Polluted",
            name: "Polluted",
            installedVersion: "1.0.0",
            frozen: false,
            installedAt: 0,
        });
        first.sync.autoCommitMinutes = 99;

        // 默认值本身没被改动
        expect(DEFAULT_SETTINGS.installer.tracked).toEqual([]);
        expect(DEFAULT_SETTINGS.sync.autoCommitMinutes).toBe(0);

        // 再读一次也看不到上一次的写入
        const second = normalizeSettings({});
        expect(second.installer.tracked).toEqual([]);
        expect(second.sync.autoCommitMinutes).toBe(0);
    });

    it("始终写入当前设置版本号", () => {
        expect(normalizeSettings({ version: 0 }).version).toBe(SETTINGS_VERSION);
    });

    it("不把数组误当成嵌套对象合并", () => {
        const settings = normalizeSettings({ language: ["zh-cn"] });
        expect(settings.language).toBe(DEFAULT_SETTINGS.language);
    });

    it("空白仓库默认不参与自动更新检查", () => {
        // v2 起的默认：启动检查关闭，改由「进入设置页自动检查」承接。
        expect(DEFAULT_SETTINGS.installer.autoCheckOnStartup).toBe(false);
        expect(DEFAULT_SETTINGS.installer.autoCheckOnSettingsOpen).toBe(true);
        expect(DEFAULT_SETTINGS.installer.lastUpdateCheckAt).toBe(0);
    });

    it("v1 → v2 迁移：把老数据里持久化的启动检查一并纠正为关闭", () => {
        // 旧的默认值是 true，用户从没动过开关也会被持久化成 true ——
        // 不纠正的话「新默认关闭」形同虚设。
        const migrated = normalizeSettings({
            version: 1,
            installer: { autoCheckOnStartup: true },
        });
        expect(migrated.installer.autoCheckOnStartup).toBe(false);
        expect(migrated.version).toBe(SETTINGS_VERSION);
    });

    it("v2 数据里的启动检查保持用户选择，不被迁移覆盖", () => {
        const kept = normalizeSettings({
            version: 2,
            installer: { autoCheckOnStartup: true },
        });
        expect(kept.installer.autoCheckOnStartup).toBe(true);
    });

    it("非法的时间戳回退为 0", () => {
        const settings = normalizeSettings({
            version: 2,
            installer: { lastUpdateCheckAt: -5 },
        });
        expect(settings.installer.lastUpdateCheckAt).toBe(0);

        const nan = normalizeSettings({
            version: 2,
            installer: { lastUpdateCheckAt: "yesterday" },
        });
        expect(nan.installer.lastUpdateCheckAt).toBe(0);
    });

    it("可更新记录：剪掉不在跟踪列表里的条目，丢弃形状不对的条目", () => {
        // 跟踪列表是「谁该有徽标」的唯一事实来源 —— 残留已移除对象的
        // 记录会在重新装上同名对象时显示过期徽标。
        //
        // 键是 `<kind>:<id>`（见 availableUpdateKey）：插件 id 与主题目录名
        // 是两个命名空间，共用一张表就必须带前缀，否则两者互相覆盖。
        const settings = normalizeSettings({
            installer: {
                tracked: [
                    {
                        kind: "plugin",
                        host: "github",
                        owner: "owner",
                        repo: "kept",
                        id: "kept",
                        name: "Kept",
                        installedVersion: "1.0.0",
                        requestedVersion: "latest",
                        frozen: false,
                        channel: "release",
                        installedAt: 0,
                    },
                ],
                availableUpdates: {
                    "plugin:kept": { latestVersion: "v2.0.0", checkedAt: 42 },
                    "plugin:removed": { latestVersion: "v3.0.0", checkedAt: 42 },
                    "theme:kept": { latestVersion: "v9.0.0", checkedAt: 42 },
                    malformed: { latestVersion: 123, checkedAt: "yesterday" },
                },
            },
        });

        expect(settings.installer.availableUpdates).toEqual({
            "plugin:kept": { latestVersion: "v2.0.0", checkedAt: 42 },
        });
    });

    it("v2 → v3 迁移：老条目补上 kind: plugin，并给更新记录换上新键", () => {
        // v2 的列表里只可能有插件 —— 迁移必须补 kind，否则 sanitize 会把
        // 用户装过的每一个插件都当成非法条目丢掉。
        const migrated = normalizeSettings({
            version: 2,
            installer: {
                tracked: [
                    {
                        host: "github",
                        owner: "owner",
                        repo: "repo",
                        pluginId: "demo",
                        name: "Demo",
                        installedVersion: "1.0.0",
                        requestedVersion: "latest",
                        frozen: true,
                        channel: "raw",
                        installedAt: 7,
                    },
                ],
                availableUpdates: {
                    demo: { latestVersion: "2.0.0", checkedAt: 42 },
                },
            },
        });

        expect(migrated.version).toBe(SETTINGS_VERSION);
        expect(migrated.installer.tracked).toEqual([
            {
                kind: "plugin",
                host: "github",
                owner: "owner",
                repo: "repo",
                id: "demo",
                name: "Demo",
                installedVersion: "1.0.0",
                requestedVersion: "latest",
                frozen: true,
                channel: "raw",
                installedAt: 7,
            },
        ]);
        // 旧键 `demo` 要变成 `plugin:demo`，否则徽标数据会被剪掉
        expect(migrated.installer.availableUpdates).toEqual({
            "plugin:demo": { latestVersion: "2.0.0", checkedAt: 42 },
        });
    });

    it("v2 → v3 迁移不碰 v3 数据（不会给主题补上 kind: plugin）", () => {
        const kept = normalizeSettings({
            version: 3,
            installer: {
                tracked: [
                    {
                        kind: "theme",
                        host: "github",
                        owner: "kepano",
                        repo: "obsidian-minimal",
                        id: "Minimal",
                        name: "Minimal",
                        installedVersion: "9.1.0",
                        frozen: false,
                        installedAt: 1,
                    },
                ],
            },
        });

        expect(kept.installer.tracked).toEqual([
            {
                kind: "theme",
                host: "github",
                owner: "kepano",
                repo: "obsidian-minimal",
                id: "Minimal",
                name: "Minimal",
                installedVersion: "9.1.0",
                frozen: false,
                channel: undefined,
                installedAt: 1,
            },
        ]);
    });

    /**
     * `id` 的**内容**必须校验，不能只校验「是不是非空字符串」。
     *
     * 理由不是洁癖：`manifest.ts` 对同一个字段有严格校验，注释写着
     * 「id 会被用作目录名，非法字符会造成路径问题，必须在写入前拦下」。
     * 而 `data.json` 是**可以手改、也会随笔记仓库同步到多设备**的东西 ——
     * 它是这个字段唯一不经过 manifest 解析的来源。
     *
     * 下游拿它干什么：移除时按 id 定位目录，找不到就回落到
     * `{configDir}/{plugins|themes}/{id}`，然后 `rmdir(folder, true)` **递归**删 ——
     * 路径算术与「真的会发出这个调用」在 `tests/features/itemFolder.test.ts` 里实测过。
     *
     * ## 两种 kind 的判据不同，所以分两组
     *
     * 插件 id 是作者定的技术标识（`/^[a-z0-9-]+$/`），主题名是给用户看的名词
     * （`Minimal`、`Blue Topaz`）。判据共用的后果不是「严一点」而是
     * **主题一条都活不下来**，且不会有任何提示。
     */
    describe("tracked 里的 id 内容校验（插件）", () => {
        function trackedWith(id: string) {
            return {
                installer: {
                    tracked: [
                        {
                            kind: "plugin",
                            host: "github",
                            owner: "owner",
                            repo: "repo",
                            id,
                            name: "X",
                        },
                    ],
                },
            };
        }

        /**
         * 这组会**逃出 `plugins/`** —— 路径算术在
         * `tests/features/itemFolder.test.ts` 里用 `resolvePluginFolder` +
         * `removeItemFolder` 实测过（含「真的会发出递归删除调用」一条）。
         */
        it.each([
            ["..", "上跳一级 → .obsidian 本身"],
            ["../..", "上跳两级 → 库根目录"],
            ["../../evil", "上跳后进别的目录 → 库根下的 evil"],
        ])("丢弃 %s 的条目（%s）", (id) => {
            const settings = normalizeSettings(trackedWith(id));
            expect(settings.installer.tracked).toEqual([]);
        });

        /**
         * 这组**不会**逃出 `plugins/` —— 别把它们和上面那组混为一谈。
         * 但同样要丢：这些值都不可能是真 manifest 的 id（那必须先过
         * `/^[a-z0-9-]+$/`），留着只会让移除/更新去操作一个错的目录。
         *
         * 顺带记两个容易被想当然的点（都实算过）：
         * - `/abs` 的**前导斜杠会被 `normalizePath` 吃掉**，结果落在
         *   `plugins/abs`，不是绝对路径 —— 所以它不逃逸；
         * - `a\b` 的反斜杠会被换成 `/`，与 `a/b` 等价。
         */
        it.each([
            ["a/b", "注入子目录（归一后仍在 plugins/ 内）"],
            ["a\\b", "反斜杠归一成斜杠，同 a/b"],
            ["/abs", "前导斜杠被吃掉 → plugins/abs"],
            ["has space", "含空格"],
            ["UPPER", "含大写"],
            ["dot.name", "含点"],
        ])("丢弃 %s 的条目（不是合法 id：%s）", (id) => {
            const settings = normalizeSettings(trackedWith(id));
            expect(settings.installer.tracked).toEqual([]);
        });

        it("合法的 id 一个都不能丢", () => {
            // 这条是上面那组的安全网：收紧校验时最容易连合法值一起误伤，
            // 而那些 id 会带着用户的跟踪列表一起消失。
            const valid = ["demo", "obsidian-git", "my-plugin-2", "a", "9", "x-1-2"];
            for (const id of valid) {
                const settings = normalizeSettings(trackedWith(id));
                expect(settings.installer.tracked.map((item) => item.id)).toEqual([id]);
            }
        });
    });

    describe("tracked 里的 id 内容校验（主题）", () => {
        function trackedWith(id: string) {
            return {
                installer: {
                    tracked: [
                        {
                            kind: "theme",
                            host: "github",
                            owner: "owner",
                            repo: "repo",
                            id,
                            name: "X",
                        },
                    ],
                },
            };
        }

        it.each([
            ["..", "上跳一级 → .obsidian 本身"],
            ["../../evil", "上跳后进别的目录"],
            ["a/b", "含路径分隔符"],
            ["a\\b", "含反斜杠"],
            // Windows 会静默去掉结尾的点、以及首尾空白 —— 写进去与读出来
            // 就不是同一个名字了，那种「找不到自己刚建的目录」最难查。
            ["Minimal.", "以点结尾"],
            [" Minimal", "前导空格"],
            ["Minimal ", "结尾空格"],
        ])("丢弃 %s 的条目（%s）", (id) => {
            const settings = normalizeSettings(trackedWith(id));
            expect(settings.installer.tracked).toEqual([]);
        });

        it("**真实主题名一律保留**（空格、大写、非 ASCII 都是常态）", () => {
            for (const id of ["Minimal", "Blue Topaz", "AnuPpuccin", "玫瑰紫", "Things"]) {
                const settings = normalizeSettings(trackedWith(id));
                expect(settings.installer.tracked.map((item) => item.id)).toEqual([id]);
            }
        });

        it("同一串名字在两种 kind 下判据不同 —— 不能把两边并成一个正则", () => {
            // 这条守的是「有人图省事共用一个判据」：那会让上面那组合法主题名
            // 全部消失（没有任何提示），而插件侧本就不该接受它。
            const asTheme = normalizeSettings(trackedWith("Blue Topaz"));
            expect(asTheme.installer.tracked).toHaveLength(1);

            const asPlugin = normalizeSettings({
                installer: {
                    tracked: [
                        {
                            kind: "plugin",
                            host: "github",
                            owner: "o",
                            repo: "r",
                            id: "Blue Topaz",
                            name: "X",
                        },
                    ],
                },
            });
            expect(asPlugin.installer.tracked).toEqual([]);
        });
    });

    it("同一个 id 的插件与主题可以共存（键空间按 kind 前缀分开）", () => {
        const settings = normalizeSettings({
            installer: {
                tracked: [
                    {
                        kind: "plugin",
                        host: "github",
                        owner: "o",
                        repo: "r",
                        id: "minimal",
                        name: "Plugin Minimal",
                    },
                    {
                        kind: "theme",
                        host: "github",
                        owner: "kepano",
                        repo: "obsidian-minimal",
                        id: "minimal",
                        name: "Theme Minimal",
                    },
                ],
            },
        });

        expect(settings.installer.tracked.map((item) => item.kind)).toEqual([
            "plugin",
            "theme",
        ]);
    });

    /**
     * 主题的身份是目录名，而 macOS / Windows 的文件系统不区分大小写 ——
     * 代码里另外三处都按这个口径办（`resolveThemeFolder` / `listInstalledThemes` /
     * `getActiveTheme`），去重也必须跟上。
     *
     * `data.json` 是可以手改、也会随笔记仓库同步到多设备的：一台机器上目录叫
     * `Minimal`、另一台叫 `minimal` 完全可能。两条记录指向的是**同一个目录**
     * （`resolveThemeFolder` 会把它们解析到一起），于是列表里两行一模一样的主题，
     * 更新其中一个等于更新两个，而徽标只会在其中一行亮 —— 用户分不出哪行是真的。
     *
     * 插件侧不受影响：`manifest.id` 有 `/^[a-z0-9-]+$/` 的校验，不可能出现大写。
     */
    it("tracked 里同一个主题的大小写变体只保留第一条", () => {
        const settings = normalizeSettings({
            installer: {
                tracked: [
                    {
                        kind: "theme",
                        host: "github",
                        owner: "kepano",
                        repo: "obsidian-minimal",
                        id: "Minimal",
                        name: "Minimal",
                    },
                    {
                        kind: "theme",
                        host: "github",
                        owner: "kepano",
                        repo: "obsidian-minimal",
                        id: "minimal",
                        name: "Minimal",
                    },
                ],
            },
        });

        expect(settings.installer.tracked).toHaveLength(1);
        // 保留的是**先出现的那条**（与「同一个身份只保留第一条」一致），
        // 不悄悄改写成后一条的写法 —— 记录里的名字是磁盘上那个名字。
        expect(settings.installer.tracked[0]!.id).toBe("Minimal");
    });

    it("缺 kind 的条目被丢弃（v3 起 kind 是必填，老数据由迁移负责补齐）", () => {        const settings = normalizeSettings({
            version: 3,
            installer: {
                tracked: [{ host: "github", owner: "o", repo: "r", id: "demo", name: "D" }],
            },
        });
        expect(settings.installer.tracked).toEqual([]);
    });

    /**
     * `origin`（走了 Gitee 镜像时记下的**源仓库地址**）的校验。
     *
     * 它的判据与别的字段不同：**坏值只丢它自己，不丢整个条目**。
     * 它纯粹是展示用的补充信息（列表在源仓库下面多画一行），为了一个多余的地址
     * 把用户在跟的插件扔出列表，代价完全不成比例 —— 而这条数据来自
     * `data.json`，可以被手改，也会随笔记仓库同步到别的设备。
     */
    describe("tracked 里的 origin 校验", () => {
        function trackedWith(origin: unknown) {
            return {
                installer: {
                    tracked: [
                        {
                            kind: "plugin",
                            host: "gitee",
                            owner: "owner",
                            repo: "demo",
                            id: "demo",
                            name: "Demo",
                            origin,
                        },
                    ],
                },
            };
        }

        it("合法值原样保留", () => {
            const settings = normalizeSettings(
                trackedWith({ host: "github", owner: "owner", repo: "demo" })
            );

            expect(settings.installer.tracked[0]!.origin).toEqual({
                host: "github",
                owner: "owner",
                repo: "demo",
            });
        });

        it.each([
            ["不是对象", "github"],
            ["是数组", [{ host: "github", owner: "owner", repo: "demo" }]],
            ["平台不认识", { host: "gitlab", owner: "owner", repo: "demo" }],
            ["owner 为空", { host: "github", owner: "", repo: "demo" }],
            ["repo 为空", { host: "github", owner: "owner", repo: "" }],
            ["缺 repo", { host: "github", owner: "owner" }],
        ])("丢弃坏值但**保留条目**（%s）", (_label, origin) => {
            const settings = normalizeSettings(trackedWith(origin));

            expect(settings.installer.tracked).toHaveLength(1);
            expect(settings.installer.tracked[0]!.origin).toBeUndefined();
        });

        it("**与主来源相同的值视为没写**（否则列表画出两行同一个地址）", () => {
            const settings = normalizeSettings(
                trackedWith({ host: "gitee", owner: "owner", repo: "demo" })
            );

            expect(settings.installer.tracked).toHaveLength(1);
            expect(settings.installer.tracked[0]!.origin).toBeUndefined();
        });

        it("没写这个字段时不影响任何旧数据（v2/v3 记录照常加载）", () => {
            const settings = normalizeSettings(trackedWith(undefined));

            expect(settings.installer.tracked[0]!.id).toBe("demo");
            expect(settings.installer.tracked[0]!.origin).toBeUndefined();
        });
    });
});
