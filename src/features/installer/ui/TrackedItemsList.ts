import { Setting, type App, type ExtraButtonComponent } from "obsidian";
import type { LocaleStrings } from "../../../core/i18n";
import { availableUpdateKey } from "../../../core/settings";
import { formatRepoId, repoWebUrl } from "../../../host/repoRef";
import type { RepoRef } from "../../../host/types";
import { downloadSourceLabel, hostLabel } from "../downloadSource";
import type { InstallerService, VersionOption } from "../installerService";
import type { UpdateChecker } from "../updateChecker";
import { itemRepoRef, type TrackedItem, type TrackedPlugin } from "../types";
import { ConfirmMirrorModal } from "./ConfirmMirrorModal";
import { VersionManagerModal } from "./VersionManagerModal";

/**
 * 行内动作的图标。
 *
 * 提成常量是因为**每个图标要写两处**：`setIcon()` 一次，`runWithProgress()` 一次
 * （它做完要把图标换回去）。两处各写一个字面量就等着漂移 —— 2026-09-19 把
 * 「检查更新」从放大镜换成圆箭头时，就真的漏了 `runWithProgress` 那一处
 * （表现为转完圈图标又变回放大镜），是测试抓住的。
 */
const ICON = {
    check: "refresh-cw",
    update: "download",
    version: "history",
} as const;

/**
 * 设置页里的「已跟踪的插件与主题」列表。
 *
 * 每一行是一个对象（插件或主题），右侧是它可执行的操作。刻意不做批量操作按钮
 * 之外的复杂交互 —— 用户在这里最常做的三件事是「看有没有更新」「换一个版本」
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
 * 两者的五项操作**全部成立**（检查 / 更新 / 冻结 / 打开仓库 / 移除），
 * 行为差异都收在 `InstallerService` 与 `UpdateChecker` 里按 kind 分派，
 * 这里只负责两件展示上的事：名称后的**类型徽标**，以及要删除的东西是
 * 什么（移除确认的文案不同）。
 * 分作两个列表的代价是两套渲染与操作代码 —— BRAT 就是插件、主题各写一份。
 *
 * 唯一的**刻意不对称**是第七个按钮「版本管理」：只有插件有。主题在设计上
 * 没有版本钉选（`TrackedTheme` 上没有 `requestedVersion`，`updateTheme`
 * 永远按最新走），给它一个能选版本的按钮就等于承诺一件做不到的事。
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
    // 第一行是 GitHub、第二行是 Gitee，无从判断 SyncHub 到底在跟谁说话 ——
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
    // 钉在某个版本上（用户从「版本管理」里选了具体版本）。
    //
    // 必须显示出来：它只存在于 `data.json` 的 `requestedVersion` 里，而它的后果
    // 是「按记录里那一版重新装回去」。不写的话，用户看到版本号是旧的，分不清那是自己选的、
    // 还是更新失败留下的 —— 正是这个项目最忌讳的那类「改了有作用但界面不承认」的状态。
    if (item.kind === "plugin" && item.requestedVersion !== "latest") {
        setting.nameEl.createSpan({
            text: t.installer.versionPinned(item.requestedVersion),
            cls: "obsync-badge obsync-badge-muted",
        });
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
            // 圆箭头 = 「去问远端有没有新版」。
            //
            // 这个图标原来是「重装」的，撞车之后检查更新换成了放大镜；2026-09-19
            // 重装按钮被删掉（它与「版本管理」重合，见文件头的说明），图标空出来，
            // 就还给检查更新 —— refresh-cw 本来就是「检查更新」最通用的表达。
            .setIcon(ICON.check)
            .setTooltip(t.installer.checkOne)
            .onClick(() =>
                void runWithProgress({
                    ctx,
                    name: item.name,
                    button,
                    icon: ICON.check,
                    startMessage: t.installer.progressChecking(item.name),
                    fallbackError: t.installer.checkFailed,
                    work: async () => {
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
                    },
                })
            )
    );

    // 更新到最新
    setting.addExtraButton((button) => {
        button
            .setIcon(ICON.update)
            .setTooltip(t.installer.updateToLatest)
            .onClick(() =>
                void runWithProgress({
                    ctx,
                    name: item.name,
                    button,
                    icon: ICON.update,
                    startMessage: t.installer.progressUpdating(item.name),
                    fallbackError: t.installer.installFailed,
                    work: async (onProgress) => {
                        const result =
                            item.kind === "theme"
                                ? await ctx.service.updateTheme(item, onProgress)
                                : await ctx.service.install({
                                      repo: `${item.owner}/${item.repo}`,
                                      version: "latest",
                                      enableAfterInstall: true,
                                      defaultHost: item.host,
                                      onProgress,
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
                    },
                })
            );

        // 有更新时把这个按钮标成主操作（强调色）—— ExtraButtonComponent
        // 没有 setClass，但暴露了元素本身。
        if (update) button.extraSettingsEl.addClass("obsync-action-primary");
        return button;
    });

    // 版本管理（**只有插件有** —— 主题在设计上就没有版本钉选，见文件头的说明）
    //
    // 它同时顶掉了原来的「重装」按钮：重装 = 用**记录里那一版**重新装一遍，
    // 而这个弹窗的默认选中项**就是**记录里那一版 —— 「打开 → 直接点切换」与
    // 重装逐字相同（同一组参数调同一个 `install()`）。主题那边更直接：重装调的就是
    // `updateTheme`，与它自己的「更新到最新」一字不差。所以两个按钮留一个就够。
    if (item.kind === "plugin") appendVersionButton(setting, ctx, item);

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
                // 「下载使用此源」那句说的地方，也是 SyncHub 真能取到东西的地址。
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
 * 「版本管理」按钮 —— 把一个已跟踪的插件切到另一个已发布的版本。
 *
 * 这是 `requestedVersion`（「用户要求的版本」）在界面上的**唯一入口**：
 * 它以前只由「添加插件仓库」弹窗写过一次，之后既改不了也看不见。
 *
 * 只有插件这一个 kind 调用它，因为只有插件有这个字段 —— 主题的版本永远
 * 跟着最新走（见 `installer/types.ts`）。
 */
function appendVersionButton(
    setting: Setting,
    ctx: TrackedItemsContext,
    plugin: TrackedPlugin
): void {
    const t = ctx.t;
    setting.addExtraButton((button) =>
        button
            // 时钟 + 回退箭头：它管的是「换成哪一版」，与旁边「更新到最新」的
            // 下载箭头是两件事 —— 后者只往最新走，前者能往回走。
            .setIcon(ICON.version)
            .setTooltip(t.installer.versionManage)
            .onClick(() => {
                new VersionManagerModal(ctx.app, ctx.service, t, plugin, {
                    onChoose: (option) => void switchVersion(ctx, plugin, option, button),
                    // 弹窗里可以换下载来源（改用镜像 / 手填地址）—— 记录变了，
                    // 底下那张列表的两行地址也要跟着变，否则用户关掉弹窗看到的是旧地址。
                    onSourceChanged: () => ctx.refresh(),
                }).open();
            })
    );
}

/**
 * 用户选定了版本之后要做的事。
 *
 * 走的同样是 `install`：弹窗里选定的版本交给它，`install` 再把这一版写回记录 ——
 * 也就是「钉在这一版」：此后在版本管理里直接点切换（默认选中的就是它）会装回
 * 这一版，而「更新到最新版本」会把记录改回 `latest`（恢复跟随最新）。这条语义是现成的，这里不另造一套。
 *
 * 「从哪个仓库下载」不出现在这里：它写在记录里（`host/owner/repo`），弹窗里换过
 * 来源之后，下面的 `formatRepoId`/`defaultHost` 读到的就已经是新来源了。
 */
async function switchVersion(
    ctx: TrackedItemsContext,
    plugin: TrackedPlugin,
    option: VersionOption,
    button: ExtraButtonComponent
): Promise<void> {
    const t = ctx.t;
    await runWithProgress({
        ctx,
        name: plugin.name,
        button,
        icon: ICON.version,
        startMessage: t.installer.progressUpdating(plugin.name),
        fallbackError: t.installer.installFailed,
        work: async (onProgress) => {
            const result = await ctx.service.install({
                repo: formatRepoId(plugin),
                version: option.value,
                // 与这一行上的「更新到最新」同一口径：装完保持可用。
                enableAfterInstall: true,
                defaultHost: plugin.host,
                onProgress,
            });
            // 报**实际装成的版本**（manifest 里那个，可能与 tag 不同形：
            // tag `v1.2.0` → version `1.2.0`）与来源。
            ctx.service.deps.notifier.success(
                t.installer.versionSwitched(
                    plugin.name,
                    result.version,
                    downloadSourceLabel(t, result)
                )
            );
            ctx.refresh();
        },
    });
}

/**
 * 跑一次「要打网络、可能要等十几秒」的行内动作，并把「还在跑」显示出来。
 *
 * 两处反馈都要有，因为它们的可见性条件不同：
 *
 * 1. **被点的那个图标按钮自己转起来** —— 它不受「显示操作结果提示」设置影响，
 *    把提示关掉的用户也得看得见；
 * 2. **进度提示里写清正在取哪个文件** —— 卡在 GitHub 资产域名上时（国内常态，
 *    实测第一次请求 17~20 秒，见 HANDOVER 第七节第 19 条），用户唯一能判断
 *    「没卡死」的依据就是它就着文件名在动。
 *
 * 用户原话：「不然我根本不知道你是不是在更新」。
 */
async function runWithProgress(options: {
    ctx: TrackedItemsContext;
    name: string;
    button: ExtraButtonComponent;
    icon: string;
    startMessage: string;
    fallbackError: string;
    work: (onProgress: (file: string) => void) => Promise<void>;
}): Promise<void> {
    const { ctx, name, button, icon, startMessage } = options;
    const stopSpinner = startSpinner(button, icon);
    const progress = ctx.service.deps.notifier.progress(startMessage);
    try {
        await options.work((file) => {
            progress.update(ctx.t.installer.progressFetching(name, file));
        });
    } catch (err) {
        ctx.service.deps.notifier.reportError(err, options.fallbackError);
    } finally {
        progress.done();
        stopSpinner();
    }
}

/**
 * 把按钮的图标临时换成会转的 loader。
 *
 * 用 `loader` + 一条 CSS 动画（`.obsync-spinning`）而不是自己画一个元素：
 * `setIcon` 是 ExtraButtonComponent 唯一能改内容的口子，而图标本身就是 SVG。
 * 返回的函数把图标换回去 —— 注意重绘之后这个按钮已经被替换掉了，
 * 对脱离文档的元素调用它是无害的（与其它行内动作的处理一致）。
 */
function startSpinner(button: ExtraButtonComponent, icon: string): () => void {
    button.setDisabled(true);
    button.setIcon("loader");
    button.extraSettingsEl.addClass("obsync-spinning");
    return () => {
        button.extraSettingsEl.removeClass("obsync-spinning");
        button.setIcon(icon);
        button.setDisabled(false);
    };
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
