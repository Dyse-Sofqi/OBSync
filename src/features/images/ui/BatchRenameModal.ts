import { ButtonComponent, Modal, Setting, type App } from "obsidian";
import type { LocaleStrings } from "../../../core/i18n";
import {
    DEFAULT_RENAME_RULE,
    countRenameable,
    planRename,
    RENAME_PLACEHOLDERS,
    type RenamePlanEntry,
    type RenameRule,
} from "../batchRename";

/**
 * 批量重命名的规则弹窗。
 *
 * ## 为什么先给预览再给按钮
 *
 * 重命名会**改掉库里所有指向这些图片的链接**（`FileManager.renameFile` 的副作用，
 * 也正是必须走它、不能用 `adapter.rename` 的理由）。一个模板在二十张图上跑出来的
 * 结果不该等执行完才知道 —— 所以这里实时列出「旧 → 新」，并把不能执行的那几条
 * （重名、非法字符）当场标出来。
 *
 * 预览只列前若干条：它的用途是**校准规则**，不是逐条核对。真要逐条看，
 * 执行完列表里显示的就是新名字了。
 */

/** 预览最多列几条。 */
const MAX_PREVIEW = 8;

export interface BatchRenameModalDeps {
    /** 目标路径是否已被占用（由调用方查 vault）。 */
    exists(path: string): boolean;
    /** 用户确认后执行 —— 改名与云端同步都由调用方负责。 */
    onConfirm(entries: RenamePlanEntry[]): void | Promise<void>;
}

export class BatchRenameModal extends Modal {
    private rule: RenameRule = { ...DEFAULT_RENAME_RULE };
    private previewEl!: HTMLElement;
    private confirmButton!: ButtonComponent;

    constructor(
        app: App,
        private readonly t: LocaleStrings,
        private readonly paths: string[],
        private readonly deps: BatchRenameModalDeps
    ) {
        super(app);
    }

    onOpen(): void {
        const t = this.t.images.manager;
        this.titleEl.setText(t.renameTitle(this.paths.length));
        this.contentEl.createEl("p", {
            cls: "setting-item-description",
            text: t.renameDesc(RENAME_PLACEHOLDERS.join("  ")),
        });

        new Setting(this.contentEl)
            .setName(t.renameTemplate)
            .addText((text) =>
                text
                    .setPlaceholder(DEFAULT_RENAME_RULE.template)
                    .setValue(this.rule.template)
                    .onChange((value) => {
                        this.rule.template = value;
                        this.renderPreview();
                    })
            );

        new Setting(this.contentEl)
            .setName(t.renameStart)
            .addText((text) => {
                text.inputEl.type = "number";
                text.inputEl.min = "0";
                text.setValue(String(this.rule.start));
                text.onChange((value) => {
                    const parsed = Number.parseInt(value, 10);
                    this.rule.start = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
                    this.renderPreview();
                });
            });

        this.previewEl = this.contentEl.createDiv({ cls: "obsync-image-rename-preview" });

        new Setting(this.contentEl)
            .addButton((button) => button.setButtonText(t.renameCancel).onClick(() => this.close()))
            .addButton((button) => {
                this.confirmButton = button;
                button.setCta().onClick(() => {
                    // 只把能执行的交出去。不能执行的那几条在预览里已经标了原因，
                    // 让调用方再判一次会多出一份「什么算不能执行」的定义。
                    const entries = this.plan().filter((entry) => entry.problem === undefined);
                    this.close();
                    void this.deps.onConfirm(entries);
                });
            });

        this.renderPreview();
    }

    onClose(): void {
        this.contentEl.empty();
    }

    private plan(): RenamePlanEntry[] {
        return planRename(this.paths, this.rule, this.deps.exists);
    }

    private renderPreview(): void {
        const t = this.t.images.manager;
        const entries = this.plan();
        const renameable = countRenameable(entries);

        this.previewEl.empty();
        this.previewEl.createDiv({
            cls: "obsync-image-rename-count",
            text: t.renamePreviewCount(renameable, entries.length),
        });

        const list = this.previewEl.createEl("ul", { cls: "obsync-image-rename-list" });
        for (const entry of entries.slice(0, MAX_PREVIEW)) {
            const item = list.createEl("li", { cls: "obsync-image-rename-item" });
            item.createSpan({ text: entry.from });
            item.createSpan({ cls: "obsync-image-rename-arrow", text: "→" });
            item.createSpan({ text: entry.to });
            if (entry.problem) {
                item.createSpan({
                    cls: "obsync-image-rename-problem",
                    text: t.renameProblem[entry.problem],
                });
            }
        }
        if (entries.length > MAX_PREVIEW) {
            list.createEl("li", {
                cls: "obsync-image-rename-item",
                text: this.t.images.plan.more(entries.length - MAX_PREVIEW),
            });
        }

        this.confirmButton.setButtonText(t.renameConfirm(renameable));
        this.confirmButton.setDisabled(renameable === 0);
    }
}
