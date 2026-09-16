import { describe, expect, it } from "vitest";
import { parseManifest, versionsLookEquivalent } from "../../src/features/installer/manifest";
import { InstallerError } from "../../src/features/installer/errors";
import { expectInstallerError } from "../helpers/expectInstallerError";

const VALID = JSON.stringify({
    id: "glimpse",
    name: "Glimpse",
    version: "1.0.8",
    minAppVersion: "1.5.0",
    description: "A plugin",
    author: "Sofqi",
});

describe("parseManifest", () => {
    it("解析合法 manifest", () => {
        expect(parseManifest(VALID, "test")).toEqual({
            id: "glimpse",
            name: "Glimpse",
            version: "1.0.8",
            minAppVersion: "1.5.0",
            description: "A plugin",
            author: "Sofqi",
            authorUrl: undefined,
            isDesktopOnly: false,
        });
    });

    it("缺必需字段时报错并指出是哪个字段", () => {
        for (const field of ["id", "name", "version", "minAppVersion"]) {
            const raw = JSON.stringify({ ...JSON.parse(VALID), [field]: undefined });
            expectInstallerError(() => parseManifest(raw, "test"), "manifestMissingField");
            // 参数里要带上具体是哪个字段，否则用户不知道该补什么
            try {
                parseManifest(raw, "test");
            } catch (err) {
                expect((err as InstallerError).detail).toMatchObject({ field });
            }
        }
    });

    it("字段是空字符串也算缺失", () => {
        const raw = JSON.stringify({ ...JSON.parse(VALID), version: "  " });
        expectInstallerError(() => parseManifest(raw, "test"), "manifestMissingField");
    });

    it("非法 JSON 报错", () => {
        expectInstallerError(() => parseManifest("{not json", "test"), "manifestNotJson");
    });

    it("顶层不是对象时报错", () => {
        expectInstallerError(() => parseManifest("[]", "test"), "manifestNotObject");
        expectInstallerError(() => parseManifest("null", "test"), "manifestNotObject");
        expectInstallerError(() => parseManifest('"text"', "test"), "manifestNotObject");
    });

    it("拒绝非法的插件 id —— 它会被用作目录名", () => {
        // id 直接拼进路径，含 `../` 之类的字符会造成目录穿越。
        for (const id of ["../evil", "My Plugin", "UPPER", "a/b", "a\\b"]) {
            const raw = JSON.stringify({ ...JSON.parse(VALID), id });
            expectInstallerError(() => parseManifest(raw, "test"), "manifestBadId");
        }
    });

    it("接受合法的插件 id 形态", () => {
        for (const id of ["glimpse", "my-plugin", "plugin2", "a-b-c-1"]) {
            const raw = JSON.stringify({ ...JSON.parse(VALID), id });
            expect(parseManifest(raw, "test").id).toBe(id);
        }
    });

    it("isDesktopOnly 只在严格为 true 时生效", () => {
        expect(parseManifest(VALID, "test").isDesktopOnly).toBe(false);
        expect(
            parseManifest(JSON.stringify({ ...JSON.parse(VALID), isDesktopOnly: true }), "test")
                .isDesktopOnly
        ).toBe(true);
        expect(
            parseManifest(JSON.stringify({ ...JSON.parse(VALID), isDesktopOnly: "true" }), "test")
                .isDesktopOnly
        ).toBe(false);
    });
});

describe("versionsLookEquivalent", () => {
    it("忽略 v 前缀与大小写", () => {
        expect(versionsLookEquivalent("v1.2.3", "1.2.3")).toBe(true);
        expect(versionsLookEquivalent("1.2.3", "1.2.3")).toBe(true);
        expect(versionsLookEquivalent("V1.2.3", "1.2.3")).toBe(true);
    });

    it("不同版本不相等", () => {
        expect(versionsLookEquivalent("1.2.3", "1.2.4")).toBe(false);
    });
});
