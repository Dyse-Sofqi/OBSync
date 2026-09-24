/**
 * unified diff 的解析（纯函数，单独可测）。
 *
 * ## 为什么要有这一层
 *
 * git 吐出来的是**文本**，而界面要的是「这一行是新增还是删除、它对应原文第几行」。
 * 把解析抽成纯函数，就能拿**真实 git 的输出**当 fixture 直接测 —— 行号推进、
 * `\ No newline at end of file` 标记、`Binary files … differ`、纯重命名段落
 * 这些细节读代码看不出来，而它们错了用户看到的是**与文件对不上的行号**。
 * （正则都是拿 git 2.55 的真实输出校准的，见 `tests/features/diff.test.ts`。）
 *
 * ## 输出里没有一句文案
 *
 * `kind` 全是类型码（`"add"` / `"binary"` / `"too-large"` …），展示层按类型码取
 * locale 文案 —— 与错误处理、诊断报告同一套约定。所以这个模块不依赖 i18n，
 * 也不依赖 DOM，能单独测。
 */

/** 一行的类型。 */
export type DiffLineKind =
    | "context"
    /** 新增行（`+`）。 */
    | "add"
    /** 删除行（`-`）。 */
    | "del"
    /** git 的 `\ No newline at end of file` 标记 —— 它不属于任何一边的内容。 */
    | "no-newline";

export interface DiffLine {
    kind: DiffLineKind;
    /** 行内容，**不含**行首的 `+` / `-` / 空格标记。 */
    text: string;
    /** 旧文件里的行号（新增行为 null）。 */
    oldLine: number | null;
    /** 新文件里的行号（删除行为 null）。 */
    newLine: number | null;
}

export interface DiffHunk {
    /** `@@ -12,7 +12,8 @@` 原文（可能带 git 追加的函数上下文）。 */
    header: string;
    lines: DiffLine[];
}

/**
 * 一个文件的差异形态。
 *
 * 分成这么几档而不是「有没有内容」两档，是因为**每一档要跟用户说的话不一样**：
 * 「没有差异」与「这是个二进制文件」与「只改了名字」在界面上都不该显示成一片空白。
 */
export type FileDiffKind =
    /** 有内容改动。 */
    | "text"
    /** 没有差异（或只有模式变化这类不进 hunk 的东西）。 */
    | "empty"
    /** git 判定为二进制，不给内容。 */
    | "binary"
    /** 只改了名字，内容一字未动。 */
    | "renamed"
    /** 太大，为免把界面拖死而没解析。 */
    | "too-large";

export interface FileDiff {
    /** 新路径（删除的文件是旧路径）。 */
    path: string;
    /** 重命名 / 删除时的旧路径。 */
    previousPath?: string;
    kind: FileDiffKind;
    hunks: DiffHunk[];
    additions: number;
    deletions: number;
    /** 命中行数上限，后面还有内容没解析出来。 */
    truncated: boolean;
}

/**
 * 一次解析最多保留多少行。
 *
 * 界面上每行都是一个 DOM 节点，而「一个 8000 行的笔记被整体重排」这种 diff
 * 是真实存在的。不设上限的话，打开差异会把 Obsidian 卡住 —— 那比「显示不全」
 * 糟得多，所以宁可有损并**明说被截断了**（见 `truncated`）。
 */
export const MAX_DIFF_LINES = 3000;

/**
 * 解析前的字符数上限。
 *
 * 行数上限要在**切完行**之后才生效，而先切一个几十 MB 的字符串本身就很贵。
 * 所以先按字符数砍一刀（砍在行中间没关系 —— 这一份已经标记为截断）。
 */
const MAX_DIFF_CHARS = 4 * 1024 * 1024;

/**
 * 未跟踪文件的差异上限（字节）。
 *
 * 未跟踪文件 git 不产出 diff，只能把内容读出来当成「全部新增」——
 * 而库里放一个几十 MB 的日志/数据文件是常事，读进来会把设置页卡住。
 * 超过这个大小就说「太大」，而不是硬渲染。
 */
export const MAX_UNTRACKED_DIFF_BYTES = 256 * 1024;

/** `@@ -12,7 +12,8 @@`。逗号后的计数可以省略（单行 hunk：`@@ -0,0 +1 @@`）。 */
const HUNK_HEADER_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** 解析过程中可变的那一份（`kind` 要等整个段落读完才知道）。 */
interface MutableFile {
    path: string;
    previousPath?: string;
    binary: boolean;
    hunks: DiffHunk[];
    additions: number;
    deletions: number;
}

/**
 * 把 `git diff` 的原文切成一个个文件。
 *
 * 一个文件都没有（空字符串）时返回空数组 —— 「没有差异」由调用方表达，
 * 不在这里编一个假的文件出来。
 */
export function parseUnifiedDiff(raw: string): FileDiff[] {
    const inputCapped = raw.length > MAX_DIFF_CHARS;
    const text = inputCapped ? raw.slice(0, MAX_DIFF_CHARS) : raw;

    const files: FileDiff[] = [];
    let current: MutableFile | undefined;
    let hunk: DiffHunk | undefined;
    let oldLine = 0;
    let newLine = 0;
    let lineBudget = MAX_DIFF_LINES;
    /**
     * 只在**真的砍掉了内容**时置真，而且只影响当时正在读的那一段。
     *
     * 早先的写法把「输入超长」直接当成初始值，于是它一进来就 `break`，
     * 结果是**一个文件都没解析出来** —— 界面上显示成「没有差异」，
     * 恰好把「内容太多没显示完」说成了「什么都没变」。
     */
    let truncated = false;
    /**
     * 这一段落里有没有出现过 hunk。
     *
     * 段落头（`---` / `+++` / `rename from` / `Binary files …`）**只出现在第一个
     * hunk 之前**，而 hunk 内部的行只可能是 `+` / `-` / 空格 / `\` 开头 ——
     * 所以「见过 hunk 了」就等于「后面这些行都是内容」。
     *
     * 这个守卫不是洁癖：删掉一行内容为 `-- x` 的文本会产出 `--- x`，
     * 与文件头长得一模一样。不守的话那一行删除会被当成段落头吞掉，
     * 界面上就少一行 —— 而用户对着文件数行号会发现对不上。
     */
    let sawHunk = false;

    const closeHunk = (): void => {
        if (!hunk || !current) return;
        current.hunks.push(hunk);
        hunk = undefined;
    };

    const closeFile = (): void => {
        closeHunk();
        if (!current) return;
        files.push({
            path: current.path,
            previousPath: current.previousPath,
            kind: classify(current),
            hunks: current.hunks,
            additions: current.additions,
            deletions: current.deletions,
            truncated,
        });
        current = undefined;
    };

    for (const line of text.split(/\r\n|\r|\n/)) {
        if (line.startsWith("diff --git ")) {
            closeFile();
            current = {
                // 路径优先从 `---` / `+++` / `rename to` 上取（见下面几处），
                // 这里只做兜底 —— `diff --git a/x b/y` 在文件名含空格时是有歧义的。
                path: pathFromDiffGit(line) ?? "",
                binary: false,
                hunks: [],
                additions: 0,
                deletions: 0,
            };
            sawHunk = false;
            continue;
        }
        if (!current) continue;

        // 段落头只在第一个 hunk 之前出现，理由见 `sawHunk` 的说明。
        if (!sawHunk) {
            if (line.startsWith("Binary files ")) {
                // `Binary files /dev/null and b/c.bin differ` —— 这一段没有 `+++` 行，
                // 路径只能从这里取（否则界面上会是一个空名字的条目）。
                current.binary = true;
                const renamed = pathFromBinaryLine(line);
                if (renamed) current.path = renamed;
                continue;
            }

            if (line.startsWith("--- ")) {
                const previous = stripDiffPath(line.slice(4));
                // 新增文件这里是 `/dev/null`：那不是「旧路径」，别记进去。
                if (previous) current.previousPath = previous;
                continue;
            }
            if (line.startsWith("+++ ")) {
                const path = stripDiffPath(line.slice(4));
                // 删除文件这里是 `/dev/null` —— 保留 `---` 给的旧路径。
                if (path) current.path = path;
                continue;
            }

            if (line.startsWith("rename to ")) {
                current.path = stripDiffPath(line.slice("rename to ".length)) ?? current.path;
                continue;
            }
            if (line.startsWith("rename from ")) {
                current.previousPath =
                    stripDiffPath(line.slice("rename from ".length)) ?? current.previousPath;
                continue;
            }
        }

        const header = HUNK_HEADER_RE.exec(line);
        if (header) {
            closeHunk();
            oldLine = Number.parseInt(header[1], 10);
            newLine = Number.parseInt(header[2], 10);
            hunk = { header: line, lines: [] };
            sawHunk = true;
            continue;
        }

        if (!hunk) continue; // 段落头（index / mode / similarity index …），不展示

        if (lineBudget <= 0) {
            truncated = true;
            break;
        }

        const first = line[0];
        if (first === "+") {
            hunk.lines.push({ kind: "add", text: line.slice(1), oldLine: null, newLine });
            current.additions += 1;
            newLine += 1;
        } else if (first === "-") {
            hunk.lines.push({ kind: "del", text: line.slice(1), oldLine, newLine: null });
            current.deletions += 1;
            oldLine += 1;
        } else if (first === "\\") {
            // `\ No newline at end of file`：不是内容，行号也不推进。
            hunk.lines.push({ kind: "no-newline", text: "", oldLine: null, newLine: null });
        } else {
            // 上下文行（以空格开头）。空串也当上下文 —— 有些工具会把那一格删掉。
            hunk.lines.push({
                kind: "context",
                text: first === " " ? line.slice(1) : line,
                oldLine,
                newLine,
            });
            oldLine += 1;
            newLine += 1;
        }
        lineBudget -= 1;
    }

    closeFile();
    // 输入被字符上限砍过：最后那一段是残的（上面的 `closeFile` 读的是那一刻的
    // `truncated`，而字符上限要到循环自然结束才知道）。
    if (inputCapped && files.length > 0) files[files.length - 1].truncated = true;
    return files;
}

/**
 * 把一个**未跟踪**文件的内容变成「全部新增」的差异。
 *
 * git 对未跟踪文件不产出任何 diff，而库里的新笔记恰恰是最想看一眼的那一类。
 * 内容是调用方读出来的（这里不碰文件系统，保持纯函数）。
 */
export function buildAddedFileDiff(path: string, content: string): FileDiff {
    // 末尾那个换行不是一行内容 —— 不剥掉的话每个文件都会多出一行空行。
    const lines = content.replace(/\r\n|\r/g, "\n").split("\n");
    if (lines[lines.length - 1] === "") lines.pop();

    const empty = (kind: FileDiffKind): FileDiff => ({
        path,
        kind,
        hunks: [],
        additions: 0,
        deletions: 0,
        truncated: false,
    });

    if (lines.length === 0) return empty("empty");

    const truncated = lines.length > MAX_DIFF_LINES;
    const kept = truncated ? lines.slice(0, MAX_DIFF_LINES) : lines;

    return {
        path,
        kind: "text",
        hunks: [
            {
                header: `@@ -0,0 +1,${kept.length} @@`,
                lines: kept.map((text, index) => ({
                    kind: "add" as const,
                    text,
                    oldLine: null,
                    newLine: index + 1,
                })),
            },
        ],
        additions: kept.length,
        deletions: 0,
        truncated,
    };
}

/** 段落读完才知道它属于哪一档。 */
function classify(file: MutableFile): FileDiffKind {
    if (file.binary) return "binary";
    if (file.hunks.length === 0) {
        // 没有 hunk 又带着旧路径 = 纯重命名（git 只给 similarity index 与
        // rename from/to）。把它说成「没有差异」会让用户以为面板坏了。
        return file.previousPath && file.previousPath !== file.path ? "renamed" : "empty";
    }
    return "text";
}

/**
 * 剥掉 diff 头里的路径装饰：`a/` `b/` 前缀、结尾的制表符、`/dev/null`。
 *
 * 结尾那个制表符是 git 加的（路径含空格时用它分隔），**必须剥掉** ——
 * 带上去会让「点开这个文件」在库里找不到东西。
 */
function stripDiffPath(rawPath: string): string | undefined {
    let value = rawPath.replace(/\t.*$/, "").trim();
    if (!value || value === "/dev/null") return undefined;

    // `core.quotePath` 为真时非 ASCII 路径会被引号包住并转义成八进制
    // （`"a/\344\270\255.md"`）。我们调用 git 时已经强制关掉它，
    // 这里只是防御：宁可留一串转义字符，也不要显示成带引号的路径。
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);

    if (value.startsWith("a/") || value.startsWith("b/")) value = value.slice(2);
    return value || undefined;
}

/** `Binary files a/x and b/y differ` → `y`。 */
function pathFromBinaryLine(line: string): string | undefined {
    const match = /^Binary files (.+) and (.+) differ$/.exec(line);
    return match ? stripDiffPath(match[2]) : undefined;
}

/**
 * `diff --git a/x b/y` → `y`（兜底用）。
 *
 * 只在 `+++` / `rename to` / `Binary files` 都给不出路径时才走到这里，
 * 所以拆得粗一点没关系：按 ` b/` 切最后一次，文件名里恰好含 ` b/` 的极端情况
 * 才可能错，而那种情况下前三个来源本来就会先命中。
 */
function pathFromDiffGit(line: string): string | undefined {
    const rest = line.slice("diff --git ".length);
    const index = rest.lastIndexOf(" b/");
    if (index < 0) return stripDiffPath(rest);
    return stripDiffPath(rest.slice(index + 1));
}
