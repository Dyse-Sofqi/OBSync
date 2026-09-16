import { Modal, Setting, type App } from "obsidian";
import type { LocaleStrings } from "../../../core/i18n";
import { tryParseRepoRef } from "../../../host/repoRef";

/**
 * 编辑远端地址。
 *
 * ## 校验为什么是宽松的
 *
 * 同步本身是**纯 git 操作**（`git fetch/pull/push`），任何 git 能用的远端都该允许 ——
 * 自建 GitLab、内网 git 服务器、本地裸仓库、`file://` 路径都能同步。
 *
 * 早先这里用 `tryParseRepoRef` 做校验，等于**只接受 GitHub / Gitee**，
 * 结果是「一个完全可用的 git 远端被拒绝」，而提示语只说"无法识别该仓库地址"，
 * 用户根本不知道原因。现在改成：
 * - 明显写错的输入（带空格的句子等）→ 拦住
 * - 非 GitHub / Gitee 的合法远端 → 放行，但**提示**平台相关能力用不了
 *   （鉴权注入与「在远端打开」依赖平台识别）
 * - 留空 → 放行，这是合法操作（用户想暂时断开同步）
 */
export class EditRemoteModal extends Modal {
    private value: string;
    private hintEl!: HTMLElement;

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
                        this.updateHint();
                    });
                window.setTimeout(() => text.inputEl.focus(), 0);
            });

        this.hintEl = this.contentEl.createEl("p", { cls: "obsync-modal-warning" });
        this.updateHint();

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

    /** 随输入实时给出提示 —— 用户不必点保存才知道地址有问题。 */
    private updateHint(): void {
        const url = this.value.trim();
        if (!url || tryParseRepoRef(url)) {
            this.hintEl.setText("");
            return;
        }

        this.hintEl.setText(
            looksLikeGitRemote(url)
                ? this.t.sync.editRemoteNotGithubOrGitee
                : this.t.sync.editRemoteInvalid
        );
    }

    private async save(): Promise<void> {
        const url = this.value.trim();

        // 只拦明显写错的输入；能当 git 远端用的都放行。
        if (url && !looksLikeGitRemote(url)) return;

        await this.onSave(url);
        this.close();
    }
}

/**
 * 粗略判断「这看起来像一个 git 远端地址」。
 *
 * 刻意宽松 —— 这里不是要判断"能不能用"（那只有 git 自己知道），
 * 只是拦住明显写错的输入（比如把一句中文或带空格的话粘进来）。
 */
function looksLikeGitRemote(url: string): boolean {
    if (/\s/.test(url)) return false;
    return (
        // 带 scheme：https:// / http:// / ssh:// / git:// / file://
        /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ||
        // scp 形式：git@host:path
        /^[^@/\s]+@[^:/\s]+:.+$/.test(url) ||
        // Windows 绝对路径
        /^[A-Za-z]:[\\/]/.test(url) ||
        // POSIX 绝对路径 / 相对路径
        url.startsWith("/") ||
        url.startsWith("./") ||
        url.startsWith("../")
    );
}
