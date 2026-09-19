import { describe, expect, it } from "vitest";
import { isFullyInSync } from "../../src/features/sync/syncState";
import type { FileChange, RepoStatus } from "../../src/features/sync/types";

/**
 * 「本地与远端完全一致」的判据。
 *
 * 这个状态有**三个**消费方（同步结束的醒目提示、状态栏的 ✓、面板里的绿色高亮），
 * 它们必须给出同一个答案 —— 判据写三遍就会出现「状态栏打了勾、提示却说没同步」。
 *
 * 每一条否定条件都要有用例：漏掉任何一条，用户就会在**不该**打勾的时候看到打勾。
 */

function change(path: string, status: FileChange["status"] = "modified"): FileChange {
    return { path, status };
}

function status(partial: Partial<RepoStatus> = {}): RepoStatus {
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

describe("isFullyInSync", () => {
    it("干净 + 不领先 + 不落后 + 有 upstream → 一致", () => {
        expect(isFullyInSync(status())).toBe(true);
    });

    it("**没有 upstream（ahead/behind 为 null）不算一致**", () => {
        // 一个从没推送过的分支不该打勾 —— 那时根本谈不上「与远端一致」。
        expect(isFullyInSync(status({ ahead: null, behind: null }))).toBe(false);
        expect(isFullyInSync(status({ ahead: 0, behind: null }))).toBe(false);
    });

    it("领先（有没推的提交）不算一致", () => {
        expect(isFullyInSync(status({ ahead: 1 }))).toBe(false);
    });

    it("落后（远端有别人的提交）不算一致", () => {
        expect(isFullyInSync(status({ behind: 1 }))).toBe(false);
    });

    it("有未提交改动不算一致（**即使 ahead/behind 都是 0**）", () => {
        // 「git status 干净」与「与远端一致」是两件事，两条都要看。
        expect(isFullyInSync(status({ unstaged: [change("a.md")] }))).toBe(false);
        expect(isFullyInSync(status({ staged: [change("a.md", "added")] }))).toBe(false);
        expect(isFullyInSync(status({ untracked: [change("b.md", "untracked")] }))).toBe(false);
    });

    it("有未解决的冲突不算一致", () => {
        expect(isFullyInSync(status({ conflicted: ["打架.md"] }))).toBe(false);
    });

    it("状态取不到（不是仓库）不算一致", () => {
        expect(isFullyInSync(undefined)).toBe(false);
    });

    it("「改了又暂存」的文件只算一次改动（与面板列表同一套规则）", () => {
        // 去重规则错了会让「干净」判断失真：同一个文件在两个数组里，
        // 数两遍不影响「非空」，但这里锁的是它确实非空（而不是被去重成空）。
        expect(
            isFullyInSync(status({ staged: [change("a.md")], unstaged: [change("a.md")] }))
        ).toBe(false);
    });
});
