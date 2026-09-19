import { changeRows } from "./changeRows";
import type { RepoStatus } from "./types";

/**
 * 「本地与远端完全一致」的判据 —— 只有一处定义。
 *
 * ## 为什么值得单独一个函数
 *
 * 这个状态现在有**三个**消费方，而它们必须给出同一个答案：
 *
 * - 同步/提交结束后的**醒目反馈**（「已同步」那条提示）；
 * - 状态栏那个 `✓`；
 * - 仓库同步视图里状态摘要那一行的绿色高亮。
 *
 * 三处各写一遍条件，就是「改了其中一处、另外两处悄悄不一致」的老问题 ——
 * 用户会看到状态栏打了勾、提示却说没同步。
 *
 * ## 判据（全部满足才算一致）
 *
 * 1. **有 upstream**（`ahead` / `behind` 不为 null）。为 null 的语义是「没有跟踪的
 *    远端分支」（见 `RepoStatus` 的注释），那时根本谈不上「与远端一致」——
 *    一个从没推送过的分支不该显示打勾。
 * 2. **不领先也不落后**（都是 0）。
 * 3. **没有未解决的冲突**。
 * 4. **没有未提交的改动**（`changeRows` 为空 —— 与面板里那份列表同一套规则）。
 *
 * 注意第 4 条：`git status` 干净**不代表**与远端一致（可能有一堆没推的提交），
 * 反过来 ahead/behind 都是 0 也不代表干净（可能有没提交的改动）。两条都要看。
 */
export function isFullyInSync(status: RepoStatus | undefined): boolean {
    if (!status) return false;
    if (status.ahead === null || status.behind === null) return false;
    if (status.ahead !== 0 || status.behind !== 0) return false;
    if (status.conflicted.length > 0) return false;
    return changeRows(status).length === 0;
}
