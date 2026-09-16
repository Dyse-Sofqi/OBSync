import { SuggestModal, type App } from "obsidian";
import type { LocaleStrings } from "../../../core/i18n";
import type { CommunityPlugin, CommunityPluginIndex } from "../communityPlugins";

/**
 * 浏览 / 搜索 Obsidian 官方社区插件列表。
 *
 * 只对 GitHub 源有效 —— 这个索引是 Obsidian 官方维护的，
 * 托管在 GitHub 上，Gitee 没有任何等价物（见 communityPlugins.ts）。
 * 调用方必须**先 `await index.load()`** 再打开，否则 `getSuggestions`
 * 会在索引还没加载时返回空列表，表现为「搜索框里打什么都没结果」。
 */
export class CommunityPluginModal extends SuggestModal<CommunityPlugin> {
    constructor(
        app: App,
        private readonly index: CommunityPluginIndex,
        t: LocaleStrings,
        private readonly onChoose: (plugin: CommunityPlugin) => void
    ) {
        super(app);
        this.setPlaceholder(t.installer.communitySearchPlaceholder);
    }

    getSuggestions(query: string): CommunityPlugin[] {
        return this.index.search(query, 50);
    }

    renderSuggestion(plugin: CommunityPlugin, el: HTMLElement): void {
        el.createDiv({ text: plugin.name, cls: "obsync-community-name" });

        const meta: string[] = [plugin.repo];
        if (plugin.author) meta.push(plugin.author);
        if (plugin.downloads !== undefined) {
            meta.push(formatDownloads(plugin.downloads));
        }
        el.createEl("small", { text: meta.join(" · "), cls: "obsync-suggestion-meta" });

        if (plugin.description) {
            el.createEl("small", {
                text: plugin.description,
                cls: "obsync-suggestion-desc",
            });
        }
    }

    onChooseSuggestion(plugin: CommunityPlugin): void {
        this.onChoose(plugin);
    }
}

function formatDownloads(count: number): string {
    if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
    if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
    return String(count);
}
