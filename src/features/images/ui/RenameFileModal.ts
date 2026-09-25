import { ButtonComponent, Modal, Setting, type App } from "obsidian";
import type { LocaleStrings } from "../../../core/i18n";
import { fileNameOf, planSingleRename, type RenamePlanEntry } from "../batchRename";

/**
 * 单个文件的重命名弹窗。
 *
 * ## 为什么与 `BatchRenameModal` 分开（别合并）
 *
 * 那个是「一批文件 + 一条模板」，这个是「一个文件 + 一个新名字」。合并会
 * 让两边都变差：模板框对单个文件是多余的负担（用户想改的是一个具体的名字），
 * 而「直接输入名字」在批量场景里根本没法表达 —— 二十张图不可能各输一次。
 * 共用的是**判据与文案**（`planSingleRename` + `renameProblem`），不是界面。
 *
 * ## 为什么仍然先给预览
 *
 * 与批量同一个理由：改名会**改掉库里所有指向它的链接**（`FileManager.renameFile`
 * 的副作用，也正是必须走它、不能用 `adapter.rename` 的理由），而这件事在按钮上
 * 看不出来。这里还多一层：用户输入的是**文件名**而不是完整路径，「目录不变」
 * 得让他当场看见 —— 否则他可能以为自己正在把文件挪到别处。
 *
 * 输入框预填**当前文件名**并全选：多数改名是在原名上改一点，预填 + 全选比
 * 对着空框重新敲一遍快，而全选让「整个换掉」也只需直接输入。
 */

export interface RenameFileModalDeps {
    /** 目标路径是否已被占用（由调用方查 vault）。 */
    exists(path: string): boolean;
    /** 用户确认后执行 —— 改名与云端同步都由调用方负责。 */
    onConfirm(entry: RenamePlanEntry): void | Promise<void>;
}

export class RenameFileModal extends Modal {
    private name: string;
    private previewEl!: HTMLElement;
    private confirmButton!: ButtonComponent;

    constructor(
        app: App,
        private readonly t: LocaleStrings,
        private readonly path: string,
        private readonly deps: RenameFileModalDeps
    ) {
        super(app);
        this.name = fileNameOf(path);
    }

    onOpen(): void {
        const t = this.t.images.manager;
        this.titleEl.setText(t.renameFileTitle);
        this.contentEl.createEl("p", {
            cls: "setting-item-description",
            text: t.renameFileDesc,
        });

        new Setting(this.contentEl)
            .setName(t.renameFileName)
            .addText((text) => {
                text.setValue(this.name).onChange((value) => {
                    this.name = value;
                    this.renderPreview();
                });
                // 全选而不是把光标放到末尾：改名的常见形态是「整段换掉」或
                // 「改后半截」，前者全选后直接输入，后者按一下左箭头即可。
                text.inputEl.select();
            });

        this.previewEl = this.contentEl.createDiv({ cls: "obsync-image-rename-preview" });

        new Setting(this.contentEl)
            .addButton((button) => button.setButtonText(t.renameCancel).onClick(() => this.close()))
            .addButton((button) => {
                this.confirmButton = button;
                button.setButtonText(t.renameFileConfirm).setCta().onClick(() => {
                    const entry = this.plan();
                    // 不能执行的条目按钮本来就是灰的，这里再判一次是为了
                    // 「回车 / 别的路径进来」这类不经过点击的情形 —— 判据只有
                    // `planSingleRename` 一份，多判一次不会多出一份定义。
                    if (entry.problem) return;
                    this.close();
                    void this.deps.onConfirm(entry);
                });
            });

        this.renderPreview();
    }

    onClose(): void {
        this.contentEl.empty();
    }

    private plan(): RenamePlanEntry {
        // 包一层箭头函数再传：直接把 `this.deps.exists` 当值递出去会丢掉 `this`
        // （`@typescript-eslint/unbound-method` 报的就是这个）。
        return planSingleRename(this.path, this.name, (target) => this.deps.exists(target));
    }

    private renderPreview(): void {
        const t = this.t.images.manager;
        const entry = this.plan();

        this.previewEl.empty();
        const item = this.previewEl.createDiv({ cls: "obsync-image-rename-item" });
        item.createSpan({ text: entry.from });
        item.createSpan({ cls: "obsync-image-rename-arrow", text: "→" });
        item.createSpan({ text: entry.to });
        if (entry.problem) {
            item.createSpan({
                cls: "obsync-image-rename-problem",
                text: t.renameProblem[entry.problem],
            });
        }

        this.confirmButton.setDisabled(entry.problem !== undefined);
    }
}
