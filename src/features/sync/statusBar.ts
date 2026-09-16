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
 */

export type StatusBarActivity = "idle" | "pulling" | "pushing" | "committing";

export interface StatusBarContext {
    app: App;
    t: LocaleStrings;
}

export class StatusBar {
    private readonly item: HTMLElement;
    private readonly ctx: StatusBarContext;
    private status: RepoStatus | undefined;
    private activity: StatusBarActivity = "idle";

    constructor(ctx: StatusBarContext) {
        this.ctx = ctx;
        this.item = (ctx.app.workspace as unknown as {
            addStatusBarItem(): HTMLElement;
        }).addStatusBarItem();
        this.render("idle");
    }

    /** 更新底层仓库状态并重绘。传 undefined 表示「还不是仓库」等信息不可得。 */
    update(status: RepoStatus | undefined): void {
        this.status = status;
        this.render(this.activity);
    }

    /** 标记一次瞬时动作；动作结束后调用 `update()` 恢复。 */
    setActivity(activity: StatusBarActivity): void {
        this.activity = activity;
        this.render(activity);
    }

    private render(activity: StatusBarActivity): void {
        const t = this.ctx.t;

        try {
            if (activity !== "idle") {
                this.item.setText(
                    `OBSync: ${
                        activity === "pulling"
                            ? t.sync.statusPulling
                            : activity === "pushing"
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

            const dirty = this.status.staged.length + this.status.unstaged.length + this.status.untracked.length;
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
