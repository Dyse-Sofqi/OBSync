import { Modal, Setting, type App } from "obsidian";
import type { LocaleStrings } from "../../../core/i18n";

/**
 * 「要不要连云端一起删」的确认弹窗 —— **云端删除的唯一入口**。
 *
 * ## 为什么删除要退回到「问一句」
 *
 * 这里原本实现的是双向删除同步：一边删了，另一边自动跟着删。它被去掉了，
 * 因为那个判断本质上做不准 —— 同一个「本地有、云端没有」既可能是「用户删了
 * 云端那份」也可能是「本地新增」，而清单丢失、或者用户在两台设备上各删一边时
 * 判断就会错，代价是**删掉一份用户没打算删的东西**。
 *
 * 改成问一句之后，判断的责任回到用户身上：他知道自己刚才删了什么、打算删到
 * 什么程度。插件只负责把「云端也有这一份」这个事实摆出来。
 *
 * ## 为什么必须写清「云端不可撤销」
 *
 * 本地那次删除多半还躺在 Obsidian 的回收站里（`fileManager.trashFile`），
 * 而 **R2 没有回收站** —— 删掉就是删掉。这个不对称如果不写出来，用户会按
 * 「本地删除」的经验去点这个按钮，而这里没有后悔药。
 */

/** 最多列几个文件名。删 200 张图时列全了既没人看，也会把弹窗撑爆。 */
const MAX_LISTED = 20;

export class ConfirmDeleteRemoteModal extends Modal {
    /**
     * 用户是否已经表过态。
     *
     * 用来区分「点了按钮」与「直接把弹窗关掉」（Esc / 点外面）——
     * 后者也要有一个决定，见 `onClose`。
     */
    private decided = false;

    constructor(
        app: App,
        private readonly t: LocaleStrings,
        private readonly paths: string[],
        private readonly onDecide: (deleteRemote: boolean) => void | Promise<void>
    ) {
        super(app);
    }

    onOpen(): void {
        const t = this.t.images.deleteRemote;
        const { contentEl } = this;

        this.titleEl.setText(t.title(this.paths.length));
        contentEl.createEl("p", { text: t.desc, cls: "setting-item-description" });

        const list = contentEl.createEl("ul", { cls: "obsync-diag-list" });
        for (const path of this.paths.slice(0, MAX_LISTED)) {
            list.createEl("li", { text: path });
        }
        if (this.paths.length > MAX_LISTED) {
            contentEl.createEl("p", {
                cls: "setting-item-description",
                text: t.more(this.paths.length - MAX_LISTED),
            });
        }

        const warning = contentEl.createDiv();
        warning.createEl("p", { text: t.warningHeading, cls: "obsync-warning-heading" });
        warning.createEl("p", { text: t.warning });

        new Setting(contentEl)
            .addButton((button) =>
                button.setButtonText(t.keep).onClick(() => this.decide(false))
            )
            .addButton((button) =>
                button
                    .setButtonText(t.delete)
                    // 危险动作用警示色，而不是主操作色 —— 主操作色在暗示
                    // 「点这个就对了」，而这里恰恰相反。
                    .setWarning()
                    .onClick(() => this.decide(true))
            );
    }

    onClose(): void {
        // 用户没表态就关掉了（Esc / 点外面）→ 按**保留云端副本**处理。
        //
        // 必须给出一个决定，而不是「什么都不做」：本地文件已经删了，不记下
        // 「这一份只留在云端」的话，下一轮同步会把它下载回来 ——
        // 看起来像「删除没生效」，而用户完全不知道为什么。
        // 保留是最保守的一档：错的代价是云端多一份，而不是少一份。
        if (!this.decided) {
            this.decided = true;
            void this.onDecide(false);
        }
        this.contentEl.empty();
    }

    private decide(deleteRemote: boolean): void {
        if (this.decided) return;
        this.decided = true;
        void this.onDecide(deleteRemote);
        this.close();
    }
}
