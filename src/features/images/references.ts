import type { App, TFile } from "obsidian";
import { excalidrawCandidates, excalidrawScene, excalidrawTexts } from "./excalidraw";
import { isImagePath } from "./imageScan";

/**
 * 「这张图片被谁引用了」——全库引用扫描。
 *
 * ## 立场：宁可多算，绝不漏算
 *
 * 这个结果只服务于一件事：判断一张图**还有没有人用**（进而决定它能不能被
 * 当成失联图片清理掉）。两种错的代价完全不对称：
 *
 * - 多算一次引用 → 这张图被认为「还在用」，于是少删一张。用户重新整理一遍即可。
 * - 漏算一次引用 → 在用的图被删掉，笔记里留下一个断链，而**云端副本可能也没了**。
 *
 * 所以这里所有解析路径都取**并集**：官方链接解析、库内绝对路径、按后缀匹配、
 * 按文件名匹配、按主干名匹配，能命中的全部记上；任何一步解析失败都退化成
 * 更宽松的匹配，而不是放弃。
 *
 * ## 覆盖的引用格式
 *
 * | 载体 | 形式 |
 * | --- | --- |
 * | Markdown | `![[a.png]]`、`![[a.png\|alt]]`、`[[a.png]]`、`![alt](a.png)`、`<img src="a.png">` |
 * | frontmatter | `cover: "[[a.png]]"`、`cover: assets/a.png`、数组与嵌套对象里的字符串 |
 * | Canvas | `{"type":"file","file":"a.png"}`、文本节点里的任意 markdown 链接 |
 * | Excalidraw | 场景里的 `fileId`、`files` 映射的键（场景被 LZString 压缩，见 `excalidraw.ts`） |
 * | 其他文本 | `.base` / `.html` / `.txt` 里的裸路径 |
 *
 * ## 为什么按「主干名」也匹配
 *
 * 两种真实写法都靠它：`![[a]]`（省略扩展名）与 Excalidraw 的 `fileId`
 * （插件把那一份存成 `<fileId>.<ext>`，而场景里只有 `<fileId>`）。
 * 少了这一条，画布里的图会全部被判成失联 —— 那正是最不能出错的场景。
 */

/** 会被读取并解析引用的文本载体。 */
const MARKDOWN_EXTENSION = "md";
const CANVAS_EXTENSION = "canvas";
const EXTRA_TEXT_EXTENSIONS = ["base", "excalidraw", "html", "htm", "txt"];

/** Excalidraw 把画布数据写在同名 `.excalidraw.md` 里，靠这个后缀认出来。 */
const EXCALIDRAW_SUFFIX = ".excalidraw.md";

/**
 * 额外文本载体的读取上限（字节）。
 *
 * `.md` 与 `.canvas` 不设限（它们是引用的一等公民，跳过一个就是漏算一堆图），
 * 其余载体超过这个大小就跳过 —— 那些通常是导出的 HTML 或日志，读它们要
 * 几百毫秒，而里面的图片引用概率极低。
 */
const MAX_EXTRA_TEXT_BYTES = 2_000_000;

/** Markdown 正文里的链接写法。四路取并集，重复命中同一个路径没有副作用。 */
const MARKDOWN_PATTERNS: RegExp[] = [
    // ![[path/to/a.png]] 或 ![[a.png|alt]]
    /!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g,
    // ![alt](path/to/a.png)
    /!\[[^\]]*\]\(([^)]+)\)/g,
    // <img src="path/to/a.png" …>
    /<img[^>]+src\s*=\s*["']([^"']+)["']/gi,
    // [[a.png]]（没有 `!` 的普通链接同样算引用）
    /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g,
];

/** Canvas JSON 解析失败时的兜底：直接按文本抓路径字段与图片扩展名字符串。 */
const CANVAS_RAW_PATTERNS: RegExp[] = [
    /"file"\s*:\s*"([^"]+)"/g,
    /"([^"]*\.(?:jpe?g|png|gif|svg|webp|avif|bmp))"/gi,
];

/** 无固定链接语法的载体：抓任意以图片扩展名结尾的路径片段。 */
const TEXT_PATH_PATTERNS: RegExp[] = [
    /([^\s"'()<>[\]]+\.(?:jpe?g|png|gif|svg|webp|avif|bmp))/gi,
];

/** 带 scheme（`http:` / `data:` / `app:` …）或 `//` 开头的地址。 */
const EXTERNAL_REF_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/** frontmatter 里裸路径写法的判据（`cover: assets/a.png`）。 */
const IMAGE_PATH_RE = /\.(?:jpe?g|png|gif|svg|webp|avif|bmp)$/i;

export interface ReferenceIndex {
    /** 图片的 vault 路径 → 引用它的来源文件路径（已去重、已排序）。 */
    refs: Map<string, string[]>;
    /** 实际读过的来源文件数 —— 界面上用来说明「扫了多少」。 */
    scanned: number;
}

/**
 * 扫描的可选项。
 *
 * 刻意**没有**「只扫受管文件夹之外的来源」这类裁剪选项：引用可以来自库里的
 * 任何角落（日记、模板、画布、`.base` 视图），按文件夹裁剪引用来源会直接
 * 导致漏算，而漏算就是误删。
 */
export interface ReferenceScanOptions {
    /** 每读完一个来源文件回调一次（长扫描的进度提示）。 */
    onProgress?: (done: number, total: number) => void;
}

/**
 * 扫描全库，得到「图片 → 引用它的文件」这张表。
 *
 * 只对**受管文件夹里的图片**返回结果吗？—— 不是。这里对所有图片都算，
 * 由调用方按需要筛选：引用信息本身与「哪些文件夹归 SyncHub 管」无关，
 * 提前裁剪只会让这个函数的用途变窄。
 */
export async function collectImageReferences(
    app: App,
    options: ReferenceScanOptions = {}
): Promise<ReferenceIndex> {
    const files = app.vault.getFiles();
    const index = buildFileIndex(files);

    /** 图片路径 → 引用它的来源（用 Set 去重，最后再排序）。 */
    const refs = new Map<string, Set<string>>();
    const record = (imagePath: string, sourcePath: string): void => {
        const existing = refs.get(imagePath);
        if (existing) existing.add(sourcePath);
        else refs.set(imagePath, new Set([sourcePath]));
    };

    const sources = files.filter((file) => isReferenceSource(file.extension.toLowerCase()));
    const total = sources.length;

    // 把「谁在扫、扫到哪儿、怎么记账」打包成一个上下文往下传。
    // 逐个当参数传的话，`collectXxx` 会各自长出一串与它职责无关的形参，
    // 而它们的**共同点**（都只关心「这一段文本里提到了哪张图」）会看不出来。
    const context: ScanContext = { app, index, record };

    for (let position = 0; position < total; position++) {
        const file = sources[position]!;
        const extension = file.extension.toLowerCase();

        // 超大文本载体跳过（见 MAX_EXTRA_TEXT_BYTES）。
        if (EXTRA_TEXT_EXTENSIONS.includes(extension) && file.stat.size > MAX_EXTRA_TEXT_BYTES) {
            options.onProgress?.(position + 1, total);
            continue;
        }

        try {
            const content = await app.vault.cachedRead(file);
            if (extension === CANVAS_EXTENSION) {
                collectCanvas(context, content, file.path);
            } else {
                collectFromText(context, content, file.path, MARKDOWN_PATTERNS);
                if (extension === MARKDOWN_EXTENSION) {
                    collectFrontmatter(context, file);
                    if (file.path.endsWith(EXCALIDRAW_SUFFIX)) {
                        collectExcalidraw(context, content, file.path);
                    }
                } else {
                    collectFromText(context, content, file.path, TEXT_PATH_PATTERNS);
                }
            }
        } catch {
            // 单个文件读不出来不该让整轮扫描失败 —— 后果只是这个文件的引用看不到。
        }

        options.onProgress?.(position + 1, total);
    }

    const sorted = new Map<string, string[]>();
    for (const [imagePath, sourcesSet] of refs) {
        sorted.set(imagePath, [...sourcesSet].sort());
    }
    return { refs: sorted, scanned: total };
}

/** 扫描过程中的公共依赖 —— 见 `collectImageReferences` 里的说明。 */
interface ScanContext {
    app: App;
    index: FileIndex;
    record: (imagePath: string, sourcePath: string) => void;
}

function isReferenceSource(extension: string): boolean {
    return (
        extension === MARKDOWN_EXTENSION ||
        extension === CANVAS_EXTENSION ||
        EXTRA_TEXT_EXTENSIONS.includes(extension)
    );
}

/**
 * 库内文件的查找索引。
 *
 * ## 为什么要有它
 *
 * 参考实现（MDRazor）对每个候选引用都遍历一遍全库文件做 `endsWith` / `name ===`。
 * 候选的数量与「库里的链接总数」同阶，于是复杂度是 O(链接数 × 文件数) ——
 * 几千张图的库上会明显卡住（那是同步面板的打开动作，用户就在等它）。
 *
 * 这里换成三张预建的 Map：按文件名、按主干名（不含扩展名）、按路径后缀
 * （在每一个 `/` 处切开）。查一次是 O(1)，代价是建表时遍历一遍所有图片的
 * 所有路径段 —— 那是 O(图片数 × 目录深度)，远小于原来的乘积。
 *
 * 只有**图片**进索引：这个索引的唯一用途是回答「这个候选指向哪张图」。
 */
interface FileIndex {
    /** 所有图片的 vault 路径。 */
    imagePaths: Set<string>;
    /** 文件名 → 图片路径（同名文件可能有多个，全部记上）。 */
    byName: Map<string, string[]>;
    /** 主干名（去掉最后一段扩展名）→ 图片路径。 */
    byStem: Map<string, string[]>;
    /** 路径后缀（`a/b/c.png` 的 `a/b/c.png` / `b/c.png` / `c.png`）→ 图片路径。 */
    bySuffix: Map<string, string[]>;
    /** 全部图片路径，`endsWith` 兜底扫描用。 */
    paths: string[];
}

function push(map: Map<string, string[]>, key: string, value: string): void {
    const existing = map.get(key);
    if (existing) {
        if (!existing.includes(value)) existing.push(value);
    } else {
        map.set(key, [value]);
    }
}

function buildFileIndex(files: TFile[]): FileIndex {
    const index: FileIndex = {
        imagePaths: new Set(),
        byName: new Map(),
        byStem: new Map(),
        bySuffix: new Map(),
        paths: [],
    };

    for (const file of files) {
        if (!isImagePath(file.path)) continue;
        index.imagePaths.add(file.path);
        index.paths.push(file.path);

        push(index.byName, file.name, file.path);
        push(index.byStem, file.basename, file.path);

        // 每一个 `/` 边界处的后缀。这样 `endsWith` 就是 O(1) 的查表，
        // 而且不会像裸 `endsWith` 那样把 `xassets/a.png` 也算命中
        // （那是个更宽的口子，见 matchReference 里的兜底）。
        const segments = file.path.split("/");
        for (let start = 0; start < segments.length; start++) {
            push(index.bySuffix, segments.slice(start).join("/"), file.path);
        }
    }
    return index;
}

/** 候选引用串 → 库内图片路径的归一化与匹配。 */
function matchReference(
    rawRef: string,
    sourcePath: string,
    context: ScanContext
): void {
    const { index, record, app } = context;
    // 去掉查询串与锚点（`a.png?w=100`、`a.png#page=2`），还原 JSON 里的转义斜杠。
    const ref = ((rawRef.split("?")[0] ?? "").split("#")[0] ?? "")
        .trim()
        .replace(/\\\//g, "/");
    if (!ref) return;

    /** 只在真的命中库内图片时记账 —— 否则 `refs` 里会塞满不存在的路径。 */
    const accept = (candidate: string): void => {
        if (index.imagePaths.has(candidate)) record(candidate, sourcePath);
    };

    const external = EXTERNAL_REF_RE.test(ref);

    // 一：官方链接解析。它才是「相对路径、子目录、同名文件的优先级」的正解，
    //     前导 `/`、`./`、省略扩展名这些写法它都处理得了。
    if (!external) {
        try {
            const dest = app.metadataCache.getFirstLinkpathDest(ref, sourcePath);
            if (dest) accept(dest.path);
        } catch {
            // 解析器抛错（畸形链接）—— 继续走下面的宽松匹配，不放弃。
        }
    }

    // 二：以 `/` 开头的库内绝对路径。
    if (ref.startsWith("/")) accept(ref.slice(1));

    // 三：含 `/` 的路径 —— 精确匹配、按 `/` 边界后缀匹配。
    if (ref.includes("/")) {
        accept(ref);
        const normalized = ref.replace(/^\.\//, "");
        accept(normalized);
        for (const candidate of index.bySuffix.get(normalized) ?? []) accept(candidate);
        for (const candidate of index.bySuffix.get(ref) ?? []) accept(candidate);
    }

    // 四：文件名匹配 —— `![[a.png]]` 这种最短写法靠它。
    accept(ref);
    for (const candidate of index.byName.get(ref) ?? []) accept(candidate);

    // 五：主干名匹配 —— `![[a]]` 与 Excalidraw 的 `fileId`（见文件头说明）。
    const basename = ref.split("/").pop() ?? ref;
    const stem = basename.replace(/\.[^./]+$/, "");
    for (const candidate of index.byStem.get(stem) ?? []) accept(candidate);

    // 六：裸 `endsWith` 兜底。**故意放在最后**：它最宽松（`xassets/a.png` 也命中），
    //     只有在前面全都落空时才跑，免得把一堆无关的路径都算成引用。
    if (ref.includes("/")) {
        const normalized = ref.replace(/^\.\//, "");
        for (const candidate of index.paths) {
            if (candidate.endsWith(normalized)) accept(candidate);
        }
    }
}

/** 用一组正则扫文本，逐个候选走匹配。 */
function collectFromText(
    context: ScanContext,
    content: string,
    sourcePath: string,
    patterns: RegExp[]
): void {
    for (const pattern of patterns) {
        // 模块级常量带 `g`，`lastIndex` 会跨文件残留 —— 每次用之前复位。
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(content)) !== null) {
            const captured = match[1];
            if (captured) matchReference(captured, sourcePath, context);
            // 零宽匹配会死循环。
            if (match.index === pattern.lastIndex) pattern.lastIndex++;
        }
    }
}

/** Canvas：解析 JSON 节点，失败则退化成纯文本扫描。 */
function collectCanvas(context: ScanContext, content: string, sourcePath: string): void {
    let document: { nodes?: unknown } | undefined;
    try {
        document = JSON.parse(content) as { nodes?: unknown };
    } catch {
        document = undefined;
    }

    const nodes = document?.nodes;
    if (!Array.isArray(nodes)) {
        // JSON 坏了 / 结构不对：按文本抓，宁可多算。
        collectFromText(context, content, sourcePath, MARKDOWN_PATTERNS);
        collectFromText(context, content, sourcePath, CANVAS_RAW_PATTERNS);
        return;
    }

    for (const rawNode of nodes) {
        if (!rawNode || typeof rawNode !== "object") continue;
        const node = rawNode as { type?: unknown; file?: unknown; text?: unknown };

        // 文件节点：可能是图片，也可能是笔记 —— 笔记路径记进来无害（它不会命中图片）。
        if (typeof node.file === "string") {
            matchReference(node.file, sourcePath, context);
        }
        // 文本节点：内部可能写着 `![[a.png]]` 或 `![](a.png)`。
        if (typeof node.text === "string") {
            collectFromText(context, node.text, sourcePath, MARKDOWN_PATTERNS);
        }
    }
}

/**
 * frontmatter 里的图片引用。
 *
 * 递归遍历字符串、数组与嵌套对象：属性面板写出来的结构化数据可能是
 * `cover: "[[a.png]]"`、`covers: [a.png, b.png]`、`meta: { image: a.png }`。
 */
function collectFrontmatter(context: ScanContext, file: TFile): void {
    let frontmatter: unknown;
    try {
        frontmatter = context.app.metadataCache.getFileCache(file)?.frontmatter;
    } catch {
        return;
    }
    if (!frontmatter) return;

    const visit = (value: unknown): void => {
        if (typeof value === "string") {
            const trimmed = value.trim();
            if (!trimmed) return;
            // 链接写法：交给通用提取（`[[…]]` / `](…)` 都在里面）。
            if (trimmed.includes("[[") || trimmed.includes("](")) {
                collectFromText(context, trimmed, file.path, MARKDOWN_PATTERNS);
            }
            // 裸路径写法：以图片扩展名结尾才当文件引用 —— 否则任何字符串
            // 都会被拿去匹配，`tags: [photo]` 这类会白跑一遍。
            if (IMAGE_PATH_RE.test(trimmed)) {
                matchReference(trimmed, file.path, context);
            }
            return;
        }
        if (Array.isArray(value)) {
            for (const item of value) visit(item);
            return;
        }
        if (value && typeof value === "object") {
            for (const item of Object.values(value)) visit(item);
        }
    };

    visit(frontmatter);
}

/** Excalidraw：解压场景，把 fileId / 路径候选与文本节点都过一遍匹配。 */
function collectExcalidraw(context: ScanContext, content: string, sourcePath: string): void {
    const scene = excalidrawScene(content);
    if (!scene) {
        // 解不开（数据坏了、或用了我们不认识的压缩方式）—— 退化成纯文本扫描。
        // 压缩载荷里通常搜不到东西，但正文的 Text Elements 区与 frontmatter 还在。
        collectFromText(context, content, sourcePath, MARKDOWN_PATTERNS);
        collectFromText(context, content, sourcePath, TEXT_PATH_PATTERNS);
        return;
    }

    // 文本节点里写的还是 markdown（`![[a.png]]`），要按 markdown 再解析一次 ——
    // 见 `excalidrawTexts` 关于「为什么它与 candidates 分开」的说明。
    for (const text of excalidrawTexts(scene)) {
        collectFromText(context, text, sourcePath, MARKDOWN_PATTERNS);
    }

    for (const candidate of excalidrawCandidates(scene)) {
        matchReference(candidate, sourcePath, context);
    }
}
