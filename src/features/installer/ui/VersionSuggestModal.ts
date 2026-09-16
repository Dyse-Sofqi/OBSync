import { SuggestModal, type App } from "obsidian";
import type { LocaleStrings } from "../../../core/i18n";
import type { VersionOption } from "../installerService";

/**
 * 版本选择。
 *
 * 参考项目 BRAT 在版本数 ≥20 时才切换到这种弹窗，否则用内联下拉框；
 * 这里统一用弹窗 —— 两套 UI 只为了省一次点击，不值得。
 */
export class VersionSuggestModal extends SuggestModal<VersionOption> {
    constructor(
        app: App,
        private readonly options: VersionOption[],
        t: LocaleStrings,
        private readonly onChoose: (option: VersionOption) => void
    ) {
        super(app);
        this.setPlaceholder(t.installer.versionLabel);
    }

    getSuggestions(query: string): VersionOption[] {
        const trimmed = query.trim().toLowerCase();
        if (!trimmed) return this.options;
        return this.options.filter((option) => option.label.toLowerCase().includes(trimmed));
    }

    renderSuggestion(option: VersionOption, el: HTMLElement): void {
        el.createDiv({ text: option.label });
        if (option.publishedAt) {
            el.createEl("small", {
                text: new Date(option.publishedAt).toLocaleDateString(),
                cls: "obsync-suggestion-meta",
            });
        }
    }

    onChooseSuggestion(option: VersionOption): void {
        this.onChoose(option);
    }
}
