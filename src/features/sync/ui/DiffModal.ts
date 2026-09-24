import { Modal, type App } from "obsidian";
import type { LocaleStrings } from "../../../core/i18n";
import type { DiffLine, FileDiff } from "../diff";

/**
 * 差异视图。
 *
 * ## 为什么是弹窗而不是又一个侧边栏面板
 *
 * 侧边栏面板（`SourceControlView`）是**入口**：它窄、常驻、要一眼扫完「哪些文件
 * 变了」。而 diff 是**展开看细节**：行很长、要看行号、看完就关。两件事的形态
 * 相反 —— 把 diff 塞进侧边栏，每行都得横向滚动，而那正好把「看差异」这件事
 * 变回「看不了」。
 *
 * 所以：面板上每一行给一个入口，点开在这个弹窗里看。弹窗还顺带绕开了另一个
 * 麻烦 —— 视图类型要写进用户的 `workspace.json`，多一个就多一份持久化状态。
 *
 * ## 为什么一次显示两节（工作区 / 已暂存）
 *
 * 同一个文件完全可能**两边都有改动**（`git status` 里的 `MM`）。只显示一边
 * 就等于把另一半藏起来，而用户点开差异的意图恰恰是「我到底改了什么」。
 * 两节都列出来，各自为空就各自不出现。
 *
 * ## 只读
 *
 * 这个弹窗不做任何写操作：不暂存、不还原、不改文件。它的存在意义是让用户在
 * **动手之前**看清内容 —— 与「冲突不替你决定」是同一条设计原则。
 */

/** 一节差异是哪两个东西在比。用类型码而不是文案 —— 展示层按它取 locale。 */
export type DiffSectionKind = "working" | "staged" | "commit";

export interface DiffSection {
    kind: DiffSectionKind;
    files: FileDiff[];
}

export interface DiffModalOptions {
    /** 被查看的对象：文件路径，或提交的短 hash。 */
    target: string;
    /**
     * **每次渲染时取**文案，不要传 `t` 本身。
     *
     * 弹窗可能开着的时候用户切了语言，而它比一次性的确认框活得久
     * （`EditRemoteModal` 用的是快照，那是它短命；这里跟着全项目的约定走）。
     */
    getT: () => LocaleStrings;
    /**
     * 拉取内容。
     *
     * 失败**不往外抛**：弹窗是个只读旁路，读不出差异不该变成一个错误提示条
     * （用户在面板上点的是「看差异」，不是「执行什么」）—— 在弹窗里说清就行。
     */
    load: () => Promise<DiffSection[]>;
}

export class DiffModal extends Modal {
    /** 关闭后异步渲染的结果不再写回（节点已经摘掉了）。 */
    private closed = false;

    constructor(
        app: App,
        private readonly options: DiffModalOptions
    ) {
        super(app);
    }

    onOpen(): void {
        const t = this.options.getT();
        this.titleEl.setText(t.sync.diff.title);
        // 弹窗默认宽度是按「一两个设置项」定的，而 diff 的行很长 ——
        // 不撑开就只能横向滚动（见 styles.css 里的 .obsync-diff-modal）。
        this.modalEl.addClass("obsync-diff-modal");

        this.contentEl.createDiv({ cls: "obsync-diff-target", text: this.options.target });

        const body = this.contentEl.createDiv({ cls: "obsync-diff-body" });
        body.createEl("p", { cls: "obsync-diff-message", text: t.sync.diff.loading });
        void this.render(body);
    }

    onClose(): void {
        this.closed = true;
        this.contentEl.empty();
    }

    private async render(body: HTMLElement): Promise<void> {
        const t = this.options.getT();

        let sections: DiffSection[];
        try {
            sections = await this.options.load();
        } catch {
            if (this.closed) return;
            body.empty();
            body.createEl("p", { cls: "obsync-diff-message", text: t.sync.diff.loadFailed });
            return;
        }
        if (this.closed) return;

        // 空段落（`kind === "empty"`）不渲染：它不代表任何改动。
        // 一节里一个可见文件都没有时，整节也不渲染 —— 一个只有标题的空节
        // 看起来像「这一节没加载出来」。
        const visible = sections
            .map((section) => ({
                kind: section.kind,
                files: section.files.filter((file) => file.kind !== "empty"),
            }))
            .filter((section) => section.files.length > 0);

        body.empty();
        if (visible.length === 0) {
            body.createEl("p", { cls: "obsync-diff-message", text: t.sync.diff.noChanges });
            return;
        }

        for (const section of visible) {
            const box = body.createDiv({ cls: "obsync-diff-section" });
            box.createDiv({
                cls: "obsync-diff-section-heading",
                // 直接按下标取：与 `diagnoseCheck[check.id]` 同一套写法。
                text: t.sync.diff.section[section.kind],
            });
            for (const file of section.files) this.renderFile(box, file);
        }
    }

    private renderFile(container: HTMLElement, file: FileDiff): void {
        const t = this.options.getT();
        const box = container.createDiv({ cls: "obsync-diff-file" });

        const heading = box.createDiv({ cls: "obsync-diff-file-heading" });
        // 重命名时把旧路径也写出来 —— 只显示新名字的话，用户会以为这是一个
        // 全新的文件（那是完全不同的结论）。
        heading.createSpan({
            text: file.previousPath ? `${file.previousPath} → ${file.path}` : file.path,
        });
        if (file.kind === "text") {
            heading.createSpan({
                cls: "obsync-diff-stats",
                text: t.sync.diff.stats(file.additions, file.deletions),
            });
        }

        if (file.kind !== "text") {
            box.createEl("p", { cls: "obsync-diff-message", text: messageFor(file, t) });
            return;
        }

        for (const hunk of file.hunks) {
            const hunkEl = box.createDiv({ cls: "obsync-diff-hunk" });
            hunkEl.createDiv({ cls: "obsync-diff-hunk-header", text: hunk.header });
            for (const line of hunk.lines) this.renderLine(hunkEl, line, t);
        }

        // 截断必须**说出来**：不说的话「只显示了前 3000 行」看起来就是
        // 「这个文件的改动只有这么多」，那是两个完全不同的结论。
        if (file.truncated) {
            box.createEl("p", { cls: "obsync-diff-message", text: t.sync.diff.truncated });
        }
    }

    private renderLine(container: HTMLElement, line: DiffLine, t: LocaleStrings): void {
        if (line.kind === "no-newline") {
            container.createDiv({ cls: "obsync-diff-line-note", text: t.sync.diff.noNewline });
            return;
        }

        // 类名写成显式字面量、再拼成字符串：模板串拼出来的类名 `scripts/checks.mjs`
        // 扫不到（它只能看见 `obsync-diff-line-`），会被报成「定义了没用到」。
        const classes = ["obsync-diff-line"];
        if (line.kind === "add") classes.push("obsync-diff-line-add");
        if (line.kind === "del") classes.push("obsync-diff-line-del");
        const row = container.createDiv({ cls: classes.join(" ") });

        // 两个行号列：删掉的行只有旧号，新增的行只有新号，上下文行两个都有。
        row.createSpan({
            cls: "obsync-diff-lineno",
            text: line.oldLine === null ? "" : String(line.oldLine),
        });
        row.createSpan({
            cls: "obsync-diff-lineno",
            text: line.newLine === null ? "" : String(line.newLine),
        });

        // 行首标记补回来（`DiffLine.text` 刻意不含它，好让调用方自己决定怎么画）。
        // 空上下文行也要占一个空格 —— 否则 `white-space: pre` 下它看起来像没有这一行。
        const marker = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
        row.createSpan({ cls: "obsync-diff-text", text: `${marker}${line.text}` });
    }
}

/** 非文本差异各说各的 —— 一片空白会被读成「没有改动」。 */
function messageFor(file: FileDiff, t: LocaleStrings): string {
    switch (file.kind) {
        case "binary":
            return t.sync.diff.binary;
        case "renamed":
            return t.sync.diff.renamed;
        case "too-large":
            return t.sync.diff.tooLarge;
        case "empty":
        case "text":
            return t.sync.diff.noChanges;
    }
}
