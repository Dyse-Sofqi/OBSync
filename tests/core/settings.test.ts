import { describe, expect, it } from "vitest";
import {
    DEFAULT_SETTINGS,
    SETTINGS_VERSION,
    normalizeSettings,
} from "../../src/core/settings";

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

    it("可更新记录：剪掉不在跟踪列表里的条目，丢弃形状不对的条目", () => {        // 跟踪列表是「谁该有徽标」的唯一事实来源 —— 残留已移除插件的
        // 记录会在重装同名 id 插件时显示过期徽标。
        const settings = normalizeSettings({
            installer: {
                tracked: [
                    {
                        host: "github",
                        owner: "owner",
                        repo: "kept",
                        pluginId: "kept",
                        name: "Kept",
                        installedVersion: "1.0.0",
                        requestedVersion: "latest",
                        frozen: false,
                        channel: "release",
                        installedAt: 0,
                    },
                ],
                availableUpdates: {
                    kept: { latestVersion: "v2.0.0", checkedAt: 42 },
                    removed: { latestVersion: "v3.0.0", checkedAt: 42 },
                    malformed: { latestVersion: 123, checkedAt: "yesterday" },
                },
            },
        });

        expect(settings.installer.availableUpdates).toEqual({
            kept: { latestVersion: "v2.0.0", checkedAt: 42 },
        });
    });

    /**
     * `pluginId` 的**内容**必须校验，不能只校验「是不是非空字符串」。
     *
     * 理由不是洁癖：`manifest.ts` 对同一个字段有严格校验，注释写着
     * 「id 会被用作目录名，非法字符会造成路径问题，必须在写入前拦下」。
     * 而 `data.json` 是**可以手改、也会随笔记仓库同步到多设备**的东西 ——
     * 它是这个字段唯一不经过 `parseManifest` 的来源。
     *
     * 下游拿它干什么：卸载时 `resolvePluginFolder()` 找不到同名目录就回落到
     * `{configDir}/plugins/{pluginId}`，然后 `rmdir(folder, true)` **递归**删。
     *
     * 下面按**实际后果**分两组 —— 这两组的严重程度不一样，
     * 别把「不合法」当成「一模一样危险」：
     */
    describe("tracked 里的 pluginId 内容校验", () => {
        function trackedWith(pluginId: string) {
            return {
                installer: {
                    tracked: [
                        {
                            host: "github",
                            owner: "owner",
                            repo: "repo",
                            pluginId,
                            name: "X",
                        },
                    ],
                },
            };
        }

        /**
         * 这组会**逃出 `plugins/`** —— 路径算术在
         * `tests/features/pluginFolder.test.ts` 里用 `resolvePluginFolder` 实测过
         * （含「那个路径存在时真的会发出递归删除调用」一条），这里不重复算。
         */
        it.each([
            ["..", "上跳一级 → .obsidian 本身"],
            ["../..", "上跳两级 → 库根目录"],
            ["../../evil", "上跳后进别的目录 → 库根下的 evil"],
        ])("丢弃 %s 的条目（%s）", (pluginId) => {
            const settings = normalizeSettings(trackedWith(pluginId));
            expect(settings.installer.tracked).toEqual([]);
        });

        /**
         * 这组**不会**逃出 `plugins/` —— 别把它们和上面那组混为一谈。
         * 但同样要丢：这些值都不可能是真 manifest 的 id（那必须先过
         * `/^[a-z0-9-]+$/`），留着只会让卸载/更新去操作一个错的目录。
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
        ])("丢弃 %s 的条目（不是合法 id：%s）", (pluginId) => {
            const settings = normalizeSettings(trackedWith(pluginId));
            expect(settings.installer.tracked).toEqual([]);
        });

        it("合法的 id 一个都不能丢", () => {
            // 这条是上面那组的安全网：收紧校验时最容易连合法值一起误伤，
            // 而那些 id 会带着用户的跟踪列表一起消失。
            const valid = ["demo", "obsidian-git", "my-plugin-2", "a", "9", "x-1-2"];
            for (const pluginId of valid) {
                const settings = normalizeSettings(trackedWith(pluginId));
                expect(settings.installer.tracked.map((item) => item.pluginId)).toEqual([
                    pluginId,
                ]);
            }
        });
    });
});
