import type { App } from "obsidian";
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
    /**
     * **每次渲染时取**，不要传 `t` 本身。
     *
     * 状态栏元素由 `addStatusBarItem()` 创建、**只知道这么一份**，
     * 所以它不会被重建（重建等于在状态栏上多挂一个条目），也就没有机会
     * 在语言变化时换成新的翻译。把它取成 `() => LocaleStrings` 是这块唯一
     * 能跟上语言切换的做法 —— 也是项目里其它地方（`SyncService` / `Notifier`）
     * 一贯的做法，状态栏曾经是唯一的例外。
     */
    getT: () => LocaleStrings;
}

export class StatusBar {
    private readonly item: HTMLElement;
    private readonly getT: () => LocaleStrings;
    private status: RepoStatus | undefined;
    private activity: StatusBarActivity = "idle";

    constructor(deps: StatusBarDeps) {
        this.item = deps.item;
        this.getT = deps.getT;
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
        const t = this.getT();

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

/**
 * 从 Obsidian 的 vault 适配器拿文件系统路径（git 的 `baseDir`）。
 *
 * ## 这里**不能**用 `normalizePath`
 *
 * `normalizePath` 是给 **vault 相对路径**用的。它的实现（从真实的 Obsidian
 * 产物里扣出来的）是「折叠重复斜杠，再**剥掉前导与结尾斜杠**」：
 *
 * ```
 * e.replace(/([\\/])+/g, "/").replace(/(^\/+|\/+$)/g, "")
 * ```
 *
 * 而 `getBasePath()` 给的是**文件系统的绝对路径** —— 前导斜杠就是根目录本身。
 * 剥掉之后 `/Users/sofi/Documents/Vault` 变成了一个**相对路径**，而相对路径按
 * **进程 cwd** 解析：目标不存在时 simple-git 会直接抛
 * 「Cannot use simple-git on a directory that does not exist」（实测确认）。
 *
 * 在 macOS 上这个错可能**歪打正着** —— 若进程 cwd 恰好是 `/`，
 * 相对路径又被还原成同一个绝对路径。这大概就是它一直没被发现的原因；
 * 换个启动方式（比如 Linux 上从终端启动，cwd 是终端所在目录）就没有这个巧合了。
 *
 * 这个错**在 Windows 上测不出来**：`C:\...` 不以斜杠开头，`normalizePath`
 * 对它是恒等变换，测试全绿。所以 `tests/features/statusBar.test.ts` 里那组用例
 * 是**显式喂 POSIX 路径**的，不依赖宿主机的形态。
 *
 * 因此：**原样返回**（不折叠斜杠、也不换分隔符）。这个路径不是我们构造的，
 * 就不该由我们改写 —— 任何「顺手归一」都要先能证明它对所有平台都安全，
 * 而这次的教训正是有人觉得「前导斜杠多余」。参考项目 obsidian-git 也是直接取
 * `getBasePath()` 原文，`normalizePath` 只用在 vault 相对路径的设置项上。
 * （两种分隔符都能被 simple-git 正确解析，实测过，所以原样传没有风险。）
 */
export function getVaultRoot(app: App): string {
    return (app.vault.adapter as unknown as { getBasePath(): string }).getBasePath();
}
