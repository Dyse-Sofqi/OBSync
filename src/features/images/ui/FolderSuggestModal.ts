import { SuggestModal, type App } from "obsidian";
import type { LocaleStrings } from "../../../core/i18n";
import { isInsideFolders } from "../imageScan";

/**
 * 选择器里的一项。
 *
 * `path` 是**归一之后**的 vault 相对路径（空串 = 整个库）—— 回调直接把
 * 它并进 `images.folders`，那边存的也是归一后的形状（见 `normalizeFolder`）。
 */
interface FolderOption {
    path: string;
    /** 主文案：根目录是「仓库根目录（整个库）」，其余就是路径本身。 */
    label: string;
    /** 是否已经落在受管范围里（被更外层文件夹覆盖也算）。 */
    included: boolean;
    /** 搜索用的小写文本。 */
    searchText: string;
}

/**
 * 受管图片文件夹的选择器。
 *
 * ## 为什么不是一个输入框加个按钮
 *
 * 这个列表决定「插件能动哪些文件」，而手打路径的错法 —— `/attachments/`、
 * `assets//img`、根本不存在的目录 —— **全都没有任何提示**：表现是「填了却一个
 * 文件都不动」或者悄悄多管了一片。从库里现成的文件夹里选，这些错法一次性消失。
 *
 * 根目录（= 仓库文件夹，空串表示整个库）也在列表里，而且排在最前：它正是
 * 默认值，也是这个插件最常用的范围。
 *
 * 与 `VersionSuggestModal` 同一形状：扁平列表 + 搜索。不画树 —— 侧边栏里的
 * 文件管理器已经是一棵树，这里要的是「快」，不是「再画一遍」。
 */
export class FolderSuggestModal extends SuggestModal<FolderOption> {
    constructor(
        app: App,
        private readonly t: LocaleStrings,
        /** 当前已受管的文件夹（归一后的形状），用来标注「已包含」。 */
        private readonly managed: string[],
        private readonly onChoose: (folder: string) => void
    ) {
        super(app);
        this.setPlaceholder(t.settings.images.folderPickerPlaceholder);
    }

    getSuggestions(query: string): FolderOption[] {
        const options = this.buildOptions();
        const trimmed = query.trim().toLowerCase();
        if (!trimmed) return options;
        return options.filter((option) => option.searchText.includes(trimmed));
    }

    renderSuggestion(option: FolderOption, el: HTMLElement): void {
        el.createDiv({ text: option.label });
        // 「已包含」要说出来：否则用户在一个已经受管的库里挑来挑去，
        // 会以为每次选择都改变了范围，而实际上什么都没有发生。
        if (option.included) {
            el.createEl("small", {
                text: this.t.settings.images.folderPickerIncluded,
                cls: "obsync-suggestion-meta",
            });
        }
    }

    onChooseSuggestion(option: FolderOption): void {
        this.onChoose(option.path);
    }

    private buildOptions(): FolderOption[] {
        const rootLabel = this.t.settings.images.folderPickerRoot;
        const root: FolderOption = {
            path: "",
            label: rootLabel,
            // 空串路径正好问「整个库在不在受管范围里」—— isInsideFolders 的语义
            // 对空串也成立（`""` 在 `["attachments"]` 里是 false，在 `[""]` 里是 true）。
            included: isInsideFolders("", this.managed),
            // 带上 `.`：这一格自己的说明文字写的是「填 . 表示整个库」，
            // 用户照着打一个点要能搜到它。
            searchText: `${rootLabel.toLowerCase()} .`,
        };

        const folders = this.app.vault
            .getAllFolders()
            // 排序让列表稳定：getAllFolders 的顺序跟建目录的先后有关，
            // 每次打开都换一副面孔会让人以为选错了东西。
            .map((folder) => folder.path)
            .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
            .map<FolderOption>((path) => ({
                path,
                label: path,
                included: isInsideFolders(path, this.managed),
                searchText: path.toLowerCase(),
            }));

        return [root, ...folders];
    }
}
