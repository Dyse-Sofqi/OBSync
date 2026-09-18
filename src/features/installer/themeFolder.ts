import type { App } from "obsidian";
import { logger } from "../../core/logger";
import { defaultItemFolder, filePathIn, itemRoot } from "./itemFolder";
import { parseThemeManifest } from "./manifest";
import { MANIFEST_FILE, type ThemeManifest } from "./types";

/**
 * 主题的目录定位，以及「当前主题」那一侧的非公开 API 守卫。
 *
 * 与插件最大的不同：主题**没有「启用 / 禁用」**，只有「当前用的是哪一个」。
 * 那个状态握在 Obsidian 的非公开 API 里（`app.customCss`）—— 公开的
 * `obsidian.d.ts` 里 `customCss` 出现 **0 次**，所以这里全部走窄接口 + 可用性
 * 兜底，与 `pluginFolder.ts` 的 `InternalPluginManager` 是同一套做法。
 *
 * ## 为什么只读不写（`setTheme` 特意没有收进来）
 *
 * 唯一需要「写」的场景是替用户换主题，而这件事我们**不做**：
 * - 更新主题时绝不改变用户当前的选择；
 * - 取消跟踪不删任何文件（见 `InstallerService.unbind`），所以也不需要
 *   「删之前先切回默认主题」那一套。
 *
 * 于是这里只剩两件事，都服务于同一个目的 —— **让更新过的当前主题立刻生效**：
 *
 * - **读**当前主题名：`getTheme()` → `customCss.theme` → `vault.getConfig("cssTheme")`。
 *   三级兜底不是凑数 —— 第三方项目专门注释过 vault 那份缓存可能过时；
 *   空串表示「默认主题」，读不到返回 `undefined`（两者必须区分得开）。
 * - **重载**：`requestLoadTheme()`。替换掉正在使用的主题的 CSS 之后必须调它，
 *   否则用户看到「更新成功」但观感没变 —— Obsidian 不会自己去读被换掉的文件。
 */

/** Obsidian 内部的主题管理 API。未进 typings，只能收窄。 */
interface InternalCustomCss {
    theme?: string;
    getTheme?(): string;
    requestLoadTheme?(): void;
}

function customCss(app: App): InternalCustomCss | undefined {
    return (app as unknown as { customCss?: InternalCustomCss }).customCss;
}

/**
 * 解析主题的真实目录。
 *
 * 主题没有 id 字段，`themes/` 下的目录名就是它的身份（`setTheme()` 收的也是它），
 * 所以不需要像插件那样比对 manifest。但**大小写要兜一下**：macOS / Windows 的
 * 文件系统大小写不敏感，用户手改过大小写（或在另一台机器上装成了不同大小写）时，
 * 记录里的 `minimal` 与磁盘上的 `Minimal` 是同一个主题 —— 只按记录拼路径会在
 * Linux 上找不到它，于是「更新」出一个第二份目录。
 *
 * 精确命中永远优先；两趟都找不到才回落到默认位置（全新写入的落点）。
 */
export async function resolveThemeFolder(app: App, themeName: string): Promise<string> {
    try {
        const listing = await app.vault.adapter.list(itemRoot(app, "theme"));
        const names = listing.folders.map((folder) => ({
            folder,
            name: folder.slice(folder.lastIndexOf("/") + 1),
        }));

        const exact = names.find((entry) => entry.name === themeName);
        if (exact) return exact.folder;

        const target = themeName.toLowerCase();
        const insensitive = names.find((entry) => entry.name.toLowerCase() === target);
        if (insensitive) return insensitive.folder;
    } catch (err) {
        // 主题根目录还不存在 —— 不是错误。
        logger.debug("could not scan theme folders", err);
    }

    return defaultItemFolder(app, "theme", themeName);
}

/** 读取某个主题目录里的 manifest。没有或损坏时返回 undefined。 */
export async function readThemeManifestInFolder(
    app: App,
    folder: string
): Promise<ThemeManifest | undefined> {
    const path = filePathIn(folder, MANIFEST_FILE);
    try {
        if (!(await app.vault.adapter.exists(path))) return undefined;
        return parseThemeManifest(await app.vault.adapter.read(path), path);
    } catch {
        return undefined;
    }
}

/**
 * 当前正在使用的主题名。空串表示默认主题。
 *
 * **`undefined` 与 `""` 是两件事**：前者是「读不到」（非公开 API 在这版 Obsidian
 * 上不可用），后者是「用户用的就是默认主题」。调用方必须分开处理 ——
 * 把读不到当成默认，会让「移除正在使用的主题」那条保护静默失效。
 */
export function getActiveTheme(app: App): string | undefined {
    const css = customCss(app);

    try {
        if (typeof css?.getTheme === "function") return css.getTheme() || "";
        if (typeof css?.theme === "string") return css.theme;
    } catch (err) {
        logger.debug("reading active theme failed", err);
    }

    // 最后一层：vault 配置里的 cssTheme。同样是非公开 API。
    try {
        const vault = app.vault as unknown as { getConfig?(key: string): unknown };
        const value = vault.getConfig?.("cssTheme");
        if (typeof value === "string") return value;
    } catch (err) {
        logger.debug("reading cssTheme from vault config failed", err);
    }

    return undefined;
}

/**
 * 让 Obsidian 重新读主题文件。
 *
 * 尽力而为：拿不到这个 API 就什么也不做（文件已经写好了，用户重开一次
 * Obsidian 也会生效），**不抛错** —— 更新本身是成功的，不该因为「刷新观感」
 * 这一步失败就报成更新失败。
 */
export function requestThemeReload(app: App): void {
    try {
        customCss(app)?.requestLoadTheme?.();
    } catch (err) {
        logger.debug("requesting theme reload failed", err);
    }
}
