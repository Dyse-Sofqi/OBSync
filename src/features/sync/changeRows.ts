import type { FileChangeStatus, RepoStatus } from "./types";

/**
 * 「有哪些文件变了、各自暂存了没有」。
 *
 * 抽出来是因为它现在有**两个**消费方，而两边的数字必须一致：
 *
 * - 仓库同步视图的文件列表（几行、每行什么状态）；
 * - 点「推送」而本地没有新提交时的那句提示 —— 要告诉用户「还有 N 个更改没有提交」，
 *   这个 N 必须与他在面板里看到的一致，否则他会以为插件在乱数。
 *
 * 两处各写一遍规则，就是那种「改了其中一处、另一处悄悄不对」的老问题。
 */

/** 更改列表里的一行。 */
export interface ChangeRow {
    path: string;
    status: FileChangeStatus;
    /** 已经在索引里 —— 点一下是「取消暂存」而不是「暂存」。 */
    staged: boolean;
}

/**
 * 更改列表里该显示的文件（含「已暂存吗」这一位）。
 *
 * 两处过滤，都是为了**同一个文件不要出现多次**：
 *
 * 1. **冲突文件滤掉。** 它们在 `git status` 里是 `UU`，于是 `mapStatus`
 *    会把它同时归进 `staged` 与 `unstaged`。不滤的话同一个冲突文件会出现三次：
 *    staged 一次、unstaged 一次、外加冲突区单独渲染的那一行。
 * 2. **按路径去重。** 「改了又暂存」的文件（`AM` / `MM`）两个状态位都非空，
 *    同样会进两个数组。列表是给人看的「有哪些文件变了」，
 *    同一个路径出现两遍只会让人以为有两处改动。
 *
 * 去重时**保留第一次出现的那个**（staged → unstaged → untracked 的顺序），
 * 于是「已暂存」优先 —— 与 `git status` 的阅读顺序一致。
 */
export function changeRows(status: RepoStatus): ChangeRow[] {
    const stagedPaths = new Set(status.staged.map((change) => change.path));
    const seen = new Set<string>();
    const rows: ChangeRow[] = [];

    for (const change of [...status.staged, ...status.unstaged, ...status.untracked]) {
        if (change.status === "conflicted") continue;
        if (seen.has(change.path)) continue;
        seen.add(change.path);
        rows.push({
            path: change.path,
            status: change.status,
            staged: stagedPaths.has(change.path),
        });
    }

    return rows;
}
