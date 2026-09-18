import { InstallerError } from "./errors";
import { RemoteIndex } from "./communityIndex";
import { httpJson } from "../../host/http";

/**
 * Obsidian 官方社区主题索引。
 *
 * 与插件索引同源（都在 `obsidianmd/obsidian-releases`），字段却完全不同 ——
 * 实测条目形状是 `{ name, author, repo, screenshot, modes, legacy? }`：
 * **既没有 `id`，也没有 `version`**。
 *
 * 这恰好印证了主题的身份规则：没有 id 可用，只能用名字（也就是目录名）去认。
 * 于是「绑定」的匹配只能按名字来 —— 见 `existingThemes.ts` 里的两级匹配。
 *
 * 另一处与插件侧的差别：这个索引只覆盖**官方商店里的 GitHub 仓库**。主题从
 * Gitee 或私人仓库装的情况比插件多得多，而那些主题在这里查不到 —— 因为本次
 * 不做「从仓库新装主题」，未识别的主题没有别的入口，所以绑定弹窗给了用户
 * 手填仓库地址的路（插件侧不需要：它有「添加插件仓库」）。
 */

const COMMUNITY_THEMES_URL =
    "https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-css-themes.json";

export interface CommunityTheme {
    name: string;
    author: string;
    /** `owner/repo`。 */
    repo: string;
}

interface RawEntry {
    name?: unknown;
    author?: unknown;
    repo?: unknown;
}

export class CommunityThemeIndex extends RemoteIndex<CommunityTheme> {
    protected readonly label = "community theme index";

    /**
     * 按主题名查条目，**大小写不敏感**。
     *
     * 主题名是给用户看的（`Minimal`、`Blue Topaz`），目录名却可能被用户手改成
     * 别的写法；而索引里的写法我们无从保证与本地一致。精确比较会让一批主题
     * 平白变成「来源未识别」。
     */
    byName(name: string): CommunityTheme | undefined {
        const target = name.trim().toLowerCase();
        if (!target) return undefined;
        return this.items.find((theme) => theme.name.toLowerCase() === target);
    }

    protected async fetchIndex(): Promise<CommunityTheme[]> {
        const response = await httpJson<RawEntry[]>({ url: COMMUNITY_THEMES_URL });

        if (response.status !== 200 || !Array.isArray(response.data)) {
            throw new InstallerError({ kind: "communityIndexFailed", status: response.status });
        }

        const themes: CommunityTheme[] = [];
        for (const entry of response.data) {
            // 缺 repo 的条目没有任何用处（绑定靠它），跳过而不是让整份索引挂掉。
            if (typeof entry?.name !== "string" || typeof entry?.repo !== "string") continue;
            themes.push({
                name: entry.name,
                author: typeof entry.author === "string" ? entry.author : "",
                repo: entry.repo,
            });
        }

        return themes;
    }
}
