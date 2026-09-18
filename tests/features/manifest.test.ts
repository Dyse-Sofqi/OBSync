import { describe, expect, it } from "vitest";
import {
    parsePluginManifest,
    parseThemeManifest,
    versionsLookEquivalent,
} from "../../src/features/installer/manifest";
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

describe("parsePluginManifest", () => {
    it("解析合法 manifest", () => {
        expect(parsePluginManifest(VALID, "test")).toEqual({
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
            expectInstallerError(
                () => parsePluginManifest(raw, "test"),
                "manifestMissingField"
            );
            // 参数里要带上具体是哪个字段，否则用户不知道该补什么
            try {
                parsePluginManifest(raw, "test");
            } catch (err) {
                expect((err as InstallerError).detail).toMatchObject({ field });
            }
        }
    });

    it("字段是空字符串也算缺失", () => {
        const raw = JSON.stringify({ ...JSON.parse(VALID), version: "  " });
        expectInstallerError(() => parsePluginManifest(raw, "test"), "manifestMissingField");
    });

    it("非法 JSON 报错", () => {
        expectInstallerError(() => parsePluginManifest("{not json", "test"), "manifestNotJson");
    });

    it("顶层不是对象时报错", () => {
        expectInstallerError(() => parsePluginManifest("[]", "test"), "manifestNotObject");
        expectInstallerError(() => parsePluginManifest("null", "test"), "manifestNotObject");
        expectInstallerError(() => parsePluginManifest('"text"', "test"), "manifestNotObject");
    });

    it("拒绝非法的插件 id —— 它会被用作目录名", () => {
        // id 直接拼进路径，含 `../` 之类的字符会造成目录穿越。
        for (const id of ["../evil", "My Plugin", "UPPER", "a/b", "a\\b"]) {
            const raw = JSON.stringify({ ...JSON.parse(VALID), id });
            expectInstallerError(() => parsePluginManifest(raw, "test"), "manifestBadId");
        }
    });

    it("接受合法的插件 id 形态", () => {
        for (const id of ["glimpse", "my-plugin", "plugin2", "a-b-c-1"]) {
            const raw = JSON.stringify({ ...JSON.parse(VALID), id });
            expect(parsePluginManifest(raw, "test").id).toBe(id);
        }
    });

    it("isDesktopOnly 只在严格为 true 时生效", () => {
        expect(parsePluginManifest(VALID, "test").isDesktopOnly).toBe(false);
        expect(
            parsePluginManifest(
                JSON.stringify({ ...JSON.parse(VALID), isDesktopOnly: true }),
                "test"
            ).isDesktopOnly
        ).toBe(true);
        expect(
            parsePluginManifest(
                JSON.stringify({ ...JSON.parse(VALID), isDesktopOnly: "true" }),
                "test"
            ).isDesktopOnly
        ).toBe(false);
    });
});

/**
 * 主题 manifest 的**真实形状**与插件不同（三份实测：Minimal 9.1.0 /
 * Things 2.2.4 / AnuPpuccin 1.5.0）：没有 id，多 fundingUrl。
 *
 * 这几条钉住「哪些字段是必需的」，因为这决定了一个仓库能不能被更新 ——
 * 判据比真实情况严，用户就会遇到「明明是好主题却装不上」。
 */
describe("parseThemeManifest", () => {
    const VALID_THEME = JSON.stringify({
        name: "Minimal",
        version: "9.1.0",
        minAppVersion: "1.14.0",
        author: "@kepano",
        authorUrl: "https://twitter.com/kepano",
        fundingUrl: "https://www.buymeacoffee.com/kepano",
    });

    it("解析合法主题 manifest（含插件没有的 fundingUrl）", () => {
        expect(parseThemeManifest(VALID_THEME, "test")).toEqual({
            name: "Minimal",
            version: "9.1.0",
            minAppVersion: "1.14.0",
            author: "@kepano",
            authorUrl: "https://twitter.com/kepano",
            fundingUrl: "https://www.buymeacoffee.com/kepano",
        });
    });

    it("**不要求 id**（主题根本没有这个字段，要求它等于什么都装不上）", () => {
        const result = parseThemeManifest(VALID_THEME, "test");
        expect(result).not.toHaveProperty("id");
    });

    it("name 是唯一的必需字段", () => {
        expectInstallerError(
            () => parseThemeManifest(JSON.stringify({ version: "1.0.0" }), "test"),
            "manifestMissingField"
        );
        expectInstallerError(
            () => parseThemeManifest(JSON.stringify({ name: "   " }), "test"),
            "manifestMissingField"
        );
    });

    it("缺 version 时按 Obsidian 的规矩当 0.0.0", () => {
        // Obsidian 自己就是这么处理的（无 manifest 时 version 视作 "0.0.0"），
        // 所以我们不去拦一个 Obsidian 会正常加载的仓库。
        expect(parseThemeManifest(JSON.stringify({ name: "Bare" }), "test").version).toBe(
            "0.0.0"
        );
    });

    it("minAppVersion 可选", () => {
        expect(
            parseThemeManifest(JSON.stringify({ name: "Bare", version: "1.0.0" }), "test")
                .minAppVersion
        ).toBeUndefined();
    });

    it("**名字古怪也放行**（名字只用于显示，不参与路径构造）", () => {
        // 主题的目录名来自本地已装的那个（见 TrackedBase.id），
        // 远端 manifest 的 name 不拼路径 —— 所以这里不该套用插件 id 的正则。
        for (const name of ["Blue Topaz", "玫瑰紫", "Minimal/Plus", "weird..name"]) {
            expect(parseThemeManifest(JSON.stringify({ name }), "test").name).toBe(name);
        }
    });

    it("非法 JSON 与顶层非对象各自报错", () => {
        expectInstallerError(() => parseThemeManifest("{not json", "test"), "manifestNotJson");
        expectInstallerError(() => parseThemeManifest("[]", "test"), "manifestNotObject");
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
