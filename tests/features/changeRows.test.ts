import { describe, expect, it } from "vitest";
import { changeRows } from "../../src/features/sync/changeRows";
import type { FileChange, RepoStatus } from "../../src/features/sync/types";

/**
 * 更改列表的**内容与顺序**。
 *
 * 它现在有两个消费方，而两边的数字必须一致：
 *
 * 1. 源码控制视图的文件列表；
 * 2. 点「推送」而本地没有新提交时的那句提示（「你有 N 个更改还没提交」）——
 *    N 与用户在面板里看到的不一样，他就会以为插件在乱数。
 *
 * 所以规则只有这一份，两个消费方都从这里取。
 *
 * 抽成纯函数还有一个理由：这类「列表里多了一项 / 少了一项」的问题读代码很难发现，
 * 而视图要做 DOM 级断言代价太高。
 */

function change(path: string, status: FileChange["status"]): FileChange {
    return { path, status };
}

function status(partial: Partial<RepoStatus>): RepoStatus {
    return {
        branch: "main",
        staged: [],
        unstaged: [],
        untracked: [],
        conflicted: [],
        ahead: 0,
        behind: 0,
        ...partial,
    };
}

describe("changeRows", () => {
    it("普通变更按 staged / unstaged / untracked 汇总", () => {
        const rows = changeRows(
            status({
                staged: [change("a.md", "added")],
                unstaged: [change("b.md", "modified")],
                untracked: [change("c.md", "untracked")],
            })
        );

        expect(rows.map((row) => row.path)).toEqual(["a.md", "b.md", "c.md"]);
    });

    it("**冲突文件不出现在变更列表里**（它由调用方单独渲染）", () => {
        // 模拟真实状态：冲突文件同时被算进 staged 与 unstaged
        const rows = changeRows(
            status({
                staged: [change("notes/会打架.md", "conflicted")],
                unstaged: [change("notes/会打架.md", "conflicted")],
                conflicted: ["notes/会打架.md"],
            })
        );

        expect(rows).toEqual([]);
    });

    it("冲突与普通变更并存时，只滤掉冲突", () => {
        const rows = changeRows(
            status({
                staged: [change("notes/会打架.md", "conflicted"), change("a.md", "added")],
                unstaged: [change("notes/会打架.md", "conflicted")],
                untracked: [change("b.md", "untracked")],
                conflicted: ["notes/会打架.md"],
            })
        );

        expect(rows.map((row) => row.path)).toEqual(["a.md", "b.md"]);
    });

    it("干净仓库返回空", () => {
        expect(changeRows(status({}))).toEqual([]);
    });

    it("「改了又暂存」的文件（AM / MM）只显示一次", () => {
        // mapStatus 按 git status 的两位状态位分别归类，AM/MM 的文件
        // 两个位都非空 → 同时进 staged 与 unstaged。列表是给人看的
        // 「有哪些文件变了」，同一个路径出现两遍会让人以为有两处改动。
        const rows = changeRows(
            status({
                staged: [change("a.md", "added"), change("b.md", "modified")],
                unstaged: [change("b.md", "modified")],
            })
        );

        expect(rows.map((row) => row.path)).toEqual(["a.md", "b.md"]);
    });

    it("保留第一次出现的那个（staged 优先）", () => {
        const rows = changeRows(
            status({
                staged: [change("a.md", "added")],
                unstaged: [change("a.md", "modified")],
            })
        );

        expect(rows).toHaveLength(1);
        expect(rows[0]!.status).toBe("added");
    });

    it("标出「已暂存」，未暂存与未跟踪都是 false", () => {
        // 这一位决定那一行给的是「暂存」还是「取消暂存」按钮 —— 反了会让
        // 用户点了之后文件往相反的方向动。
        const rows = changeRows(
            status({
                staged: [change("a.md", "added")],
                unstaged: [change("b.md", "modified")],
                untracked: [change("c.md", "untracked")],
            })
        );

        expect(rows.map((row) => row.staged)).toEqual([true, false, false]);
    });

    it("去重不影响不同路径的文件", () => {
        const rows = changeRows(
            status({
                staged: [change("a.md", "added")],
                unstaged: [change("b.md", "modified")],
                untracked: [change("c.md", "untracked")],
            })
        );

        expect(rows.map((row) => row.path)).toEqual(["a.md", "b.md", "c.md"]);
    });

    it("数量就是「还有几个更改没提交」的那个数", () => {
        // 「推送」的提示直接用它 —— 用户会拿这个数和面板里的列表对着看。
        const rows = changeRows(
            status({
                staged: [change("a.md", "added")],
                unstaged: [change("a.md", "modified"), change("b.md", "modified")],
                untracked: [change("c.md", "untracked")],
                conflicted: ["notes/会打架.md"],
            })
        );

        expect(rows).toHaveLength(3);
    });
});
