import { describe, expect, it } from "vitest";
import {
    buildAddedFileDiff,
    MAX_DIFF_LINES,
    parseUnifiedDiff,
} from "../../src/features/sync/diff";

/**
 * unified diff 解析。
 *
 * 下面的 fixture 全是 **git 2.55 的真实输出**（用 `git diff --no-color --no-ext-diff
 * -c core.quotePath=false …` 在临时仓库里跑出来的），不是手写的「标准格式」——
 * 手写的期望值会让两边一起错还照样绿，而这里错了用户看到的是**与文件对不上的
 * 行号**、或者一个空名字的条目。
 *
 * 覆盖的形态：
 * - 普通修改（上下文 + 增删混合，行号要分别推进）
 * - `\ No newline at end of file`（不推进任何一边的行号）
 * - `Binary files … differ`（**没有** `+++` 行，路径只能从这句里取）
 * - 纯重命名（只有 `similarity index` 与 `rename from/to`，一个 hunk 都没有）
 * - 中文与含空格的路径（`+++` 行末尾会多一个制表符）
 * - 单行 hunk（`@@ -0,0 +1 @@`，逗号后的计数被省略）
 */

const MODIFIED = [
    "diff --git a/a.txt b/a.txt",
    "index a3d0339..d8b961a 100644",
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -1,7 +1,8 @@",
    " line1",
    "-line2",
    "+CHANGED2",
    " line3",
    " line4",
    "+NEW",
    " line5",
    " line6",
    " line7",
].join("\n");

const NO_NEWLINE = [
    "diff --git a/d.txt b/d.txt",
    "index b77b4eb..1bc579e 100644",
    "--- a/d.txt",
    "+++ b/d.txt",
    "@@ -1,2 +1,2 @@",
    " x",
    "-y",
    "+yz",
    "\\ No newline at end of file",
].join("\n");

const BINARY = [
    "diff --git a/c.bin b/c.bin",
    "new file mode 100644",
    "index 0000000..0f49c4a",
    "Binary files /dev/null and b/c.bin differ",
].join("\n");

const PURE_RENAME = [
    "diff --git a/a.txt b/renamed.txt",
    "similarity index 100%",
    "rename from a.txt",
    "rename to renamed.txt",
].join("\n");

const CJK_PATH = [
    'diff --git a/中文 文件.md b/中文 文件.md',
    "new file mode 100644",
    "index 0000000..7898192",
    "--- /dev/null",
    "+++ b/中文 文件.md\t",
    "@@ -0,0 +1 @@",
    "+a",
].join("\n");

describe("parseUnifiedDiff", () => {
    it("空输入没有任何文件（「没有差异」由调用方表达）", () => {
        expect(parseUnifiedDiff("")).toEqual([]);
        expect(parseUnifiedDiff("\n")).toEqual([]);
    });

    it("普通修改：行号分别推进，增删计数正确", () => {
        const [file] = parseUnifiedDiff(MODIFIED);

        expect(file!.path).toBe("a.txt");
        expect(file!.kind).toBe("text");
        expect(file!.additions).toBe(2);
        expect(file!.deletions).toBe(1);
        expect(file!.truncated).toBe(false);
        expect(file!.hunks).toHaveLength(1);
        expect(file!.hunks[0]!.header).toBe("@@ -1,7 +1,8 @@");

        // 逐行核对：上下文两边都推进，删除只推进旧行号，新增只推进新行号。
        expect(file!.hunks[0]!.lines.map((line) => [line.kind, line.text, line.oldLine, line.newLine]))
            .toEqual([
                ["context", "line1", 1, 1],
                ["del", "line2", 2, null],
                ["add", "CHANGED2", null, 2],
                ["context", "line3", 3, 3],
                ["context", "line4", 4, 4],
                ["add", "NEW", null, 5],
                ["context", "line5", 5, 6],
                ["context", "line6", 6, 7],
                ["context", "line7", 7, 8],
            ]);
    });

    it("`\\ No newline` 标记不占任何一边的行号", () => {
        const [file] = parseUnifiedDiff(NO_NEWLINE);
        const last = file!.hunks[0]!.lines.at(-1)!;

        expect(last.kind).toBe("no-newline");
        // 文本为空：那句英文由展示层按 kind 换成 locale 文案，不在这里透传
        expect(last.text).toBe("");
        expect(last.oldLine).toBeNull();
        expect(last.newLine).toBeNull();
        // 它没有被算成新增行
        expect(file!.additions).toBe(1);
    });

    it("二进制：从 `Binary files … differ` 里取路径（这一段没有 `+++` 行）", () => {
        const [file] = parseUnifiedDiff(BINARY);

        expect(file!.kind).toBe("binary");
        expect(file!.path).toBe("c.bin");
        expect(file!.hunks).toEqual([]);
    });

    it("纯重命名单独一档 —— 说成「没有差异」会让用户以为面板坏了", () => {
        const [file] = parseUnifiedDiff(PURE_RENAME);

        expect(file!.kind).toBe("renamed");
        expect(file!.path).toBe("renamed.txt");
        expect(file!.previousPath).toBe("a.txt");
    });

    it("中文 + 含空格的路径：剥掉 `b/` 前缀与结尾的制表符", () => {
        const [file] = parseUnifiedDiff(CJK_PATH);

        // 制表符不剥的话，「点开这个文件」在库里会找不到东西
        expect(file!.path).toBe("中文 文件.md");
        // 新增文件不记旧路径（`--- /dev/null` 不是路径）
        expect(file!.previousPath).toBeUndefined();
        expect(file!.hunks[0]!.lines).toEqual([
            { kind: "add", text: "a", oldLine: null, newLine: 1 },
        ]);
    });

    it("多文件：一个提交里几个文件就返回几段", () => {
        const files = parseUnifiedDiff([MODIFIED, BINARY].join("\n"));

        expect(files.map((file) => file.path)).toEqual(["a.txt", "c.bin"]);
        expect(files.map((file) => file.kind)).toEqual(["text", "binary"]);
    });

    /**
     * 内容以 `-- ` / `++ ` 开头的行，增删之后**与文件头长得一模一样**。
     *
     * 下面这份是真实输出（一个 Markdown 文件里的 `-- 旧的分隔线` 被换成
     * `++ 新的分隔线`）。按行首字符串判断段落头而不看「是否已经在 hunk 里」，
     * 这两行会被当成 `--- a/a.md` / `+++ b/a.md` 吞掉 —— 界面上少两行，
     * 而用户对着文件数行号会发现对不上。
     */
    it("内容本身以 `-- ` / `++ ` 开头时不会被当成文件头", () => {
        const raw = [
            "diff --git a/a.md b/a.md",
            "index 84ac6ce..833aef5 100644",
            "--- a/a.md",
            "+++ b/a.md",
            "@@ -1,2 +1,2 @@",
            "--- 旧的分隔线",
            "+++ 新的分隔线",
            " 正常一行",
        ].join("\n");

        const [file] = parseUnifiedDiff(raw);

        expect(file!.path).toBe("a.md");
        expect(file!.additions).toBe(1);
        expect(file!.deletions).toBe(1);
        expect(file!.hunks[0]!.lines).toEqual([
            { kind: "del", text: "-- 旧的分隔线", oldLine: 1, newLine: null },
            { kind: "add", text: "++ 新的分隔线", oldLine: null, newLine: 1 },
            { kind: "context", text: "正常一行", oldLine: 2, newLine: 2 },
        ]);
    });

    it("段落头（index / mode / similarity）不产出任何行", () => {
        const [file] = parseUnifiedDiff(MODIFIED);

        // 只有 hunk 里那 9 行 —— `index` / `---` / `+++` 都没有变成行
        expect(file!.hunks[0]!.lines).toHaveLength(9);
    });

    it("超过行数上限时截断，并**说出来**（而不是显示成「没有差异」）", () => {
        const body = Array.from({ length: MAX_DIFF_LINES + 200 }, (_, index) => `+line${index}`);
        const raw = [
            "diff --git a/big.txt b/big.txt",
            "--- /dev/null",
            "+++ b/big.txt",
            `@@ -0,0 +1,${body.length} @@`,
            ...body,
        ].join("\n");

        const [file] = parseUnifiedDiff(raw);

        expect(file!.truncated).toBe(true);
        expect(file!.kind).toBe("text");
        expect(file!.hunks[0]!.lines).toHaveLength(MAX_DIFF_LINES);
        // 截断了也仍然是一个**有差异**的文件（早先的写法在这里会一个文件都不给）
        expect(file!.additions).toBe(MAX_DIFF_LINES);
    });

    it("超长输入不会一个文件都解析不出来", () => {
        // 4MB 字符上限：用一行超长内容顶过去，确认仍然拿得到文件与截断标记
        const raw = [
            "diff --git a/huge.txt b/huge.txt",
            "--- a/huge.txt",
            "+++ b/huge.txt",
            "@@ -1 +1 @@",
            `+${"x".repeat(5 * 1024 * 1024)}`,
        ].join("\n");

        const [file] = parseUnifiedDiff(raw);

        expect(file).toBeDefined();
        expect(file!.path).toBe("huge.txt");
        expect(file!.truncated).toBe(true);
    });
});

describe("buildAddedFileDiff", () => {
    it("未跟踪文件的内容全部算新增", () => {
        const diff = buildAddedFileDiff("新笔记.md", "第一行\n第二行\n");

        expect(diff.kind).toBe("text");
        expect(diff.additions).toBe(2);
        expect(diff.deletions).toBe(0);
        expect(diff.hunks[0]!.header).toBe("@@ -0,0 +1,2 @@");
        expect(diff.hunks[0]!.lines).toEqual([
            { kind: "add", text: "第一行", oldLine: null, newLine: 1 },
            { kind: "add", text: "第二行", oldLine: null, newLine: 2 },
        ]);
    });

    it("末尾的换行不算一行（否则每个文件都多一行空行）", () => {
        expect(buildAddedFileDiff("a.md", "只有一行\n").additions).toBe(1);
        expect(buildAddedFileDiff("a.md", "只有一行").additions).toBe(1);
    });

    it("空文件是「没有差异」而不是「一个空的新增块」", () => {
        expect(buildAddedFileDiff("a.md", "").kind).toBe("empty");
    });

    it("只有换行的文件是「一行空行」，不是空文件", () => {
        // git 对「内容只有一个换行」的新文件给的是 `@@ -0,0 +1 @@` + 一个 `+` ——
        // 这里必须与它一致，否则同一个文件从「未跟踪」变成「已暂存」之后
        // 界面上会突然多出一行。
        const diff = buildAddedFileDiff("a.md", "\n");

        expect(diff.kind).toBe("text");
        expect(diff.additions).toBe(1);
        expect(diff.hunks[0]!.lines[0]!.text).toBe("");
    });

    it("CRLF 换行不留下尾随的 \\r", () => {
        const diff = buildAddedFileDiff("a.md", "第一行\r\n第二行\r\n");

        expect(diff.hunks[0]!.lines.map((line) => line.text)).toEqual(["第一行", "第二行"]);
    });

    it("太长的文件截断并标记", () => {
        const content = Array.from({ length: MAX_DIFF_LINES + 10 }, (_, index) => `l${index}`).join(
            "\n"
        );
        const diff = buildAddedFileDiff("big.md", content);

        expect(diff.truncated).toBe(true);
        expect(diff.additions).toBe(MAX_DIFF_LINES);
    });
});
