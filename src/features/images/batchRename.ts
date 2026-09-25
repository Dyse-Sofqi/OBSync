import { extensionOf } from "./imageScan";

/**
 * 批量重命名的命名规则（**纯计算**，不碰 vault）。
 *
 * ## 模板而不是「前缀 / 后缀 / 替换」三件套
 *
 * 一个模板串能表达那三件套的全部组合，而且用户一眼能看出结果长什么样：
 *
 * | 模板 | `photos/日落.png` 会变成 |
 * | --- | --- |
 * | `{name}-{n}` | `日落-1.png` |
 * | `img-{n}` | `img-1.png` |
 * | `{date}-{name}` | `20260923-日落.png` |
 * | `{name}-压缩.{ext}` | `日落-压缩.png` |
 *
 * `{n}` 会按这一批的**总数自动补零**（12 张 → `01`…`12`），因为补零是批量
 * 重命名里最容易忘、又最影响排序的一步（`img-10` 排在 `img-2` 前面）。
 *
 * ## 扩展名：不写 `{ext}` 就自动沿用原扩展名
 *
 * 上面第一、二、三行的模板都没有 `{ext}`，结果却带着 `.png` —— 这是刻意的。
 * 要求用户每次都写 `{name}-{n}.{ext}` 是纯粹的负担，而**忘写**的后果很严重：
 * 产出一批没有扩展名的文件，Obsidian 不再把它们当图片，笔记里的嵌入全坏。
 *
 * 反过来，**模板里明确写出的扩展名必须与原扩展名一致**，否则整条标成
 * `extChanged` 跳过。理由：重命名不改内容，`a.png` 改成 `a.webp` 会得到一个
 * 扩展名与实际编码不符的文件（能存、能同步，但打不开）。真要换容器请在
 * 单张的裁剪 / 压缩弹窗里做 —— 那里会真的重新编码。
 *
 * ## 未知的占位符原样保留
 *
 * 写错成 `{nama}` 时留一个字面量 `{nama}` 在文件名里，用户立刻看得见；
 * 替换成空串的话会静默产出一批名字对不上预期的文件，而重命名是**会改掉
 * 库里所有链接**的动作 —— 那种「改完才发现不对」的成本太高了。
 */

/** 模板里可用的占位符。 */
export const RENAME_PLACEHOLDERS = ["{name}", "{n}", "{ext}", "{date}"] as const;

/** 默认模板：原名后面加序号 —— 不改语义，只是让同名文件能共存。 */
export const DEFAULT_RENAME_TEMPLATE = "{name}-{n}";

/** Obsidian（以及大多数文件系统）不允许出现在文件名里的字符。 */
const FORBIDDEN_CHARS = /[\\/:*?"<>|]/;

export interface RenameRule {
    /** 模板串。空串视为非法。 */
    template: string;
    /** `{n}` 的起始序号。 */
    start: number;
}

export const DEFAULT_RENAME_RULE: RenameRule = {
    template: DEFAULT_RENAME_TEMPLATE,
    start: 1,
};

export type RenameProblem =
    /** 算出来的名字与原名一样 —— 没什么可做。 */
    | "unchanged"
    /** 目标名含非法字符、或模板为空导致名字为空。 */
    | "invalid"
    /** 目标路径已经被占了（含「目标正是同批里的另一个文件」）。 */
    | "taken"
    /**
     * 模板把扩展名改掉了。
     *
     * 重命名不改内容，所以 `a.png` → `a.webp` 只会得到一个「扩展名与实际编码
     * 不符」的文件：能存、能同步，但打不开，而且看起来一切正常。
     */
    | "extChanged";

export interface RenamePlanEntry {
    from: string;
    to: string;
    /** 有值时这条不会被执行，`problem` 说明原因。 */
    problem?: RenameProblem;
}

/** 同一目录下的新文件名。目录不变（见文件头：链接是按相对路径解析的）。 */
function directoryOf(path: string): string {
    const slash = path.lastIndexOf("/");
    return slash < 0 ? "" : path.slice(0, slash + 1);
}

/**
 * 路径里的文件名部分（**含**扩展名）。
 *
 * 导出是给单文件重命名弹窗用的：它要把「现在叫什么」预填进输入框，
 * 而那个框里放的是文件名、不是整条路径（目录不由用户决定）。
 */
export function fileNameOf(path: string): string {
    const slash = path.lastIndexOf("/");
    return slash < 0 ? path : path.slice(slash + 1);
}

function stemOf(path: string): string {
    const name = fileNameOf(path);
    const dot = name.lastIndexOf(".");
    // `index <= 0`：点开头的文件名（`.hidden`）没有主干名，整段就是名字。
    return dot <= 0 ? name : name.slice(0, dot);
}

function formatDate(now: Date): string {
    const pad = (value: number): string => String(value).padStart(2, "0");
    return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
}

/**
 * 按规则算出这一批的新名字。
 *
 * `exists` 用来判「目标已被占用」。**只读、不改** —— 真正的改名由调用方
 * 走 `FileManager.renameFile`（它才会顺带更新笔记里的链接）。
 */
export function planRename(
    paths: string[],
    rule: RenameRule,
    exists: (path: string) => boolean,
    now: Date = new Date()
): RenamePlanEntry[] {
    const total = paths.length;
    const last = rule.start + Math.max(0, total - 1);
    // 补零宽度取最后一个序号的位数：12 张 → 2 位；100 张 → 3 位。
    const width = String(Math.max(rule.start, last)).length;
    const date = formatDate(now);

    return paths.map((from, index) => {
        const sequence = String(rule.start + index).padStart(width, "0");
        const extension = extensionOf(from);
        const rendered = rule.template
            .split("{name}")
            .join(stemOf(from))
            .split("{ext}")
            .join(extension)
            .split("{date}")
            .join(date)
            .split("{n}")
            .join(sequence);

        const trimmed = rendered.trim();
        if (!trimmed) return { from, to: from, problem: "invalid" as const };
        if (FORBIDDEN_CHARS.test(trimmed)) return { from, to: from, problem: "invalid" as const };

        // 模板没给扩展名就沿用原扩展名（见文件头：忘写 `{ext}` 的后果很严重）。
        // 原文件本来就没有扩展名时（`.hidden`）什么都不补 —— 否则会拼出一个
        // 以点结尾的名字（`.hidden-x.`）。
        const hasExtension = extensionOf(trimmed) !== "";
        const name = hasExtension || extension === "" ? trimmed : `${trimmed}.${extension}`;
        if (extensionOf(name).toLowerCase() !== extension.toLowerCase()) {
            return { from, to: from, problem: "extChanged" as const };
        }

        const to = `${directoryOf(from)}${name}`;
        if (to === from) return { from, to, problem: "unchanged" as const };
        // 目标被占用就跳过。**不做「链式改名」**（A→B 同时 B→C）：那要靠执行
        // 顺序才能正确，而顺序在批量操作里没有天然的答案 —— 猜错的代价是
        // 覆盖掉一个文件。目标正是同批里的另一个文件时也算占用（`exists` 为真）。
        if (exists(to)) return { from, to, problem: "taken" as const };

        return { from, to };
    });
}

/** 这一批里实际会被改名的条数。界面上的按钮文案用它。 */
export function countRenameable(entries: RenamePlanEntry[]): number {
    return entries.filter((entry) => entry.problem === undefined).length;
}

/**
 * 单个文件的重命名：用户直接给出新文件名，而不是套一条模板。
 *
 * ## 为什么另起一个函数，而不是「把这一张塞进 `planRename`」
 *
 * 模板是为**一批**设计的：`{n}` 要按总数补零、`{name}` 要逐个替换，
 * 而这些对单个文件只会产出用户没要过的名字 —— 对一张图跑默认模板会得到
 * `日落-1.png`。用户在这里的心智是「把这张图改叫 `日落-沙滩.png`」，
 * 那件事本来就只需要一次输入。
 *
 * ## 但判据必须共用
 *
 * `RenameProblem` 的四种失败（名字没变 / 非法 / 撞车 / 换了扩展名）在两条
 * 路径上的含义完全一样，文案也是同一份（`renameProblem`）。所以这里只换
 * 「新名字怎么来」，后面照抄 `planRename` 的判据**顺序** —— 顺序也有意义：
 * 「名字没变」要排在「目标被占用」前面，否则把 `a.png` 改叫 `a.png` 会被
 * 报成撞车（它确实「占用」了自己），而那句提示会把用户指错方向。
 *
 * ## 扩展名的两种写法都接受
 *
 * 输入 `日落` 与输入 `日落.png` 结果相同 —— 前者自动补上原扩展名。理由与
 * 模板路径一致（见文件头）：忘写扩展名会产出一个 Obsidian 不再当图片的
 * 文件，而用户输入时不会想到这件事。反过来，**写出的扩展名必须与原扩展名
 * 一致**，`a.png` → `a.webp` 照样标 `extChanged` —— 重命名不改内容，真要换
 * 容器得去编辑弹窗里真的重新编码。
 *
 * 名字里的 `/` 与 `\` 由 `FORBIDDEN_CHARS` 挡下，这同时保证了目录不变。
 */
export function planSingleRename(
    from: string,
    name: string,
    exists: (path: string) => boolean
): RenamePlanEntry {
    const trimmed = name.trim();
    if (!trimmed || FORBIDDEN_CHARS.test(trimmed)) return { from, to: from, problem: "invalid" };

    const extension = extensionOf(from);
    const hasExtension = extensionOf(trimmed) !== "";
    const target = hasExtension || extension === "" ? trimmed : `${trimmed}.${extension}`;
    if (extensionOf(target).toLowerCase() !== extension.toLowerCase()) {
        return { from, to: from, problem: "extChanged" };
    }

    const to = `${directoryOf(from)}${target}`;
    if (to === from) return { from, to, problem: "unchanged" };
    if (exists(to)) return { from, to, problem: "taken" };

    return { from, to };
}
