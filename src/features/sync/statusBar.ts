import { normalizePath, type App } from "obsidian";
import { logger } from "../../core/logger";
import type { LocaleStrings } from "../../core/i18n";
import type { RepoStatus } from "./types";

/**
 * 状态栏。
 *
 * 只展示两类信息：**同步进行中的动作**（拉取/推送/提交）和
 * **用户最需要立即知道的异常**（不是仓库 / 没有 git / 有冲突）。
 * ahead/behind 计数用 `↑3 ↓1` 这种无语言符号展示，不进 i18n。
 *
 * 参考项目 obsidian-git 的状态栏更新跑在固定的定时器里，
 * 这里改为**由 syncService 在每次状态变化后显式调用** ——
 * 没有变化就不动 DOM，也避免与真实同步动作脱节。
 *
 * 注意：状态栏元素由调用方用 `plugin.addStatusBarItem()` 创建后传入 ——
 * 这个 API 在 **Plugin** 类上，不在 `app.workspace` 上（猜错会直接
 * TypeError，这正是踩过的坑）。
 */

export type StatusBarActivity = "idle" | "pulling" | "pushing" | "committing";

export interface StatusBarDeps {
    /** `plugin.addStatusBarItem()` 的返回值。 */
    item: HTMLElement;
    t: LocaleStrings;
}

export class StatusBar {
    private readonly item: HTMLElement;
    private readonly t: LocaleStrings;
    private status: RepoStatus | undefined;
    private activity: StatusBarActivity = "idle";

    constructor(deps: StatusBarDeps) {
        this.item = deps.item;
        this.t = deps.t;
        this.render();
    }

    /** 更新底层仓库状态并重绘。传 undefined 表示「还不是仓库」等信息不可得。 */
    update(status: RepoStatus | undefined): void {
        this.status = status;
        this.render();
    }

    /** 标记一次瞬时动作；动作结束后调用 `update()` 恢复。 */
    setActivity(activity: StatusBarActivity): void {
        this.activity = activity;
        this.render();
    }

    private render(): void {
        const t = this.t;

        try {
            if (this.activity !== "idle") {
                this.item.setText(
                    `OBSync: ${
                        this.activity === "pulling"
                            ? t.sync.statusPulling
                            : this.activity === "pushing"
                              ? t.sync.statusPushing
                              : t.sync.statusCommitting
                    }`
                );
                return;
            }

            if (!this.status) {
                this.item.setText("OBSync");
                return;
            }

            const parts: string[] = [];
            if (this.status.branch) parts.push(this.status.branch);
            if (this.status.ahead !== null && this.status.ahead > 0) parts.push(`↑${this.status.ahead}`);
            if (this.status.behind !== null && this.status.behind > 0) parts.push(`↓${this.status.behind}`);

            // 脏文件数**按路径去重**：同一个文件可能既在 staged 又在 unstaged 里
            // （`mapStatus` 按 `git status` 的两位状态位分别归类，「改了又暂存」
            // 的文件两个位都非空）。直接相加会把一个文件算成两个。
            const dirty = new Set([
                ...this.status.staged.map((change) => change.path),
                ...this.status.unstaged.map((change) => change.path),
                ...this.status.untracked.map((change) => change.path),
            ]).size;

            if (this.status.conflicted.length > 0) {
                parts.push(`⚠ ${this.status.conflicted.length}`);
            } else if (dirty > 0) {
                parts.push(`~${dirty}`);
            }

            this.item.setText(parts.length > 0 ? `OBSync: ${parts.join(" ")}` : "OBSync");
        } catch (err) {
            // 状态栏渲染失败绝不能打断同步本身。
            logger.debug("status bar render failed", err);
        }
    }
}

/** 从 Obsidian 的 vault 适配器拿文件系统路径（git 的 baseDir）。 */
export function getVaultRoot(app: App): string {
    return normalizePath(
        (app.vault.adapter as unknown as { getBasePath(): string }).getBasePath()
    );
}
