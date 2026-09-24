import { describe, expect, it } from "vitest";
import type { App } from "obsidian";
import { TFile } from "../../stubs/obsidian";
import {
    appUrlToPath,
    imageLinkCandidates,
    resolveImageFile,
    type ImageHints,
} from "../../../src/features/images/ui/imageToolbar";

/**
 * 阅读视图工具条：从渲染后的 `img` 反推「这是库里的哪个文件」。
 *
 * ## 这段逻辑为什么值得单独测
 *
 * 它的产物是**一个 `TFile`**，而下游动作是「裁剪它」和「把它传到云端」——
 * 猜错的表现不是报错，而是**对另一张图动手**。而线索本身很脏：`src` 在不同
 * 平台/版本下形状不同（`app://` 开头、相对路径、小图甚至是 `data:`），
 * 所以这里只能列一串候选、逐个去库里找。
 *
 * 另外一条同样重要的性质是「**认不出来就什么都不做**」：外链图片
 * （`https://…`）不该挂上工具条 —— 它不在库里，任何后续操作都无从谈起。
 */

function hints(overrides: Partial<ImageHints> = {}): ImageHints {
    return { src: "", alt: "", linkHref: "", ...overrides };
}

describe("appUrlToPath", () => {
    it("剥掉 app:// 协议头与库标识", () => {
        expect(appUrlToPath("app://abc123/attachments/a.png")).toBe("attachments/a.png");
    });

    it("库标识为空也认（某些版本是 app:///…）", () => {
        expect(appUrlToPath("app:///attachments/a.png")).toBe("attachments/a.png");
    });

    it("百分号编码被解开（路径里有空格与中文）", () => {
        expect(appUrlToPath("app://abc123/attachments/%E6%88%91%20%E5%9B%BE.png")).toBe(
            "attachments/我 图.png"
        );
    });

    /**
     * 路径里有落单的 `%` 时 `decodeURIComponent` 会抛。
     *
     * 那种情况下原样返回，让 vault 的查找去失败 —— 比在这里抛异常好：
     * 抛出去的表现是「阅读视图渲染到一半炸掉」，而这里最坏只是
     * 「这一张图没有工具条」。
     */
    it("编码非法时原样返回（不抛）", () => {
        expect(appUrlToPath("app://abc123/a%zz.png")).toBe("a%zz.png");
    });

    it("不是 app:// 时原样返回（相对路径、外链、data:）", () => {
        expect(appUrlToPath("attachments/a.png")).toBe("attachments/a.png");
        expect(appUrlToPath("https://example.com/a.png")).toBe("https://example.com/a.png");
    });
});

describe("imageLinkCandidates", () => {
    it("按可信度排序：外层链接 → alt → src", () => {
        const candidates = imageLinkCandidates(
            hints({
                linkHref: "attachments/from-href.png",
                alt: "from-alt.png",
                src: "app://abc123/attachments/from-src.png",
            })
        );

        expect(candidates).toEqual([
            "attachments/from-href.png",
            "from-alt.png",
            "attachments/from-src.png",
        ]);
    });

    /**
     * `linkHref` 也要过 `appUrlToPath` —— 不只是 `src`。
     *
     * 阅读视图里 `<a>` 的 `href` 在部分版本/主题下就是 `app://<vaultId>/…`，
     * 不转换的话**最可信的那个候选**会是一个 `app://` 字符串、必然落空，
     * 于是每次都白跑一次查找（而且工具条只在后面的候选碰巧命中时才出现）。
     */
    it("外层链接是 app:// 形状时同样被还原成路径", () => {
        expect(
            imageLinkCandidates(hints({ linkHref: "app://abc123/attachments/a.png" }))
        ).toEqual(["attachments/a.png"]);
    });

    it("src 不是 app:// 时它自己作为候选", () => {
        expect(imageLinkCandidates(hints({ src: "attachments/a.png" }))).toEqual([
            "attachments/a.png",
        ]);
    });

    it("去掉查询串（Obsidian 会加 `?<mtime>` 做缓存失效）", () => {
        expect(
            imageLinkCandidates(hints({ src: "app://abc123/attachments/a.png?1700000000" }))
        ).toEqual(["attachments/a.png"]);
        expect(imageLinkCandidates(hints({ linkHref: "attachments/a.png?x=1" }))).toEqual([
            "attachments/a.png",
        ]);
    });

    /**
     * **带 scheme 的一律丢掉。**
     *
     * `data:` 是内联图片（磁盘上根本没有对应文件），`https:` 是外链 ——
     * 两者都不是 vault 路径，而这里所有后续操作（裁剪、上传）都需要真实文件。
     * 留在候选里只会每次渲染都多跑一遍必然失败的查找。
     */
    it.each([
        ["data:image/png;base64,iVBORw0KGgo=", "内联图片"],
        ["https://example.com/a.png", "外链"],
        ["blob:app/1234", "blob URL"],
    ])("丢掉带 scheme 的线索（%s，%s）", (src) => {
        expect(imageLinkCandidates(hints({ src }))).toEqual([]);
    });

    it("排除空白线索", () => {
        expect(imageLinkCandidates(hints({ linkHref: "   ", alt: "" }))).toEqual([]);
    });

    it("去重（同一张图从多个线索推出同一个路径）", () => {
        expect(
            imageLinkCandidates(
                hints({
                    linkHref: "attachments/a.png",
                    alt: "attachments/a.png",
                    src: "app://abc123/attachments/a.png",
                })
            )
        ).toEqual(["attachments/a.png"]);
    });

    it("线索被 trim", () => {
        expect(imageLinkCandidates(hints({ alt: "  attachments/a.png  " }))).toEqual([
            "attachments/a.png",
        ]);
    });
});

describe("resolveImageFile", () => {
    interface FakeMetadata {
        app: App;
        /** 记下 `getFirstLinkpathDest` 被问过什么。 */
        asked: string[];
    }

    function fakeApp(files: string[], linkTargets: Record<string, string> = {}): FakeMetadata {
        const asked: string[] = [];
        const byPath = new Map(files.map((path) => [path, new TFile(path)]));

        return {
            asked,
            app: {
                vault: {
                    getAbstractFileByPath(path: string) {
                        return byPath.get(path) ?? null;
                    },
                },
                metadataCache: {
                    getFirstLinkpathDest(linkpath: string) {
                        asked.push(linkpath);
                        const target = linkTargets[linkpath];
                        return target ? new TFile(target) : null;
                    },
                },
            } as unknown as App,
        };
    }

    it("src 已经是 vault 相对路径时直接命中", () => {
        const { app } = fakeApp(["attachments/a.png"]);

        const file = resolveImageFile(app, hints({ src: "app://abc/attachments/a.png" }), "note.md");

        expect(file?.path).toBe("attachments/a.png");
    });

    it("外层链接最优先（它就是笔记里写的那个目标）", () => {
        const { app } = fakeApp(["attachments/href.png", "attachments/alt.png"]);

        const file = resolveImageFile(
            app,
            hints({ linkHref: "attachments/href.png", alt: "attachments/alt.png" }),
            "note.md"
        );

        expect(file?.path).toBe("attachments/href.png");
    });

    it("直查不到时按链接解析（短链接 `a.png` 要配合来源笔记定位）", () => {
        const { app, asked } = fakeApp(["attachments/a.png"], { "a.png": "attachments/a.png" });

        const file = resolveImageFile(app, hints({ alt: "a.png" }), "notes/note.md");

        expect(file?.path).toBe("attachments/a.png");
        expect(asked).toContain("a.png");
    });

    it("**认不出来时返回 null**（外链图片不挂工具条）", () => {
        const { app } = fakeApp(["attachments/a.png"]);

        expect(
            resolveImageFile(app, hints({ src: "https://example.com/a.png" }), "note.md")
        ).toBeNull();
        expect(resolveImageFile(app, hints({ src: "data:image/png;base64,x" }), "note.md")).toBeNull();
    });

    it("文件夹不是文件时也算没找到（`getAbstractFileByPath` 会返回 TFolder）", () => {
        const { app } = fakeApp([]);
        // 让直查返回一个「不是 TFile」的东西
        const withFolder = {
            vault: {
                getAbstractFileByPath: () => ({ path: "attachments" }),
            },
            metadataCache: { getFirstLinkpathDest: () => null },
        } as unknown as App;

        expect(resolveImageFile(withFolder, hints({ alt: "attachments" }), "note.md")).toBeNull();
        expect(resolveImageFile(app, hints({}), "note.md")).toBeNull();
    });

    it("没有任何线索时返回 null", () => {
        const { app } = fakeApp(["attachments/a.png"]);

        expect(resolveImageFile(app, hints({}), "note.md")).toBeNull();
    });
});
