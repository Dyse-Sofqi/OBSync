import { describe, expect, it } from "vitest";
import { compareVersions, isNewerVersion } from "../../src/features/installer/versions";

describe("compareVersions", () => {
    it("正确处理位数不同的版本号", () => {
        // 字符串比较会得出 "1.10.0" < "1.9.0" 的错误结论 —— 这条是防回归。
        expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
        expect(compareVersions("1.9.0", "1.10.0")).toBeLessThan(0);
    });

    it("归一化 v 前缀与预发布后缀", () => {
        expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
        expect(compareVersions("1.2.3", "v1.2.3")).toBe(0);
    });

    it("能比较带非版本前缀的 tag", () => {
        expect(compareVersions("release-2.0.0", "1.0.0")).toBeGreaterThan(0);
    });

    it("无法解析时返回 undefined 而不是猜一个结果", () => {
        expect(compareVersions("not-a-version", "1.0.0")).toBeUndefined();
        expect(compareVersions("1.0.0", "")).toBeUndefined();
    });
});

describe("isNewerVersion", () => {
    it("正常判断新旧", () => {
        expect(isNewerVersion("1.2.4", "1.2.3")).toBe(true);
        expect(isNewerVersion("1.2.3", "1.2.3")).toBe(false);
        expect(isNewerVersion("1.2.2", "1.2.3")).toBe(false);
    });

    it("tag 与 manifest 版本号写法不同但语义相同时不算有更新", () => {
        expect(isNewerVersion("v1.2.3", "1.2.3")).toBe(false);
    });

    it("无法解析版本号时退化为字符串比较", () => {
        expect(isNewerVersion("nightly", "nightly")).toBe(false);
        expect(isNewerVersion("nightly-2", "nightly-1")).toBe(true);
    });
});
