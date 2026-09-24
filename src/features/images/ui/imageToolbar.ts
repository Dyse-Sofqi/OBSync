import { TFile, setIcon, type App, type Plugin } from "obsidian";
import type { LocaleStrings } from "../../../core/i18n";

/**
 * 笔记内直接操作图片：阅读视图里给每张图挂一条悬浮工具条。
 *
 * ## 为什么用 Markdown 后处理器而不是编辑器扩展
 *
 * 「在笔记内直接对图片进行裁剪和压缩」这句要求落在两个可能的位置：编辑模式
 * （Live Preview，要写 CM6 扩展）与阅读视图（渲染后的 DOM）。选后者有三个理由：
 *
 * 1. **Live Preview 里图片常常是折叠的**（光标不在那一行时只显示链接），
 *    把按钮挂在一个可能不存在的元素上没有意义；
 * 2. 阅读视图的 DOM 是稳定的 `img`，而 CM6 的图片 widget 是 Obsidian 内部实现，
 *    没有公开的钩子 —— 挂上去要靠猜内部结构，版本一升级就断；
 * 3. 工具条只在**鼠标移到图片上**时出现，不占用阅读面积。
 *
 * 编辑模式的入口另外给：命令面板与文件右键菜单（见 `main.ts`），
 * 那两条路对两种模式都有效。
 *
 * ## 为什么工具条挂在 `img` 外面包一层，而不是绝对定位在 `img` 上
 *
 * 阅读视图里的 `img` 可能被 `<a>` 包着（点开大图）、也可能被 p 的样式影响。
 * 自己包一层 `<div class="obsync-image-wrap">` 就有了一个**自己可控的定位上下文**，
 * 不必去猜父元素是谁、有没有 `position`。
 */

export interface ImageToolbarDeps {
    app: App;
    getT(): LocaleStrings;
    /** 打开裁剪 / 压缩弹窗。 */
    openEditor(file: TFile): void;
    /** 复制这一张的公网地址。 */
    copyRemoteUrl(file: TFile): void;
}

/** 从渲染后的 `img` 上能读到的线索。 */
export interface ImageHints {
    src: string;
    alt: string;
    /** 外层 `<a>` 的 href / data-href（Obsidian 会把内部链接放在这里）。 */
    linkHref: string;
}

/** 带 scheme 的形状（`data:` / `app:` / `https:` / `blob:` / `obsidian:` …）。 */
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * 把线索整理成**候选链接路径**，按可信度排序。
 *
 * 为什么要一串候选：阅读视图里的 `src` 在不同平台/版本下长得不一样
 * （桌面端是 `app://<vaultId>/attachments/a.png`，移动端可能是别的形状），
 * 与其写一堆 if 去猜，不如把能当路径用的都列出来，由调用方逐个去 vault 里找。
 *
 * ## 两条归一规则，缺一条都会白跑一次查找
 *
 * 1. **每个线索都过一遍 `appUrlToPath`** —— 不只是 `src`。`<a href>` 在部分
 *    版本/主题下同样是 `app://<vaultId>/…` 的形状，不转换的话第一个（也是最
 *    可信的）候选是个 `app://` 字符串，必然落空。
 * 2. **带 scheme 的一律丢掉** —— `data:` 是内联图片（磁盘上没有对应文件），
 *    `https:` 是外链，`app://` 是 URL。它们都不是 vault 路径，而这里所有后续
 *    操作（裁剪、上传）都需要一个真实文件。留在候选里只会每次渲染都多跑一遍
 *    必然失败的查找。
 */
export function imageLinkCandidates(hints: ImageHints): string[] {
    const candidates: string[] = [];
    const push = (value: string): void => {
        const trimmed = stripQuery(value).trim();
        if (!trimmed) return;
        if (URL_SCHEME.test(trimmed)) return;
        if (!candidates.includes(trimmed)) candidates.push(trimmed);
    };

    // 1. 外层链接 —— 最可信，它就是笔记里写的那个链接目标。
    push(appUrlToPath(hints.linkHref));

    // 2. `alt`：wikilink 语法下 Obsidian 会把原始链接文本放进 alt。
    push(hints.alt);

    // 3. `src`（`app://…` 会被还原成 vault 路径，相对路径则原样保留）。
    push(appUrlToPath(hints.src));

    return candidates;
}

/** `app://<vaultId>/attachments/a.png?123` → `attachments/a.png`（URL 解码后）。 */
export function appUrlToPath(src: string): string {
    const match = /^app:\/\/[^/]*\/(.*)$/.exec(src);
    if (!match) return src;
    return safeDecode(match[1]);
}

function stripQuery(value: string): string {
    const index = value.indexOf("?");
    return index < 0 ? value : value.slice(0, index);
}

function safeDecode(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        // 路径里有落单的 `%` 时 decodeURIComponent 会抛 —— 那种情况下原样返回，
        // 让 vault 的查找去失败，比在这里抛异常好。
        return value;
    }
}

/**
 * 找到这张图对应的 vault 文件。
 *
 * 两条查找路径都试：先按路径直查（`src` 已经是 vault 相对路径时命中），
 * 再按链接解析（`alt` / href 是 `foo.png` 这种短链接时命中，要配合来源笔记
 * 才能定位）。返回 `null` 表示「这不是库里的文件」—— 外链图片就属于这一类，
 * 工具条不该挂上去。
 */
export function resolveImageFile(
    app: App,
    hints: ImageHints,
    sourcePath: string
): TFile | null {
    for (const candidate of imageLinkCandidates(hints)) {
        const direct = app.vault.getAbstractFileByPath(candidate);
        if (direct instanceof TFile) return direct;

        const resolved = app.metadataCache.getFirstLinkpathDest(candidate, sourcePath);
        if (resolved instanceof TFile) return resolved;
    }
    return null;
}

/** 从真实元素上读线索。 */
function readHints(img: HTMLImageElement): ImageHints {
    const link = img.closest("a");
    return {
        src: img.getAttribute("src") ?? "",
        alt: img.getAttribute("alt") ?? "",
        linkHref:
            link?.getAttribute("data-href") ??
            link?.getAttribute("href") ??
            "",
    };
}

/**
 * 注册后处理器：给阅读视图里的每张库内图片挂工具条。
 *
 * 幂等：Obsidian 在文档变化时会重跑后处理器，同一个 `img` 可能被处理多次 ——
 * 靠外层的 `obsync-image-wrap` 标记判断，避免叠出两条工具条。
 */
export function registerImageToolbar(plugin: Plugin, deps: ImageToolbarDeps): void {
    plugin.registerMarkdownPostProcessor((element, context) => {
        const images = Array.from(element.querySelectorAll("img"));
        for (const img of images) {
            attachToolbar(img, deps, context.sourcePath);
        }
    });
}

function attachToolbar(img: HTMLImageElement, deps: ImageToolbarDeps, sourcePath: string): void {
    const parent = img.parentElement;
    if (!parent) return;
    // 已经处理过（阅读视图重渲染 / 后处理器重跑）。
    if (parent.classList.contains("obsync-image-wrap")) return;

    const file = resolveImageFile(deps.app, readHints(img), sourcePath);
    if (!file) return;

    const t = deps.getT();

    // 走 Obsidian 的全局建节点入口（审核规则 `prefer-create-el`）：
    // `document.createElement` 建出来的节点属于主窗口的 document，
    // 在 popout window 里会插错地方。
    const wrap = createDiv({ cls: "obsync-image-wrap" });
    parent.insertBefore(wrap, img);
    wrap.appendChild(img);

    const tools = wrap.createDiv({ cls: "obsync-image-tools" });
    addTool(tools, "crop", t.images.toolbar.crop, () => deps.openEditor(file));
    addTool(tools, "link", t.images.toolbar.copyLink, () => deps.copyRemoteUrl(file));
}

/**
 * 工具条上的一个按钮。
 *
 * 用 `clickable-icon` 而不是普通 button：那是 Obsidian 自己的图标按钮类，
 * 悬停背景、尺寸、深浅主题下的对比度都跟着主题走 —— 自己写一套会在某些主题下
 * 变成看不见的白图标。
 */
function addTool(
    container: HTMLElement,
    icon: string,
    label: string,
    onClick: () => void
): void {
    const button = container.createEl("button", { cls: "clickable-icon" });
    button.setAttribute("aria-label", label);
    setIcon(button, icon);
    button.addEventListener("click", (event) => {
        // 阅读视图里的图片常被 `<a>` 包着（点开大图）—— 不拦下来的话
        // 点「裁剪」会顺带把大图打开。
        event.preventDefault();
        event.stopPropagation();
        onClick();
    });
}
