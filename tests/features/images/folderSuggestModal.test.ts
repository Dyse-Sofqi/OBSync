import { describe, expect, it } from "vitest";
import { FolderSuggestModal } from "../../../src/features/images/ui/FolderSuggestModal";
import { zhCN } from "../../../src/core/i18n/locales/zh-cn";
import { createFakeApp } from "../../helpers/fakeApp";

/**
 * 受管图片文件夹的选择器。
 *
 * 它挡的是「手打路径」那一类错：`/attachments/`、`assets//img`、根本不存在的
 * 目录 —— 全都没有提示，表现是「填了却一个文件都不动」。所以这里验的是
 * 「列出来的东西能用、搜得到、选中之后交给调用方的是归一后的路径」。
 */

/** 造一个有两层文件夹的库。`createFakeApp` 还会自带 `.obsidian` 那几层。 */
function openModal(managed: string[] = [], onChoose?: (folder: string) => void) {
    const fake = createFakeApp({
        "attachments/a.png": "x",
        "assets/img/b.png": "y",
    });
    const chosen: string[] = [];
    const modal = new FolderSuggestModal(
        fake.app,
        zhCN,
        managed,
        onChoose ?? ((folder) => chosen.push(folder))
    );
    return { fake, modal, chosen };
}

describe("FolderSuggestModal", () => {
    it("仓库根目录排在最前，其余文件夹按路径排序", () => {
        const { modal } = openModal();
        const options = modal.getSuggestions("");

        expect(options[0]?.path).toBe("");
        expect(options[0]?.label).toBe(zhCN.settings.images.folderPickerRoot);
        expect(options.slice(1).map((option) => option.path)).toEqual([
            ".obsidian",
            ".obsidian/plugins",
            ".obsidian/themes",
            "assets",
            "assets/img",
            "attachments",
        ]);
    });

    it("按路径过滤（大小写不敏感）", () => {
        const { modal } = openModal();

        expect(modal.getSuggestions("attach").map((option) => option.path)).toEqual([
            "attachments",
        ]);
        expect(modal.getSuggestions("IMG").map((option) => option.path)).toEqual(["assets/img"]);
        // 搜不到时是空列表，不是全部
        expect(modal.getSuggestions("不存在")).toEqual([]);
    });

    it("根目录能用它的名字搜到（设置说明里写的就是「填 . 表示整个库」）", () => {
        const { modal } = openModal();

        expect(modal.getSuggestions("仓库").map((option) => option.path)).toEqual([""]);
    });

    /**
     * 「已包含」要说出来：否则用户在一个已经受管的库里挑来挑去，
     * 会以为每次选择都改变了范围，而实际上什么都没有发生。
     */
    it("已在受管范围的项被标注（被更外层文件夹覆盖的也算）", () => {
        const { modal } = openModal(["attachments"]);
        const options = modal.getSuggestions("");

        expect(options.find((option) => option.path === "attachments")?.included).toBe(true);
        expect(options.find((option) => option.path === "assets")?.included).toBe(false);
        expect(options[0]?.included).toBe(false);
    });

    it("整个库已受管时，根目录也被标注", () => {
        const { modal } = openModal([""]);

        expect(modal.getSuggestions("")[0]?.included).toBe(true);
    });

    it("选中回调拿到的是归一后的路径（根目录 = 空串）", () => {
        const { modal, chosen } = openModal();

        modal.onChooseSuggestion(modal.getSuggestions("")[0]!);
        modal.onChooseSuggestion(modal.getSuggestions("attach")[0]!);

        expect(chosen).toEqual(["", "attachments"]);
    });

    it("renderSuggestion 给已包含的项附上一行说明", () => {
        const { modal } = openModal(["attachments"]);
        const el = document.createElement("div");

        modal.renderSuggestion(modal.getSuggestions("attach")[0]!, el);

        // 测试环境是手写的 DOM 替身（tests/setup.ts）：没有 textContent，
        // 子节点的文字记在各自的 `text` 上。
        const texts = (el.children as unknown as Array<{ text?: string }>).map(
            (child) => child.text ?? ""
        );
        expect(texts).toContain(zhCN.settings.images.folderPickerIncluded);
    });

    it("占位文案来自 locale", () => {
        const { modal } = openModal();

        expect((modal as unknown as { placeholder: string }).placeholder).toBe(
            zhCN.settings.images.folderPickerPlaceholder
        );
    });
});
