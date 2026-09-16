import { Modal, Setting, type App } from "obsidian";
import type { LocaleStrings } from "../../../core/i18n";
import { tryParseRepoRef } from "../../../host/repoRef";

/**
 * 编辑远端地址。
 *
 * 输入时做一次「能不能解析」的前置校验（复用 installer 的解析器），
 * 但允许留空保存 —— 「清空远端」是合法操作（用户想暂时断开同步）。
 */
export class EditRemoteModal extends Modal {
    private value: string;

    constructor(
        app: App,
        current: string | undefined,
        private readonly t: LocaleStrings,
        private readonly onSave: (url: string) => Promise<void>
    ) {
        super(app);
        this.value = current ?? "";
    }

    onOpen(): void {
        this.titleEl.setText(this.t.sync.editRemoteTitle);

        new Setting(this.contentEl)
            .setName(this.t.sync.editRemoteLabel)
            .addText((text) => {
                text.setPlaceholder(this.t.sync.editRemotePlaceholder)
                    .setValue(this.value)
                    .onChange((value) => {
                        this.value = value;
                    });
                window.setTimeout(() => text.inputEl.focus(), 0);
            });

        new Setting(this.contentEl).addButton((button) =>
            button
                .setButtonText(this.t.common.save)
                .setCta()
                .onClick(() => {
                    void this.save();
                })
        );
    }

    onClose(): void {
        this.contentEl.empty();
    }

    private async save(): Promise<void> {
        const url = this.value.trim();
        // 留空 = 清空远端；非空必须是能解析的 GitHub/Gitee 地址。
        if (url && !tryParseRepoRef(url)) {
            this.contentEl.createEl("p", {
                text: this.t.sync.editRemoteInvalid,
                cls: "obsync-modal-warning",
            });
            return;
        }

        await this.onSave(url);
        this.close();
    }
}
