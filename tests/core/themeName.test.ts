import { describe, expect, it } from "vitest";
import { isValidThemeName } from "../../src/core/themeName";
import { isValidPluginId } from "../../src/core/pluginId";

/**
 * 主题目录名的校验 —— 它同时是主题的**身份**（`setTheme()` 收的就是它）。
 *
 * 这个文件要守的两件事：
 *
 * 1. **路径安全**：会变成路径的一截，`..` / 分隔符一律拦下（与 pluginId 同一条
 *    不变量，理由见 `core/themeName.ts`）；
 * 2. **别把它写成插件 id 的正则**：主题名是给用户看的名词，
 *    「空格、大写、非 ASCII」全是常态。判据写严的后果不是「更安全」，
 *    而是**用户一个主题都绑不上**，且看不出原因。
 */

/** 真实主题名（取自官方社区索引的常见条目）。 */
const REAL_THEME_NAMES = [
    "Minimal",
    "Blue Topaz",
    "AnuPpuccin",
    "Things",
    "Rose Red",
    "Border",
    "玫瑰紫",
    "Tokyo Night",
];

describe("isValidThemeName", () => {
    it("接受真实存在的主题名（含空格、大写、非 ASCII）", () => {
        for (const name of REAL_THEME_NAMES) {
            expect(isValidThemeName(name), name).toBe(true);
        }
    });

    it("接受单字符与带点号但不是路径上跳的名字", () => {
        expect(isValidThemeName("X")).toBe(true);
        // 中间的点没有路径含义（Windows 只在意结尾的点）
        expect(isValidThemeName("v1.2 Theme")).toBe(true);
        expect(isValidThemeName("_")).toBe(true);
        expect(isValidThemeName("-")).toBe(true);
    });

    it.each([
        ["", "空串"],
        [".", "当前目录"],
        ["..", "上一级"],
        ["../..", "上跳两级 → 库根"],
        ["../../evil", "上跳后进别的目录"],
        ["a/b", "含正斜杠"],
        ["a\\b", "含反斜杠"],
        ["/abs", "绝对路径"],
        ["Minimal.", "以点结尾（Windows 会静默去掉）"],
        [" Minimal", "前导空格（Windows 与 Linux 语义不同）"],
        ["Minimal ", "结尾空格"],
        ["Min\nimal", "含换行"],
        ["Min\timal", "含制表符"],
        ["Min\u0000imal", "含 NUL"],
    ])("拒绝 %s（%s）", (name) => {
        expect(isValidThemeName(name)).toBe(false);
    });

    it("拒绝非字符串（`data.json` 里的值什么类型都可能有）", () => {
        for (const value of [undefined, null, 42, true, {}, [], () => undefined]) {
            expect(isValidThemeName(value)).toBe(false);
        }
    });

    it("**判据不能与插件 id 共用** —— 真实主题名在插件规则下几乎全非法", () => {
        // 这条是「有人图省事合并两边」的守卫：合并的后果是上面那组主题名
        // 全部被丢弃，而症状只是「主题列表空着」，没有任何报错。
        const rejectedByPluginRule = REAL_THEME_NAMES.filter((name) => !isValidPluginId(name));
        expect(rejectedByPluginRule.length).toBe(REAL_THEME_NAMES.length);

        // 反过来：路径风险两边都要拦（这条不变量是共用的）
        for (const bad of ["..", "../../evil", "a/b", "a\\b"]) {
            expect(isValidThemeName(bad), bad).toBe(false);
            expect(isValidPluginId(bad), bad).toBe(false);
        }
    });
});
