import { describe, expect, it } from "vitest";
import { visibleChanges } from "../../src/features/sync/ui/SourceControlView";
import type { FileChange, RepoStatus } from "../../src/features/sync/types";

/**
 * 源码控制视图的变更列表。
 *
 * 抽成纯函数是因为它踩过一个只在界面上才看得见的问题：**冲突文件重复显示三次**。
 *
 * 根因在状态映射层：冲突文件在 `git status` 里是 `UU`，`mapStatus` 于是把它
 * **同时**归进 `staged`（index 位非空）与 `unstaged`（worktree 位非空）。
 * 列表若直接 `[...staged, ...unstaged, ...untracked]`，再加上单独渲染的
 * `conflicted` 那一行，一个冲突就出现三次。
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

describe("visibleChanges", () => {
    it("普通变更按 staged / unstaged / untracked 汇总", () => {
        const changes = visibleChanges(
            status({
                staged: [change("a.md", "added")],
                unstaged: [change("b.md", "modified")],
                untracked: [change("c.md", "untracked")],
            })
        );

        expect(changes.map((item) => item.path)).toEqual(["a.md", "b.md", "c.md"]);
    });

    it("**冲突文件不出现在变更列表里**（它由调用方单独渲染）", () => {
        // 模拟真实状态：冲突文件同时被算进 staged 与 unstaged
        const changes = visibleChanges(
            status({
                staged: [change("notes/会打架.md", "conflicted")],
                unstaged: [change("notes/会打架.md", "conflicted")],
                conflicted: ["notes/会打架.md"],
            })
        );

        expect(changes).toEqual([]);
    });

    it("冲突与普通变更并存时，只滤掉冲突", () => {
        const changes = visibleChanges(
            status({
                staged: [change("notes/会打架.md", "conflicted"), change("a.md", "added")],
                unstaged: [change("notes/会打架.md", "conflicted")],
                untracked: [change("b.md", "untracked")],
                conflicted: ["notes/会打架.md"],
            })
        );

        expect(changes.map((item) => item.path)).toEqual(["a.md", "b.md"]);
    });

    it("干净仓库返回空", () => {
        expect(visibleChanges(status({}))).toEqual([]);
    });
});

describe("去重：同一个文件不要出现多次", () => {
    it("「改了又暂存」的文件（AM / MM）只显示一次", () => {
        // mapStatus 按 git status 的两位状态位分别归类，AM/MM 的文件
        // 两个位都非空 → 同时进 staged 与 unstaged。列表是给人看的
        // 「有哪些文件变了」，同一个路径出现两遍会让人以为有两处改动。
        const changes = visibleChanges(
            status({
                staged: [change("a.md", "added"), change("b.md", "modified")],
                unstaged: [change("b.md", "modified")],
            })
        );

        expect(changes.map((item) => item.path)).toEqual(["a.md", "b.md"]);
    });

    it("保留第一次出现的那个（staged 优先）", () => {
        const changes = visibleChanges(
            status({
                staged: [change("a.md", "added")],
                unstaged: [change("a.md", "modified")],
            })
        );

        expect(changes).toHaveLength(1);
        expect(changes[0]!.status).toBe("added");
    });

    it("去重不影响不同路径的文件", () => {
        const changes = visibleChanges(
            status({
                staged: [change("a.md", "added")],
                unstaged: [change("b.md", "modified")],
                untracked: [change("c.md", "untracked")],
            })
        );

        expect(changes.map((item) => item.path)).toEqual(["a.md", "b.md", "c.md"]);
    });
});
