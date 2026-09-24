import { describe, expect, it } from "vitest";
import {
    countRenameable,
    DEFAULT_RENAME_RULE,
    planRename,
    type RenameRule,
} from "../../../src/features/images/batchRename";

/**
 * 批量重命名的规则计算。
 *
 * 这个函数不碰 vault，但它决定的是**会改掉库里所有链接**的名字，
 * 所以每条分支都值得钉住：算错一个字符就是几十个断链。
 */

const none = (): boolean => false;
const now = new Date(2026, 8, 23); // 2026-09-23

function paths(): string[] {
    return ["photos/日落.png", "photos/海边.jpg", "photos/城市.webp"];
}

function rule(template: string, start = 1): RenameRule {
    return { template, start };
}

describe("planRename", () => {
    it("默认模板给原名加序号", () => {
        const entries = planRename(paths(), DEFAULT_RENAME_RULE, none, now);
        expect(entries.map((entry) => entry.to)).toEqual([
            "photos/日落-1.png",
            "photos/海边-2.jpg",
            "photos/城市-3.webp",
        ]);
        expect(countRenameable(entries)).toBe(3);
    });

    it("目录不变 —— 链接是按相对路径解析的", () => {
        const entries = planRename(["a/b/c.png"], rule("img-{n}"), none, now);
        expect(entries[0]!.to).toBe("a/b/img-1.png");
    });

    it("{n} 按这一批的总数补零 —— 不补的话 img-10 会排在 img-2 前面", () => {
        const many = Array.from({ length: 12 }, (_, index) => `photos/p${index}.png`);
        const entries = planRename(many, rule("img-{n}"), none, now);
        expect(entries[0]!.to).toBe("photos/img-01.png");
        expect(entries[11]!.to).toBe("photos/img-12.png");
    });

    it("起始序号参与补零宽度：从 8 开始的 5 张是 08…12", () => {
        const five = Array.from({ length: 5 }, (_, index) => `photos/p${index}.png`);
        const entries = planRename(five, rule("img-{n}", 8), none, now);
        expect(entries.map((entry) => entry.to)).toEqual([
            "photos/img-08.png",
            "photos/img-09.png",
            "photos/img-10.png",
            "photos/img-11.png",
            "photos/img-12.png",
        ]);
    });

    it("{name} 是主干名（不含扩展名），{ext} 是扩展名", () => {
        const entries = planRename(["photos/日落.png"], rule("{name}-压缩.{ext}"), none, now);
        expect(entries[0]!.to).toBe("photos/日落-压缩.png");
    });

    it("{date} 是 YYYYMMDD", () => {
        const entries = planRename(["photos/a.png"], rule("{date}-{name}"), none, now);
        expect(entries[0]!.to).toBe("photos/20260923-a.png");
    });

    it("未知占位符**原样保留** —— 写错成 {nama} 时用户立刻看得见", () => {
        const entries = planRename(["photos/a.png"], rule("{nama}-{n}"), none, now);
        expect(entries[0]!.to).toBe("photos/{nama}-1.png");
    });

    it("名字没变时标成 unchanged 而不是照样执行", () => {
        const entries = planRename(["photos/a.png"], rule("{name}"), none, now);
        expect(entries[0]!.problem).toBe("unchanged");
        expect(countRenameable(entries)).toBe(0);
    });

    it("模板算出来是空的 → invalid", () => {
        const entries = planRename(["photos/a.png"], rule("   "), none, now);
        expect(entries[0]!.problem).toBe("invalid");
    });

    it("含非法字符 → invalid（否则 Obsidian 会拒绝，而错误信息很难懂）", () => {
        for (const template of ["a/b", "a:b", "a?b", 'a"b', "a|b"]) {
            const entries = planRename(["photos/a.png"], rule(template), none, now);
            expect(entries[0]!.problem, template).toBe("invalid");
        }
    });

    it("目标已被占用 → taken（**绝不覆盖**）", () => {
        const entries = planRename(
            ["photos/a.png"],
            rule("b"),
            (path) => path === "photos/b.png",
            now
        );
        expect(entries[0]!.to).toBe("photos/b.png");
        expect(entries[0]!.problem).toBe("taken");
        expect(countRenameable(entries)).toBe(0);
    });

    it("模板改了扩展名 → extChanged（改名不改内容，换容器要在编辑弹窗里做）", () => {
        const entries = planRename(["photos/a.png"], rule("{name}.webp"), none, now);
        expect(entries[0]!.problem).toBe("extChanged");
        expect(countRenameable(entries)).toBe(0);
    });

    it("目标正是同批里的另一个文件 → 也算 taken（不做链式改名）", () => {
        // a.png → b.png 而 b.png → c.png：链式改名要靠顺序才对，而顺序在批量
        // 操作里没有天然答案，猜错的代价是覆盖掉一个文件。
        const entries = planRename(
            ["photos/a.png", "photos/b.png"],
            rule("{name}"),
            () => false,
            now
        );
        // `{name}` 对两个文件都是「名字没变」，所以先被 unchanged 挡下。
        expect(entries.every((entry) => entry.problem === "unchanged")).toBe(true);

        const clashing = planRename(
            ["photos/a.png", "photos/b.png"],
            rule("b"),
            (path) => path === "photos/b.png",
            now
        );
        // a.png 想变成 b.png（被占），b.png 想变成 b.png（没变）。
        expect(clashing[0]!.problem).toBe("taken");
        expect(clashing[1]!.problem).toBe("unchanged");
    });

    it("点开头的文件名（没有扩展名）也能处理", () => {
        const entries = planRename([".hidden"], rule("{name}-x"), none, now);
        expect(entries[0]!.to).toBe(".hidden-x");
    });

    it("空列表得到空结果", () => {
        expect(planRename([], DEFAULT_RENAME_RULE, none, now)).toEqual([]);
    });
});
