import { beforeEach, describe, expect, it } from "vitest";
import type { App } from "obsidian";
import { DiffModal, type DiffSection } from "../../src/features/sync/ui/DiffModal";
import type { FileDiff } from "../../src/features/sync/diff";
import { resetOpenedModals } from "../stubs/obsidian";
import { zhCN } from "../../src/core/i18n/locales/zh-cn";

/**
 * 差异弹窗。
 *
 * 这个弹窗是**只读旁路**，所以这里钉住的都是「说清了没有」而不是「做了什么」：
 * 二进制与纯重命名要说清它们各自是什么（一片空白会被读成「没有改动」）、
 * 截断要说出来（否则「只显示了前面一部分」看起来就是「改动只有这么多」）、
 * 读失败要留在弹窗里而不是变成一条错误提示。
 */

type ShimNode = {
    cls?: string;
    text?: string;
    attrs?: Record<string, string>;
    children?: ShimNode[];
};

/** 把一棵 shim 树上的文字按顺序拼起来。 */
function allText(node: ShimNode): string {
    const parts: string[] = [];
    if (node.text) parts.push(node.text);
    for (const child of node.children ?? []) parts.push(allText(child));
    return parts.join("\n");
}

function textDiff(overrides: Partial<FileDiff> = {}): FileDiff {
    return {
        path: "notes/a.md",
        kind: "text",
        hunks: [
            {
                header: "@@ -1,2 +1,2 @@",
                lines: [
                    { kind: "context", text: "上下文", oldLine: 1, newLine: 1 },
                    { kind: "del", text: "旧行", oldLine: 2, newLine: null },
                    { kind: "add", text: "新行", oldLine: null, newLine: 2 },
                ],
            },
        ],
        additions: 1,
        deletions: 1,
        truncated: false,
        ...overrides,
    };
}

function emptyDiff(path = "notes/a.md"): FileDiff {
    return { path, kind: "empty", hunks: [], additions: 0, deletions: 0, truncated: false };
}

async function openModal(sections: DiffSection[] | (() => Promise<DiffSection[]>)): Promise<ShimNode> {
    const modal = new DiffModal({} as App, {
        target: "notes/a.md",
        getT: () => zhCN,
        load: typeof sections === "function" ? sections : async () => sections,
    });
    modal.open();
    await flush();
    return modal.contentEl as unknown as ShimNode;
}

/** 让 `void this.render(body)` 这类不 await 的调用跑完。 */
async function flush(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
    resetOpenedModals();
});

describe("DiffModal", () => {
    it("按节渲染：节标题、文件路径、行号、增删行都在", async () => {
        const content = await openModal([
            { kind: "working", files: [textDiff()] },
            { kind: "staged", files: [emptyDiff()] },
        ]);

        const text = allText(content);

        expect(text).toContain(zhCN.sync.diff.section.working);
        expect(text).toContain("notes/a.md");
        expect(text).toContain("@@ -1,2 +1,2 @@");
        // 行首标记补回来了（`DiffLine.text` 刻意不含它）
        expect(text).toContain("+新行");
        expect(text).toContain("-旧行");
        // 两个行号列：删除行只有旧号，新增行只有新号
        expect(text).toContain("2");
        // 统计
        expect(text).toContain(zhCN.sync.diff.stats(1, 1));
    });

    it("空的那一节**整节不渲染**（一个只有标题的空节像没加载出来）", async () => {
        const content = await openModal([
            { kind: "working", files: [textDiff()] },
            { kind: "staged", files: [emptyDiff()] },
        ]);

        expect(allText(content)).not.toContain(zhCN.sync.diff.section.staged);
    });

    it("两节都有内容时两节都渲染（同一个文件可能两边都改了）", async () => {
        const content = await openModal([
            { kind: "working", files: [textDiff()] },
            { kind: "staged", files: [textDiff({ additions: 2 })] },
        ]);

        const text = allText(content);
        expect(text).toContain(zhCN.sync.diff.section.working);
        expect(text).toContain(zhCN.sync.diff.section.staged);
    });

    it("全空时说「没有可显示的差异」，而不是一片空白", async () => {
        const content = await openModal([{ kind: "working", files: [emptyDiff()] }]);

        expect(allText(content)).toContain(zhCN.sync.diff.noChanges);
    });

    it("二进制说清是二进制 —— 说成「没有差异」是错的（它确实改了）", async () => {
        const content = await openModal([
            {
                kind: "working",
                files: [textDiff({ kind: "binary", hunks: [], additions: 0, deletions: 0 })],
            },
        ]);

        const text = allText(content);
        expect(text).toContain(zhCN.sync.diff.binary);
        expect(text).not.toContain(zhCN.sync.diff.noChanges);
    });

    it("纯重命名：标题写出旧路径，并说明只是改了名字", async () => {
        const content = await openModal([
            {
                kind: "staged",
                files: [
                    textDiff({
                        path: "b.md",
                        previousPath: "a.md",
                        kind: "renamed",
                        hunks: [],
                        additions: 0,
                        deletions: 0,
                    }),
                ],
            },
        ]);

        const text = allText(content);
        expect(text).toContain("a.md → b.md");
        expect(text).toContain(zhCN.sync.diff.renamed);
    });

    it("太大而未读的文件要说出来", async () => {
        const content = await openModal([
            {
                kind: "working",
                files: [textDiff({ kind: "too-large", hunks: [], additions: 0, deletions: 0 })],
            },
        ]);

        expect(allText(content)).toContain(zhCN.sync.diff.tooLarge);
    });

    it("被截断时提示「只显示了前面一部分」", async () => {
        const content = await openModal([
            { kind: "working", files: [textDiff({ truncated: true })] },
        ]);

        expect(allText(content)).toContain(zhCN.sync.diff.truncated);
    });

    it("`\\ No newline` 标记渲染成 locale 文案，不是那句英文", async () => {
        const content = await openModal([
            {
                kind: "working",
                files: [
                    textDiff({
                        hunks: [
                            {
                                header: "@@ -1 +1 @@",
                                lines: [
                                    { kind: "add", text: "yz", oldLine: null, newLine: 1 },
                                    { kind: "no-newline", text: "", oldLine: null, newLine: null },
                                ],
                            },
                        ],
                    }),
                ],
            },
        ]);

        expect(allText(content)).toContain(zhCN.sync.diff.noNewline);
    });

    it("提交差异可以跨多个文件，各自一个标题", async () => {
        const content = await openModal([
            {
                kind: "commit",
                files: [textDiff({ path: "a.md" }), textDiff({ path: "b.md" })],
            },
        ]);

        const text = allText(content);
        expect(text).toContain(zhCN.sync.diff.section.commit);
        expect(text).toContain("a.md");
        expect(text).toContain("b.md");
    });

    it("读取失败在弹窗里说一句，**不往外抛**（它是个只读旁路）", async () => {
        const content = await openModal(async () => {
            throw new Error("git 挂了");
        });

        expect(allText(content)).toContain(zhCN.sync.diff.loadFailed);
    });

    it("标题上写着看的是哪个文件", async () => {
        const modal = new DiffModal({} as App, {
            target: "notes/a.md",
            getT: () => zhCN,
            load: async () => [],
        });
        modal.open();
        await flush();

        // Obsidian 的 HTMLElement 只有 `getText()`，没有 `.text`（替身记的是后者）
        expect((modal.titleEl as unknown as { text?: string }).text).toBe(
            zhCN.sync.diff.title
        );
        expect(allText(modal.contentEl as unknown as ShimNode)).toContain("notes/a.md");
    });

    it("内容还没读回来时先说「正在读取」", async () => {
        let release: (() => void) | undefined;
        const modal = new DiffModal({} as App, {
            target: "notes/a.md",
            getT: () => zhCN,
            load: () =>
                new Promise((resolve) => {
                    release = () => resolve([]);
                }),
        });
        modal.open();

        expect(allText(modal.contentEl as unknown as ShimNode)).toContain(
            zhCN.sync.diff.loading
        );

        release!();
        await flush();
    });

    it("弹窗关掉之后异步结果不再写回（不抛错）", async () => {
        let release: (() => void) | undefined;
        const modal = new DiffModal({} as App, {
            target: "notes/a.md",
            getT: () => zhCN,
            load: () =>
                new Promise((resolve) => {
                    release = () => resolve([{ kind: "working", files: [textDiff()] }]);
                }),
        });
        modal.open();
        modal.close();

        release!();
        await expect(flush()).resolves.toBeUndefined();
    });
});
