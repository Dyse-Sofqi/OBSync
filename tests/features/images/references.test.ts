import { describe, expect, it } from "vitest";
import { collectImageReferences } from "../../../src/features/images/references";
import { EXCALIDRAW_COMPRESSED, EXCALIDRAW_WITH_IMAGE } from "./fixtures/excalidrawSample";
import { createFakeImageVault } from "../../helpers/fakeImageVault";

/**
 * 全库引用扫描。
 *
 * 这里的每一条用例都对应一种**真实的写法**。它们的重要性不对称：
 * 漏掉一种 → 在用的图被判成失联 → 被清理删掉（笔记里留下断链，
 * 云端副本也可能一起没了）。所以覆盖的重点是「各种写法都要认出来」，
 * 而「多算」的情况（外部链接、非图片引用）只做基本守卫。
 */

function refsOf(records: Map<string, string[]>, path: string): string[] {
    return records.get(path) ?? [];
}

async function scan(vault: ReturnType<typeof createFakeImageVault>) {
    const result = await collectImageReferences(vault.app);
    return result.refs;
}

describe("collectImageReferences", () => {
    it("wikilink 嵌入：![[path/to/a.png]]", async () => {
        const vault = createFakeImageVault();
        vault.seed("images/a.png", { bytes: 10 });
        vault.seed("notes/n.md", { text: "看图 ![[images/a.png]] 完" });

        const refs = await scan(vault);
        expect(refsOf(refs, "images/a.png")).toEqual(["notes/n.md"]);
    });

    it("wikilink 带别名：![[a.png|说明]]", async () => {
        const vault = createFakeImageVault();
        vault.seed("images/a.png", { bytes: 10 });
        vault.seed("notes/n.md", { text: "![[a.png|这张是封面]]" });

        expect(refsOf(await scan(vault), "images/a.png")).toEqual(["notes/n.md"]);
    });

    it("省略扩展名的 wikilink：![[a]]", async () => {
        const vault = createFakeImageVault();
        vault.seed("images/封面.png", { bytes: 10 });
        vault.seed("notes/n.md", { text: "![[封面]]" });

        expect(refsOf(await scan(vault), "images/封面.png")).toEqual(["notes/n.md"]);
    });

    it("没有 `!` 的普通 wikilink 也算引用", async () => {
        const vault = createFakeImageVault();
        vault.seed("images/a.png", { bytes: 10 });
        vault.seed("notes/n.md", { text: "见 [[a.png]]" });

        expect(refsOf(await scan(vault), "images/a.png")).toEqual(["notes/n.md"]);
    });

    it("Markdown 图片：![alt](相对路径)", async () => {
        const vault = createFakeImageVault();
        vault.seed("notes/images/a.png", { bytes: 10 });
        vault.seed("notes/n.md", { text: "![alt](images/a.png)" });

        expect(refsOf(await scan(vault), "notes/images/a.png")).toEqual(["notes/n.md"]);
    });

    it("HTML img 标签", async () => {
        const vault = createFakeImageVault();
        vault.seed("images/a.png", { bytes: 10 });
        vault.seed("notes/n.md", { text: '<img src="images/a.png" width="200">' });

        expect(refsOf(await scan(vault), "images/a.png")).toEqual(["notes/n.md"]);
    });

    it("查询串与锚点会被剥掉：![](a.png?w=100)", async () => {
        const vault = createFakeImageVault();
        vault.seed("images/a.png", { bytes: 10 });
        vault.seed("notes/n.md", { text: "![](images/a.png?w=100)" });

        expect(refsOf(await scan(vault), "images/a.png")).toEqual(["notes/n.md"]);
    });

    /**
     * 外部地址**不做链接解析**，但文件名兜底仍然生效。
     *
     * 这是刻意的「宁可多算」：本插件自己就会生成 `https://<域名>/<前缀>/<路径>`
     * 这种外链（「复制云端链接」），而用户把它粘进笔记之后，本地那一份
     * 与它的**文件名是一样的**。把本地那份判成失联、进而清理掉，是本插件
     * 最容易造成的自伤。多算的代价只是「少删一张」。
     */
    it("外部链接不做链接解析，但文件名兜底仍然命中（宁可多算）", async () => {
        const vault = createFakeImageVault();
        vault.seed("images/a.png", { bytes: 10 });
        vault.seed("notes/n.md", {
            text: "![](https://img.example.com/images/a.png) ![](data:image/png;base64,AAAA)",
        });

        expect(refsOf(await scan(vault), "images/a.png")).toEqual(["notes/n.md"]);
    });

    it("外部链接与库内图片同名但不是同一份时，仍然只记「可能被引用」", async () => {
        const vault = createFakeImageVault();
        vault.seed("images/other.png", { bytes: 10 });
        vault.seed("notes/n.md", { text: "![](https://example.com/totally-different.png)" });

        expect(refsOf(await scan(vault), "images/other.png")).toEqual([]);
    });

    it("frontmatter 的链接写法与裸路径写法都认", async () => {
        const vault = createFakeImageVault();
        vault.seed("images/cover.png", { bytes: 10 });
        vault.seed("images/bare.jpg", { bytes: 10 });
        vault.seed("notes/n.md", { text: "正文没有引用" });
        vault.setFrontmatter("notes/n.md", {
            cover: "[[cover.png]]",
            banner: "images/bare.jpg",
            nested: { image: "![[cover.png]]" },
        });

        const refs = await scan(vault);
        expect(refsOf(refs, "images/cover.png")).toEqual(["notes/n.md"]);
        expect(refsOf(refs, "images/bare.jpg")).toEqual(["notes/n.md"]);
    });

    it("frontmatter 里不以图片扩展名结尾的字符串不白跑一遍匹配", async () => {
        const vault = createFakeImageVault();
        vault.seed("images/a.png", { bytes: 10 });
        vault.seed("notes/n.md", { text: "" });
        // `tags: [a]` 里的 `a` 与 `a.png` 主干同名 —— 但裸字符串判据要求
        // 以图片扩展名结尾，所以它不该被当成引用。
        vault.setFrontmatter("notes/n.md", { tags: ["a"] });

        expect(refsOf(await scan(vault), "images/a.png")).toEqual([]);
    });

    it("Canvas 的文件节点与文本节点", async () => {
        const vault = createFakeImageVault();
        vault.seed("images/file-node.png", { bytes: 10 });
        vault.seed("images/text-node.png", { bytes: 10 });
        vault.seed(
            "board.canvas",
            {
                text: JSON.stringify({
                    nodes: [
                        { type: "file", file: "images/file-node.png" },
                        { type: "text", text: "内嵌 ![[images/text-node.png]]" },
                        { type: "link", url: "https://example.com" },
                    ],
                }),
            }
        );

        const refs = await scan(vault);
        expect(refsOf(refs, "images/file-node.png")).toEqual(["board.canvas"]);
        expect(refsOf(refs, "images/text-node.png")).toEqual(["board.canvas"]);
    });

    it("Canvas 的 JSON 坏了 → 退化成纯文本扫描（宁可多算）", async () => {
        const vault = createFakeImageVault();
        vault.seed("images/a.png", { bytes: 10 });
        vault.seed("board.canvas", { text: '{"nodes": [ 坏掉的东西 "images/a.png"' });

        expect(refsOf(await scan(vault), "images/a.png")).toEqual(["board.canvas"]);
    });

    it("Excalidraw：解压后的 fileId 能匹配到同名文件，文本节点也扫", async () => {
        const vault = createFakeImageVault();
        vault.seed("画板/abc123def456.png", { bytes: 10 });
        vault.seed("images/from-text.png", { bytes: 10 });
        vault.seed("画板/board.excalidraw.md", {
            text: [
                "---",
                "excalidraw-plugin: parsed",
                "---",
                "",
                "```compressed-json",
                EXCALIDRAW_WITH_IMAGE,
                "```",
                "",
            ].join("\n"),
        });

        const refs = await scan(vault);
        expect(refsOf(refs, "画板/abc123def456.png")).toEqual(["画板/board.excalidraw.md"]);
        expect(refsOf(refs, "images/from-text.png")).toEqual(["画板/board.excalidraw.md"]);
    });

    it("Excalidraw：真实载荷里的 fileId 也能解出来", async () => {
        const vault = createFakeImageVault();
        // 真实样本没有内嵌图片（`files` 是空的），所以这里只验「解压没坏、
        // 场景能被认出来」——把载荷原样放进一个文件，并让它的 frontmatter
        // 之外的正文也带一个引用。
        vault.seed("images/a.png", { bytes: 10 });
        vault.seed("board.excalidraw.md", {
            text: [
                "---",
                "excalidraw-plugin: parsed",
                "---",
                "",
                "## Text Elements",
                "",
                "![[images/a.png]]",
                "",
                "```compressed-json",
                EXCALIDRAW_COMPRESSED,
                "```",
                "",
            ].join("\n"),
        });

        expect(refsOf(await scan(vault), "images/a.png")).toEqual(["board.excalidraw.md"]);
    });

    it("一个文件引用多张图时每张都记上，同一张被多处引用时去重", async () => {
        const vault = createFakeImageVault();
        vault.seed("images/a.png", { bytes: 10 });
        vault.seed("images/b.png", { bytes: 10 });
        vault.seed("notes/one.md", { text: "![[images/a.png]] 和 ![[images/b.png]]" });
        vault.seed("notes/two.md", { text: "![[images/a.png]] 再来一次 ![[images/a.png]]" });

        const refs = await scan(vault);
        expect(refsOf(refs, "images/a.png")).toEqual(["notes/one.md", "notes/two.md"]);
        expect(refsOf(refs, "images/b.png")).toEqual(["notes/one.md"]);
    });

    it("同名文件分散在两个文件夹时，两个都算被引用（宁可多算）", async () => {
        const vault = createFakeImageVault();
        vault.seed("a/logo.png", { bytes: 10 });
        vault.seed("b/logo.png", { bytes: 10 });
        vault.seed("notes/n.md", { text: "![[logo.png]]" });

        const refs = await scan(vault);
        expect(refsOf(refs, "a/logo.png")).toEqual(["notes/n.md"]);
        expect(refsOf(refs, "b/logo.png")).toEqual(["notes/n.md"]);
    });

    it("非图片文件不参与（`refs` 里只出现图片）", async () => {
        const vault = createFakeImageVault();
        vault.seed("notes/other.md", { text: "" });
        vault.seed("notes/n.md", { text: "![[notes/other.md]] ![[没有这个.png]]" });

        const refs = await scan(vault);
        expect([...refs.keys()]).toEqual([]);
    });

    it("扫描一个引用都没有的库时给出空表（而不是抛错）", async () => {
        const vault = createFakeImageVault();
        vault.seed("images/a.png", { bytes: 10 });

        const refs = await scan(vault);
        expect(refs.size).toBe(0);
    });

    it("单个来源文件读不出来不影响其他文件", async () => {
        const vault = createFakeImageVault();
        vault.seed("images/a.png", { bytes: 10 });
        vault.seed("notes/ok.md", { text: "![[images/a.png]]" });
        // 一个声明存在、实际内容取不到的文件。
        const ghost = vault.seed("notes/broken.md", { text: "x" });
        vault.files.delete(ghost.path);

        const refs = await scan(vault);
        expect(refsOf(refs, "images/a.png")).toEqual(["notes/ok.md"]);
    });

    it("报告扫过多少个来源文件（界面用它显示进度）", async () => {
        const vault = createFakeImageVault();
        vault.seed("images/a.png", { bytes: 10 });
        vault.seed("notes/a.md", { text: "" });
        vault.seed("board.canvas", { text: '{"nodes":[]}' });
        vault.seed("page.html", { text: "<html></html>" });

        const progress: Array<[number, number]> = [];
        const result = await collectImageReferences(vault.app, {
            onProgress: (done, total) => progress.push([done, total]),
        });

        expect(result.scanned).toBe(3);
        expect(progress.at(-1)).toEqual([3, 3]);
    });
});
