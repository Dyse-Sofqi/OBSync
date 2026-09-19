import { describe, expect, it } from "vitest";
import { Notifier } from "../../src/core/notice";
import { en } from "../../src/core/i18n/locales/en";
import { zhCN } from "../../src/core/i18n/locales/zh-cn";
import {
    InstallerError,
    describeInstallerError,
    type InstallerErrorDetail,
} from "../../src/features/installer/errors";
import { describeSyncError } from "../../src/features/sync/errors";
import { GitAuthError } from "../../src/features/sync/errors";

/**
 * 安装器错误的**展示层**翻译。
 *
 * 背景：抛出点（manifest / installFiles / itemFolder）是纯函数，拿不到 `t`，
 * 所以只携带「类型码 + 参数」；用户能看懂的话在这里按类型拼。
 *
 * 早期实现把中文文案烘焙进 `message`，而 `Notifier` 对 `ObsyncError` 是原样返回 ——
 * 结果是**英文界面下冒出中文错误**。当时还留下了 6 个写了却没接上的 i18n 键
 * （missingManifest / missingMainJs / noReleaseFallback / sourceRelease /
 * sourceRaw / installing），正是「本来打算本地化但没接上」的证据。
 */

/** 每种类型码各造一个样例，用来验证「每个都有对应文案」。 */
const SAMPLES: InstallerErrorDetail[] = [
    { kind: "manifestNotJson", context: "demo" },
    { kind: "manifestNotObject", context: "demo" },
    { kind: "manifestMissingField", context: "demo", field: "version" },
    { kind: "manifestBadId", context: "demo", id: "BAD ID" },
    { kind: "missingManifest", repo: "o/r", of: "plugin" },
    { kind: "missingRequiredFiles", repo: "o/r", files: "main.js", of: "plugin" },
    { kind: "assetDownloadFailed", repo: "o/r", files: "main.js", of: "plugin" },
    { kind: "missingBuildArtifacts" },
    { kind: "incompatibleApp", name: "Demo", minVersion: "1.9.0" },
    { kind: "pluginIdConflict", pluginId: "demo", repo: "o/r" },
    { kind: "folderMissingRequired", id: "demo", file: "main.js", of: "plugin" },
    { kind: "writeFailedRolledBack", id: "demo", of: "plugin" },
    { kind: "writeFailedRollbackFailed", id: "demo", of: "plugin" },
    { kind: "cannotEnablePlugin" },
    { kind: "communityIndexFailed", status: 500 },
    { kind: "rateLimitFallback", host: "Gitee" },
    { kind: "apiUnavailableFallback", host: "GitHub" },
    { kind: "rateLimited", host: "Gitee" },
];

describe("describeInstallerError", () => {
    it("每种类型码都有中文文案，且都带上关键参数", () => {
        for (const detail of SAMPLES) {
            const text = describeInstallerError(new InstallerError(detail), zhCN);
            expect(text, `kind=${detail.kind} 没有文案`).toBeTruthy();
            expect(text!.trim()).not.toBe("");
        }
    });

    it("把参数插进文案里（用户才知道是哪个仓库/字段出了问题）", () => {
        const missingField = describeInstallerError(
            new InstallerError({ kind: "manifestMissingField", context: "o/r", field: "version" }),
            zhCN
        );
        expect(missingField).toContain("version");
        expect(missingField).toContain("o/r");

        const conflict = describeInstallerError(
            new InstallerError({ kind: "pluginIdConflict", pluginId: "demo", repo: "o/r" }),
            zhCN
        );
        expect(conflict).toContain("demo");
        expect(conflict).toContain("o/r");
    });

    it("**英文界面下给出英文文案**（这条链路存在的理由）", () => {
        for (const detail of SAMPLES) {
            const text = describeInstallerError(new InstallerError(detail), en)!;
            expect(text, `kind=${detail.kind} 的英文文案混入了中文`).not.toMatch(
                /[\u4e00-\u9fff]/
            );
        }
    });

    it("错误自身的 message 只含技术性描述，不含面向用户的文案", () => {
        // message 进日志，也可能在兜底路径里露出来 —— 不该混入中文。
        const error = new InstallerError({ kind: "missingManifest", repo: "o/r", of: "plugin" });

        expect(error.message).toContain("missingManifest");
        expect(error.message).toContain("o/r");
        expect(error.message).not.toMatch(/[\u4e00-\u9fff]/);
    });

    it("认不出的错误返回 undefined，交回通用规则", () => {
        expect(describeInstallerError(new Error("boom"), zhCN)).toBeUndefined();
        expect(describeInstallerError(new GitAuthError("x"), zhCN)).toBeUndefined();
        expect(describeInstallerError("not an error", zhCN)).toBeUndefined();
    });
});

describe("两个模块的翻译器共存", () => {
    it("各自认领自己的错误类型，互不干扰", () => {
        const notifier = new Notifier({
            getShowNotices: () => true,
            getT: () => zhCN,
        });
        // 顺序与真实装配一致：安装器先注册，sync 后注册（见各自的 createXxxModule）。
        notifier.registerErrorTranslator(describeInstallerError);
        notifier.registerErrorTranslator(describeSyncError);

        expect(
            notifier.describeError(new InstallerError({ kind: "cannotEnablePlugin" }))
        ).toBe(zhCN.installer.errors.cannotEnablePlugin);

        expect(notifier.describeError(new GitAuthError("x"))).toBe(zhCN.sync.gitAuthFailed);
    });

    it("安装器不认识 sync 的错误，会正确交给下一个翻译器", () => {
        const notifier = new Notifier({ getShowNotices: () => true, getT: () => en });
        notifier.registerErrorTranslator(describeInstallerError);
        notifier.registerErrorTranslator(describeSyncError);

        expect(notifier.describeError(new GitAuthError("x"))).toBe(en.sync.gitAuthFailed);
    });
});
