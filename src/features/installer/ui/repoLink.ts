import type { LocaleStrings } from "../../../core/i18n";
import { repoWebUrl } from "../../../host/repoRef";
import type { RepoRef } from "../../../host/types";

/**
 * 把一段仓库地址渲染成**可以点开的链接**。
 *
 * ## 为什么一定要能点
 *
 * 镜像确认页的**全部意义**就是让用户去核对那个地址 —— 判据只有「两边 manifest 的
 * `id` 相同」，它证明「是同一个插件」，证明不了「是同一份代码、同一个作者
 * 跟得上源仓库」。页面自己写的那句「核对方式：打开镜像仓库，看它的作者、主页或
 * README 是否指向源仓库」原来是一句**做不到的指示**：地址只是纯文本，用户得手抄
 * 或者复制粘贴到浏览器。在最需要「看一眼」的地方留了一道摩擦。
 *
 * ## 为什么是 `<a href>` 而不是自己接 onClick
 *
 * Obsidian 自己会把外链交给系统浏览器打开，参考项目也都这么做
 * （obsidian-git：`descEl.createEl("a", { text, href, attr: { target: "_blank" } })`）。
 * 用真正的锚点还顺带拿到两件事：**右键复制链接**、Tab 能聚焦。
 */
export function appendRepoLink(
    containerEl: HTMLElement,
    ref: RepoRef,
    text: string,
    t: LocaleStrings,
    cls?: string
): HTMLAnchorElement {
    return containerEl.createEl("a", {
        text,
        cls: cls ? `obsync-repo-link ${cls}` : "obsync-repo-link",
        // 地址与 target/rel 都写成**属性**（而不是 createEl 的顶层 `href` 选项）：
        // 落进 DOM 的结果一样，但这样测试替身也看得见 —— 否则「它到底指向哪里」
        // 这条最该被钉住的性质在单测里根本断言不了（替身只认 text/cls/attr）。
        attr: {
            href: repoWebUrl(ref),
            target: "_blank",
            rel: "noopener",
            // 悬停提示：光靠链接色不够明确（这里显示的是一串地址，不像"链接"）
            title: t.installer.openRepo,
        },
    });
}
