import { getLanguage } from "obsidian";
import { en } from "./locales/en";
import { zhCN, type LocaleStrings } from "./locales/zh-cn";

/**
 * i18n 的解析入口。
 *
 * 与参考项目 BRAT 的方案一致（零依赖 + 编译期强制全覆盖），但有一处刻意的反转：
 * **规范语言是简体中文**，`LocaleStrings` 从 `zh-cn.ts` 推导，英文反向满足它。
 * 这样漏翻译会在 `pnpm typecheck` 阶段直接失败，而不是运行时静默显示英文。
 */

export type { LocaleStrings };

/** 设置项里可选的语言值。`auto` 表示跟随 Obsidian。 */
export type LanguageSetting = "auto" | "zh-cn" | "en";

/** 已实现的语言。新增语言只需在这里加一项 + 建一个 locale 文件。 */
export const LOCALES: Record<string, LocaleStrings> = {
    "zh-cn": zhCN,
    en,
};

export const FALLBACK_LOCALE = "en";

/** 设置页下拉框的选项。标签用各自的语言书写，不随界面语言变化。 */
export const LANGUAGE_OPTIONS: ReadonlyArray<{ value: LanguageSetting; label: string }> = [
    { value: "auto", label: "auto" },
    { value: "zh-cn", label: "简体中文" },
    { value: "en", label: "English" },
];

/**
 * 把任意语言标识归一化成受支持的 locale key。
 *
 * Obsidian 返回的 `getLanguage()` 可能是 `zh`、`zh-CN`、`zh-Hans` 等任意形态，
 * 这里统一小写 + 把下划线转成连字符后再匹配。
 */
export function resolveLocale(language: string | undefined): string {
    if (!language) return FALLBACK_LOCALE;

    const normalized = language.toLowerCase().replace(/_/g, "-");

    // 所有中文变体都落到简体：繁体用户读简体比读英文更顺，
    // 而维护一份独立的 zh-tw 目前不值得。
    if (normalized === "zh" || normalized.startsWith("zh-")) return "zh-cn";

    if (normalized === "en" || normalized.startsWith("en-")) return "en";

    // 精确匹配（为将来新增语言留的路径）
    if (normalized in LOCALES) return normalized;

    return FALLBACK_LOCALE;
}

/**
 * 取出一份翻译表。
 *
 * @param language 设置项的值；`auto` 会读取 Obsidian 当前的语言。
 */
export function getTranslations(language: LanguageSetting = "auto"): LocaleStrings {
    const key = language === "auto" ? resolveLocale(getLanguage()) : resolveLocale(language);
    return LOCALES[key] ?? LOCALES[FALLBACK_LOCALE]!;
}
