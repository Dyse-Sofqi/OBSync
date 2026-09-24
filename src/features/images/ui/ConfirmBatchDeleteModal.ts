import { Modal, Setting, type App } from "obsidian";
import type { LocaleStrings } from "../../../core/i18n";

/**
 * 图片管理面板里批量删除的确认弹窗。
 *
 * ## 与 `ConfirmDeleteRemoteModal` 的区别（别合并）
 *
 * 那个问的是「本地**已经**删了，云端那份怎么办」—— 它的前提是一个已经发生、
 * 不可撤销的动作。这个问的是「你点了删除，确认吗」—— 前提是什么都还没发生。
 * 两边的文案、后果与「取消」的含义都不同，合成一个会让两种场景都说不清。
 *
 * ## 为什么两种删除都要确认
 *
 * - 「本地 + 云端」是**不可撤销**的：R2 没有回收站，删掉就是删掉。
 * - 「仅删本地」虽然进回收站，但它会**同时记一条墓碑**（不然下一轮同步就把
 *   图补回来了），也就是「以后不会再同步到这台设备」。这个后果在按钮上
 *   看不出来，所以要在确认框里说清楚。
 */

export interface ConfirmBatchDeleteModalDeps {
    app: App;
    getT(): LocaleStrings;
    /** 要删的张数。 */
    count: number;
    /** 是否连云端一起删。 */
    remote: boolean;
    onConfirm(): void | Promise<void>;
}

export class ConfirmBatchDeleteModal extends Modal {
    constructor(private readonly deps: ConfirmBatchDeleteModalDeps) {
        super(deps.app);
    }

    onOpen(): void {
        const t = this.deps.getT().images.manager;
        const { count, remote } = this.deps;

        this.titleEl.setText(remote ? t.confirmBothTitle(count) : t.confirmLocalTitle(count));
        this.contentEl.createEl("p", {
            cls: "setting-item-description",
            text: remote ? t.confirmBothDesc : t.confirmLocalDesc,
        });

        if (remote) {
            const warning = this.contentEl.createDiv();
            warning.createEl("p", { text: t.confirmBothWarningHeading, cls: "obsync-warning-heading" });
            warning.createEl("p", { text: t.confirmBothWarning });
        }

        new Setting(this.contentEl)
            .addButton((button) =>
                button.setButtonText(t.confirmCancel).onClick(() => this.close())
            )
            .addButton((button) =>
                button
                    .setButtonText(remote ? t.confirmBothOk(count) : t.confirmLocalOk(count))
                    // 危险动作用警示色而不是主操作色：主操作色在暗示「点这个就对了」，
                    // 而这里恰恰相反。
                    .setWarning()
                    .onClick(() => {
                        this.close();
                        void this.deps.onConfirm();
                    })
            );
    }

    onClose(): void {
        // 关掉弹窗 = 取消。这里与 `ConfirmDeleteRemoteModal` 的「不表态也有决定」
        // 不同：那边本地文件**已经**删了，必须给出一个云端处置；这里什么都还没
        // 发生，「取消」就是它最自然的含义。
        this.contentEl.empty();
    }
}
