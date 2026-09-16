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

    it("可更新记录：剪掉不在跟踪列表里的条目，丢弃形状不对的条目", () => {
        // 跟踪列表是「谁该有徽标」的唯一事实来源 —— 残留已移除插件的
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
});
