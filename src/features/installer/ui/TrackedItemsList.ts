import { Setting, type App } from "obsidian";
import type { LocaleStrings } from "../../../core/i18n";
import { availableUpdateKey } from "../../../core/settings";
import { formatRepoId, repoWebUrl } from "../../../host/repoRef";
import type { RepoRef } from "../../../host/types";
import { downloadSourceLabel, hostLabel } from "../downloadSource";
import type { InstallerService } from "../installerService";
import type { UpdateChecker } from "../updateChecker";
import { itemRepoRef, type TrackedItem } from "../types";
import { ConfirmMirrorModal } from "./ConfirmMirrorModal";

/**
 * 设置页里的「已跟踪的插件与主题」列表。
 *
 * 每一行是一个对象（插件或主题），右侧是它可执行的操作。刻意不做批量操作按钮
 * 之外的复杂交互 —— 用户在这里最常做的三件事是「看有没有更新」「重装」
 * 「取消绑定」，把它们放在一眼能看到的位置就够了。
 *
 * 「取消绑定」只把条目移出跟踪列表，**不删任何文件**（见 `InstallerService.unbind`）——
 * 插件与主题的安装 / 移除归 Obsidian 自己管，列表里不该有一个能删库文件的按钮。
 *
 * 有更新的行常驻高亮徽标（数据来自 `installer.availableUpdates`，
 * 由更新检查写入）—— Notice 一闪就错过，列表才是用户回得来的地方。
 *
 * ## 插件与主题共用一个列表
 *
 * 两者的六项操作**全部成立**（检查 / 更新 / 重装 / 冻结 / 打开仓库 / 移除），
 * 行为差异都收在 `InstallerService` 与 `UpdateChecker` 里按 kind 分派，
 * 这里只负责两件展示上的事：名称后的**类型徽标**，以及要删除的东西是
 * 什么（移除确认的文案不同）。
 * 分作两个列表的代价是两套渲染与操作代码 —— BRAT 就是插件、主题各写一份。
 */

export interface TrackedItemsContext {
    app: App;
    t: LocaleStrings;
    service: InstallerService;
    checker: UpdateChecker;
    getTracked(): TrackedItem[];
    /**
     * 该对象当前记录的可更新信息（无则 undefined）。
     * 键由 `availableUpdateKey` 生成（`<kind>:<id>`）—— 插件 id 与主题目录名
     * 是两个命名空间，不能混用一张表。
     */
    getUpdateFor(key: string): { latestVersion: string; checkedAt: number } | undefined;
    /**
     * **待用户确认**的疑似镜像（无则 undefined）。
     *
     * 镜像发现从不自动采用：命中只写进 `installer.mirrorSuggestions`，由这一行
     * 列出来请用户拍板（见 `ConfirmMirrorModal` 里那段警告的由来）。
     */
    getMirrorSuggestion(key: string): RepoRef | undefined;
    /** 重新渲染设置页（列表变化后调用）。 */
    refresh(): void;
}

export function renderTrackedItems(
    containerEl: HTMLElement,
    ctx: TrackedItemsContext
): void {
    const t = ctx.t;
    const tracked = ctx.getTracked();

    // 标题与说明由调用方（设置页的头部栏）渲染 —— 那里和三个主操作按钮在同一行，
    // 避免出现「空一半的卡片」。
    if (tracked.length === 0) {
        containerEl.createEl("p", {
            cls: "setting-item-description obsync-empty",
            text: t.settings.installer.trackedEmpty,
        });
        return;
    }

    for (const item of tracked) {
        renderRow(containerEl, ctx, item);
    }
}

function renderRow(
    containerEl: HTMLElement,
    ctx: TrackedItemsContext,
    item: TrackedItem
): void {
    const t = ctx.t;
    const update = ctx.getUpdateFor(availableUpdateKey(item));

    /**
     * 描述行报**源仓库**（用户填的那个地址）—— 那是这个插件的家，也是他认得出来的东西。
     *
     * 走了 Gitee 镜像时 `item.host/owner/repo` 已经是镜像了，源地址只存在
     * `item.origin` 里，所以这里取它优先。镜像另起一行，见下面。
     */
    const primary = item.origin ?? itemRepoRef(item);

    // 描述行只放事实（来源、版本）；状态类的信息做成名称后的徽标，
    // 扫列表时眼睛只需看一列。
    const facts = [hostLabel(t, primary.host), `${primary.owner}/${primary.repo}`];
    // 主题可能读不到 manifest 里的 version（手工装的目录），此时不写这一段 ——
    // 「版本 」后面空着比不写更像坏了。
    if (item.installedVersion) {
        facts.push(`${t.common.version} ${item.installedVersion}`);
    }
    // 只在「从源码装」时说明来源。这是**解释性**信息：
    // 该仓库没有发布 release，所以更新检查查不到版本可比 ——
    // 不写出来用户会以为更新检查坏了。常见的 release 通道不加噪音。
    // （主题在绑定进来时 channel 为空，第一次更新后才有值。）
    if (item.channel === "raw") {
        facts.push(t.installer.sourceRaw);
    }

    const setting = new Setting(containerEl).setName(item.name).setDesc(facts.join(" · "));

    // 镜像另起一行（不是拼进上面那串）—— 两个地址是两件事，挤在一行会读成
    // 「owner/repo」被列了两遍。顺序也刻意：先源仓库，再镜像。
    //
    // 尾巴上那句「下载使用此源」是必须的：只写「Gitee 镜像」的话，用户看到
    // 第一行是 GitHub、第二行是 Gitee，无从判断 OBSync 到底在跟谁说话 ——
    // 而事实是下载与更新检查都走镜像。
    if (item.origin) {
        const mirror = itemRepoRef(item);
        setting.descEl.createDiv({
            text: t.installer.mirrorLine(
                hostLabel(t, mirror.host),
                `${mirror.owner}/${mirror.repo}`
            ),
            cls: "obsync-mirror-line",
        });
    }

    // **疑似镜像**：地址列出来等用户确认。刻意与上面那行「已在使用」的镜像文案
    // 用不同措辞（「尚未使用，待确认」）—— 两者长得像但含义相反，混淆的代价是
    // 用户以为已经在走镜像了。
    const suggestion = ctx.getMirrorSuggestion(availableUpdateKey(item));
    if (suggestion) {
        setting.descEl.createDiv({
            text: t.installer.mirrorSuggestionLine(
                hostLabel(t, suggestion.host),
                formatRepoId(suggestion)
            ),
            cls: "obsync-mirror-line obsync-mirror-pending",
        });
    }

    setting.nameEl.createSpan({
        text: item.kind === "theme" ? t.installer.kindTheme : t.installer.kindPlugin,
        cls: "obsync-badge obsync-badge-kind",
    });

    if (update) {
        setting.nameEl.createSpan({
            text: t.installer.updateBadge(update.latestVersion),
            cls: "obsync-badge obsync-badge-update",
        });
        setting.setClass("obsync-has-update");
    }
    if (item.frozen) {
        setting.nameEl.createSpan({
            text: t.installer.frozen,
            cls: "obsync-badge obsync-badge-muted",
        });
    }

    // 检查更新
    setting.addExtraButton((button) =>
        button
            // 放大镜 = 「去问远端有没有新版」，与下面两个动作的图形完全不同 ——
            // 之前用 refresh-cw，和「重装」的圆箭头几乎分不出来。
            .setIcon("search")
            .setTooltip(t.installer.checkOne)
            .onClick(async () => {
                button.setDisabled(true);
                try {
                    const result = await ctx.checker.checkOne(item);
                    await ctx.service.recordUpdateChecks([result]);
                    if (result.error !== undefined) {
                        ctx.service.deps.notifier.error(`${item.name}: ${result.error}`);
                    } else if (result.hasUpdate) {
                        ctx.service.deps.notifier.info(
                            t.installer.updateAvailable(item.name, result.latestVersion)
                        );
                    } else {
                        ctx.service.deps.notifier.info(t.installer.upToDate(item.name));
                    }
                    ctx.refresh();
                } catch (err) {
                    ctx.service.deps.notifier.reportError(err, t.installer.checkFailed);
                } finally {
                    button.setDisabled(false);
                }
            })
    );

    // 更新到最新
    setting.addExtraButton((button) => {
        button
            .setIcon("download")
            .setTooltip(t.installer.updateToLatest)
            .onClick(async () => {
                button.setDisabled(true);
                try {
                    const result =
                        item.kind === "theme"
                            ? await ctx.service.updateTheme(item)
                            : await ctx.service.install({
                                  repo: `${item.owner}/${item.repo}`,
                                  version: "latest",
                                  enableAfterInstall: true,
                                  defaultHost: item.host,
                              });
                    // 报**实际**用的来源（可能刚换成镜像）—— 见 downloadSourceLabel。
                    ctx.service.deps.notifier.success(
                        t.installer.updated(
                            item.name,
                            result.version,
                            downloadSourceLabel(t, result)
                        )
                    );
                    ctx.refresh();
                } catch (err) {
                    ctx.service.deps.notifier.reportError(err, t.installer.installFailed);
                } finally {
                    button.setDisabled(false);
                }
            });

        // 有更新时把这个按钮标成主操作（强调色）—— ExtraButtonComponent
        // 没有 setClass，但暴露了元素本身。
        if (update) button.extraSettingsEl.addClass("obsync-action-primary");
        return button;
    });

    // 重装
    setting.addExtraButton((button) =>
        button
            // 圆箭头留给「重装」独占（检查更新已换成放大镜），指代「再来一遍」。
            .setIcon("refresh-cw")
            .setTooltip(t.installer.reinstall)
            .onClick(async () => {
                button.setDisabled(true);
                try {
                    const result = await ctx.service.reinstall(item);
                    ctx.service.deps.notifier.success(
                        t.installer.reinstalled(item.name, downloadSourceLabel(t, result))
                    );
                    ctx.refresh();
                } catch (err) {
                    ctx.service.deps.notifier.reportError(err, t.installer.installFailed);
                } finally {
                    button.setDisabled(false);
                }
            })
    );

    // 冻结（不参与自动更新）
    setting.addExtraButton((button) =>
        button
            .setIcon(item.frozen ? "lock" : "unlock")
            .setTooltip(item.frozen ? t.installer.unfreeze : t.installer.freeze)
            .onClick(async () => {
                await ctx.service.setFrozen(item, !item.frozen);
                ctx.refresh();
            })
    );

    // 打开仓库页
    setting.addExtraButton((button) =>
        button
            .setIcon("external-link")
            .setTooltip(t.installer.openRepo)
            .onClick(() => {
                // 打开的是**实际使用**的来源（走镜像时即镜像）—— 那正是上面
                // 「下载使用此源」那句说的地方，也是 OBSync 真能取到东西的地址。
                // 源仓库的地址就在描述行的第一行，用户要看它的主页自己点得过去。
                window.open(repoWebUrl(itemRepoRef(item)), "_blank");
            })
    );

    // 确认镜像来源（**只在有提议时出现** —— 正常行不多一个没用的按钮）
    if (suggestion) {
        setting.addExtraButton((button) =>
            button
                .setIcon("git-compare")
                .setTooltip(t.installer.mirrorConfirmTooltip)
                .onClick(() => {
                    new ConfirmMirrorModal(
                        ctx.app,
                        t,
                        item,
                        suggestion,
                        (useMirror) => void confirmMirror(ctx, item, suggestion, useMirror)
                    ).open();
                })
        );
    }

    // 取消绑定（不删文件）
    setting.addExtraButton((button) =>
        button
            // 图标刻意用 unlink 而不是垃圾桶：这个动作**不删任何文件**，
            // 垃圾桶会让人以为点下去插件就没了（而它以前真的会 —— 见
            // `InstallerService.unbind` 的注释）。也不做二次确认：动作可逆
            // （重新绑定即可），与「绑定」那侧对称 —— 那边同样不确认。
            .setIcon("unlink")
            .setTooltip(t.installer.remove)
            .onClick(async () => {
                try {
                    await ctx.service.unbind(item);
                    ctx.service.deps.notifier.success(t.installer.removed(item.name));
                    ctx.refresh();
                } catch (err) {
                    ctx.service.deps.notifier.reportError(err, t.installer.removeFailed);
                }
            })
    );
}

/**
 * 用户在弹窗里拍板之后要做的事。
 *
 * 两条路都要给**明确反馈**：这是个「换掉信任对象」的动作，静默生效的话用户
 * 无从知道自己刚才同意了什么。
 */
async function confirmMirror(
    ctx: TrackedItemsContext,
    item: TrackedItem,
    suggestion: RepoRef,
    useMirror: boolean
): Promise<void> {
    const t = ctx.t;
    try {
        if (useMirror) {
            await ctx.service.confirmMirror(item, suggestion);
            ctx.service.deps.notifier.success(
                t.installer.mirrorConfirmed(
                    hostLabel(t, suggestion.host),
                    formatRepoId(suggestion)
                )
            );
        } else {
            await ctx.service.dismissMirrorSuggestion(item);
            ctx.service.deps.notifier.info(t.installer.mirrorDismissed(formatRepoId(suggestion)));
        }
        ctx.refresh();
    } catch (err) {
        ctx.service.deps.notifier.reportError(err, t.installer.installFailed);
    }
}
