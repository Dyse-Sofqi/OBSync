import type { App } from "obsidian";
import { logger } from "../../core/logger";
import { isValidThemeName } from "../../core/themeName";
import type { RepoRef } from "../../host/types";
import { communityRepoRef } from "./communityIndex";
import type { CommunityThemeIndex } from "./communityThemes";
import { itemRoot } from "./itemFolder";
import { readThemeManifestInFolder } from "./themeFolder";
import type { ThemeManifest } from "./types";

/**
 * 识别库里「已装但未跟踪」的主题，并把它们和来源仓库对上。
 *
 * ## 与插件侧的三处不同 —— 都是数据决定的，不是选择
 *
 * 1. **身份是目录名**。主题没有 id 字段，`themes/{目录名}` 的目录名就是它在
 *    Obsidian 里的身份（`setTheme()` 收的也是它），所以这里不像插件那样拿
 *    manifest.id 去重与匹配，一律以目录名为准（大小写视为同一个）。
 * 2. **匹配靠名字，两级**。官方主题索引里既没有 id 也没有 version，只有
 *    `name` + `repo`。先按 manifest 的 name 匹配，匹配不到再退到目录名 ——
 *    手动安装的主题常常被改成自己认得的目录名，这两个都可能对得上。
 * 3. **没有 manifest 也算一个主题**。Obsidian 自己会把缺 manifest 的目录当作
 *    版本 `0.0.0` 的主题加载，用户也确实可能在用它。绑定它是有意义的
 *    （版本留空表示未知，更新检查照样跑），所以这里不跳过它。
 *
 * ## 为什么扫文件系统而不是 `app.customCss.themes`
 *
 * 与插件侧同一个理由：那是在内存里的状态，可能与磁盘有出入（刚拷进去还没重启）。
 * 以磁盘为准，顺带能发现「装了但损坏」的目录。
 */

/** 库里已安装的一个主题。 */
export interface ExistingTheme {
    /** 目录名 —— 主题的身份，也是写盘 / 删盘用的名字。 */
    id: string;
    /** 显示名：manifest 的 name，缺失时回落目录名。 */
    name: string;
    /** manifest 的 version；缺失时为空串（表示**未知**，不是 0.0.0）。 */
    version: string;
    manifest?: ThemeManifest;
}

/** 可以直接绑定跟踪的候选：来源仓库已识别。 */
export interface ThemeBindCandidate {
    id: string;
    name: string;
    version: string;
    repo: RepoRef;
}

/**
 * 扫描库中已安装的主题目录。
 *
 * 目录名不安全的（会成为路径的一截，见 `core/themeName.ts`）直接跳过并记日志 ——
 * 绑定它等于给「移除」埋一颗路径逃逸的雷。
 */
export async function listInstalledThemes(app: App): Promise<ExistingTheme[]> {
    let folders: string[];
    try {
        folders = (await app.vault.adapter.list(itemRoot(app, "theme"))).folders;
    } catch (err) {
        // 连主题目录都没有 = 全新库，不是错误。
        logger.debug("no themes directory to scan", err);
        return [];
    }

    const result: ExistingTheme[] = [];
    const seen = new Set<string>();

    for (const folder of folders) {
        const id = folder.slice(folder.lastIndexOf("/") + 1);
        // 点开头的目录不是主题（`.git`、编辑器残留……）。Obsidian 自己也不列它们，
        // 但它们会通过 `isValidThemeName`（`.git` 不是 `.` 也不是 `..`），
        // 所以这条要单独挡。
        if (id.startsWith(".")) {
            logger.debug(`skipping non-theme folder: ${folder}`);
            continue;
        }
        if (!isValidThemeName(id)) {
            logger.debug(`skipping theme folder with an unsafe name: ${folder}`);
            continue;
        }

        // 大小写不同视为同一个主题 —— 与 resolveThemeFolder 同一个口径
        // （macOS / Windows 的文件系统本就不区分大小写）。
        const key = id.toLowerCase();
        if (seen.has(key)) {
            logger.debug(`skipping duplicate theme folder ${folder} (already seen)`);
            continue;
        }
        seen.add(key);

        const manifest = await readThemeManifestInFolder(app, folder);
        result.push({
            id,
            name: manifest?.name || id,
            version: manifest?.version ?? "",
            manifest,
        });
    }

    return result.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 把已安装主题与官方社区索引对上，分出「可绑定」与「来源未识别」两组。
 *
 * 会先拉取 / 复用社区主题索引缓存。已在跟踪列表里的由调用方过滤 ——
 * 这里不读设置，保持函数纯粹。
 */
export async function resolveThemeBindCandidates(
    app: App,
    index: CommunityThemeIndex
): Promise<{ bindable: ThemeBindCandidate[]; unresolved: ExistingTheme[] }> {
    await index.load();

    const installed = await listInstalledThemes(app);
    const bindable: ThemeBindCandidate[] = [];
    const unresolved: ExistingTheme[] = [];

    for (const theme of installed) {
        const community = index.byName(theme.name) ?? index.byName(theme.id);
        const repo = community ? communityRepoRef(community.repo) : undefined;

        if (repo) {
            bindable.push({ id: theme.id, name: theme.name, version: theme.version, repo });
        } else {
            unresolved.push(theme);
        }
    }

    return { bindable, unresolved };
}
