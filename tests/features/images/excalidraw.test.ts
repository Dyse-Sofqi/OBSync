import { describe, expect, it } from "vitest";
import {
    decompressFromBase64,
    excalidrawCandidates,
    excalidrawScene,
} from "../../../src/features/images/excalidraw";
import { EXCALIDRAW_COMPRESSED } from "./fixtures/excalidrawSample";

/**
 * Excalidraw 场景的解压与引用提取。
 *
 * 最重要的一条是**对着真实样本**解压：LZString 没有校验和，实现错位时
 * 得到的是乱码而不是异常，自造样本两边一起错也照样绿。
 */

describe("decompressFromBase64", () => {
    it("把真实 .excalidraw.md 里的压缩载荷解成合法 JSON", () => {
        const json = decompressFromBase64(EXCALIDRAW_COMPRESSED);
        expect(json).toBeTypeOf("string");

        const scene = JSON.parse(json!) as { type?: string; elements?: unknown[] };
        expect(scene.type).toBe("excalidraw");
        expect(Array.isArray(scene.elements)).toBe(true);
    });

    it("空输入与畸形输入都返回 undefined，不抛错", () => {
        expect(decompressFromBase64("")).toBeUndefined();
        // 真实解压会在位流读完时返回 undefined —— 半截结果比没有结果更危险。
        expect(decompressFromBase64("N4KAkARALgngDgUwgLgAQQQDwMYEMA2AlgCYBO")).toBeUndefined();
        expect(decompressFromBase64("!!!!")).toBeUndefined();
    });
});

describe("excalidrawScene", () => {
    it("认压缩块", () => {
        const markdown = ["---", "excalidraw-plugin: parsed", "---", "", "```compressed-json", EXCALIDRAW_COMPRESSED, "```", ""].join("\n");
        expect(excalidrawScene(markdown)).toBeDefined();
    });

    it("也认未压缩的 json 块（插件设置里可以关掉压缩）", () => {
        const scene = { type: "excalidraw", elements: [], files: {} };
        const markdown = "```json\n" + JSON.stringify(scene) + "\n```\n";
        expect(excalidrawScene(markdown)).toEqual(scene);
    });

    it("两个块都没有时返回 undefined", () => {
        expect(excalidrawScene("# 普通笔记\n\n没有画布数据")).toBeUndefined();
    });

    it("压缩载荷坏掉时返回 undefined 而不是抛错", () => {
        const markdown = "```compressed-json\n@@@not-base64@@@\n```\n";
        expect(excalidrawScene(markdown)).toBeUndefined();
    });
});

describe("excalidrawCandidates", () => {
    it("取 fileId、files 的键、以及任何以图片扩展名结尾的字符串", () => {
        const scene = {
            type: "excalidraw",
            elements: [
                { type: "image", fileId: "abc123" },
                { type: "text", text: "hello" },
            ],
            files: { def456: { mimeType: "image/png" } },
            appState: { lastImage: "assets/photo.jpg" },
        };

        const candidates = excalidrawCandidates(scene);
        expect(candidates).toContain("abc123");
        expect(candidates).toContain("def456");
        expect(candidates).toContain("assets/photo.jpg");
    });

    it("不把 data URL 当候选（它的结尾是 base64 内容，不是扩展名）", () => {
        const scene = {
            type: "excalidraw",
            elements: [{ type: "image", fileId: "aaa" }],
            files: { aaa: { dataURL: "data:image/png;base64,iVBORw0KGgo=" } },
        };
        expect(excalidrawCandidates(scene)).toEqual(["aaa"]);
    });

    it("元素数组畸形时不抛错", () => {
        expect(excalidrawCandidates({ elements: "不是数组" })).toEqual([]);
        expect(excalidrawCandidates(null)).toEqual([]);
    });
});
