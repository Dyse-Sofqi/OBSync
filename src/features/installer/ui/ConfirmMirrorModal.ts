import { Modal, Setting, type App } from "obsidian";
import type { LocaleStrings } from "../../../core/i18n";
import { formatRepoId } from "../../../host/repoRef";
import { hostLabel } from "../downloadSource";
import type { TrackedItem } from "../types";
import { itemRepoRef } from "../types";
import type { RepoRef } from "../../../host/types";

/**
 * 「疑似镜像」的确认弹窗 —— **镜像被采用的唯一入口**。
 *
 * ## 为什么这一步必须是弹窗、而且必须写这么长的警告
 *
 * 判据只有一条：两边 manifest 的 `id` 相同。它证明「是同一个插件」，但**证明不了**
 * 「是同一份代码、同一个作者、跟得上源仓库」—— fork、或者别人拿着同一个 id 重新
 * 上传，都会通过这一条。而候选地址往往是**猜出来的**（同名 owner、或你 Gitee 账号
 * 名下的同名仓库），插件又是能读写整个库的代码。
 *
 * 所以这里不替用户做判断，只把判断需要的东西摆齐：**两个地址**（现在跟的是谁、
 * 想换成谁）、**判据有多弱**、**怎么自己核对**、以及**不改也不影响任何功能**。
 * 用户点「改用镜像」才算数。
 */
export class ConfirmMirrorModal extends Modal {
    constructor(
        app: App,
        private readonly t: LocaleStrings,
        private readonly tracked: TrackedItem,
        private readonly suggestion: RepoRef,
        private readonly onDecide: (useMirror: boolean) => void
    ) {
        super(app);
    }

    onOpen(): void {
        const t = this.t;
        const { contentEl } = this;
        this.titleEl.setText(t.installer.mirrorConfirmTitle);

        contentEl.createEl("p", {
            text: t.installer.mirrorConfirmDesc,
            cls: "setting-item-description",
        });

        const source = itemRepoRef(this.tracked);
        const list = contentEl.createEl("ul", { cls: "obsync-mirror-choices" });
        list.createEl("li", {
            text: t.installer.mirrorConfirmSource(hostLabel(t, source.host), formatRepoId(source)),
        });
        list.createEl("li", {
            text: t.installer.mirrorConfirmCandidate(
                hostLabel(t, this.suggestion.host),
                formatRepoId(this.suggestion)
            ),
            cls: "obsync-mirror-candidate",
        });

        // 警示：三条分开写（判据有多弱 / 绑错的代价 / 怎么自己核对），
        // 挤成一段会被跳过 —— 而这段文字是用户做判断的全部依据。
        const warning = contentEl.createDiv({ cls: "obsync-mirror-warning" });
        warning.createEl("p", { text: t.installer.mirrorWarnHeading, cls: "obsync-warning-heading" });
        warning.createEl("p", { text: t.installer.mirrorWarnChecks });
        warning.createEl("p", { text: t.installer.mirrorWarnRisk });
        warning.createEl("p", { text: t.installer.mirrorWarnHowTo });

        new Setting(contentEl)
            .addButton((button) =>
                button
                    .setButtonText(t.installer.mirrorConfirmKeep)
                    .onClick(() => {
                        this.onDecide(false);
                        this.close();
                    })
            )
            .addButton((button) =>
                button
                    .setButtonText(t.installer.mirrorConfirmUse(hostLabel(t, this.suggestion.host)))
                    .setCta()
                    .onClick(() => {
                        this.onDecide(true);
                        this.close();
                    })
            );
    }

    onClose(): void {
        this.contentEl.empty();
    }
}
