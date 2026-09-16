import { Setting, type App } from "obsidian";
import type { LocaleStrings } from "../../../core/i18n";
import { repoWebUrl } from "../../../host/repoRef";
import type { RepoRef } from "../../../host/types";
import type { InstallerService } from "../installerService";
import type { UpdateChecker } from "../updateChecker";
import type { TrackedPlugin } from "../types";

/**
 * 设置页里的「已跟踪插件」列表。
 *
 * 每一行是一个插件，右侧是该插件可执行的操作。刻意不做批量操作按钮之外
 * 的复杂交互 —— 用户在这里最常做的三件事是「看有没有更新」「重装」
 * 「删掉」，把它们放在一眼能看到的位置就够了。
 *
 * 有更新的行常驻高亮徽标（数据来自 `installer.availableUpdates`，
 * 由更新检查写入）—— Notice 一闪就错过，列表才是用户回得来的地方。
 */

export interface TrackedPluginsContext {
    app: App;
    t: LocaleStrings;
    service: InstallerService;
    checker: UpdateChecker;
    getTracked(): TrackedPlugin[];
    /** 该插件当前记录的可更新信息（无则 undefined）。 */
    getUpdateFor(pluginId: string): { latestVersion: string; checkedAt: number } | undefined;
    /** 重新渲染设置页（列表变化后调用）。 */
    refresh(): void;
}

function toRepoRef(tracked: TrackedPlugin): RepoRef {
    return { host: tracked.host, owner: tracked.owner, repo: tracked.repo };
}

export function renderTrackedPlugins(
    containerEl: HTMLElement,
    ctx: TrackedPluginsContext
): void {
    const t = ctx.t;
    const tracked = ctx.getTracked();

    new Setting(containerEl).setName(t.settings.installer.tracked).setHeading();
    containerEl.createEl("p", {
        cls: "setting-item-description",
        text: t.settings.installer.trackedDesc,
    });

    if (tracked.length === 0) {
        containerEl.createEl("p", {
            cls: "setting-item-description obsync-empty",
            text: t.settings.installer.trackedEmpty,
        });
        return;
    }

    for (const plugin of tracked) {
        renderRow(containerEl, ctx, plugin);
    }
}

function renderRow(
    containerEl: HTMLElement,
    ctx: TrackedPluginsContext,
    plugin: TrackedPlugin
): void {
    const t = ctx.t;
    const hostName = plugin.host === "gitee" ? t.host.gitee : t.host.github;
    const update = ctx.getUpdateFor(plugin.pluginId);

    const setting = new Setting(containerEl)
        .setName(plugin.name)
        // 描述行只放事实（来源、版本）；状态类的信息做成名称后的徽标，
        // 扫列表时眼睛只需看一列。
        .setDesc(
            `${hostName} · ${plugin.owner}/${plugin.repo} · ` +
                `${t.common.version} ${plugin.installedVersion}`
        );

    if (update) {
        setting.nameEl.createSpan({
            text: t.installer.updateBadge(update.latestVersion),
            cls: "obsync-badge obsync-badge-update",
        });
        setting.setClass("obsync-has-update");
    }
    if (plugin.frozen) {
        setting.nameEl.createSpan({
            text: t.installer.frozen,
            cls: "obsync-badge obsync-badge-muted",
        });
    }

    // 检查更新
    setting.addExtraButton((button) =>
        button
            .setIcon("refresh-cw")
            .setTooltip(t.installer.checkOne)
            .onClick(async () => {
                button.setDisabled(true);
                try {
                    const result = await ctx.checker.checkOne(plugin);
                    await ctx.service.recordUpdateChecks([result]);
                    if (result.error !== undefined) {
                        ctx.service.deps.notifier.error(
                            `${plugin.name}: ${result.error}`
                        );
                    } else if (result.hasUpdate) {
                        ctx.service.deps.notifier.info(
                            t.installer.updateAvailable(plugin.name, result.latestVersion)
                        );
                    } else {
                        ctx.service.deps.notifier.info(t.installer.upToDate(plugin.name));
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
    setting.addExtraButton((button) =>
        button
            .setIcon("download")
            .setTooltip(t.installer.updateToLatest)
            .onClick(async () => {
                button.setDisabled(true);
                try {
                    const result = await ctx.service.install({
                        repo: `${plugin.owner}/${plugin.repo}`,
                        version: "latest",
                        enableAfterInstall: true,
                        defaultHost: plugin.host,
                    });
                    ctx.service.deps.notifier.success(
                        t.installer.updated(result.manifest.name, result.version)
                    );
                    ctx.refresh();
                } catch (err) {
                    ctx.service.deps.notifier.reportError(err, t.installer.installFailed);
                } finally {
                    button.setDisabled(false);
                }
            })
    );

    // 重装
    setting.addExtraButton((button) =>
        button
            .setIcon("rotate-cw")
            .setTooltip(t.installer.reinstall)
            .onClick(async () => {
                button.setDisabled(true);
                try {
                    await ctx.service.reinstall(plugin);
                    ctx.service.deps.notifier.success(t.installer.reinstalled(plugin.name));
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
            .setIcon(plugin.frozen ? "lock" : "unlock")
            .setTooltip(plugin.frozen ? t.installer.unfreeze : t.installer.freeze)
            .onClick(async () => {
                await ctx.service.setFrozen(plugin, !plugin.frozen);
                ctx.refresh();
            })
    );

    // 打开仓库页
    setting.addExtraButton((button) =>
        button
            .setIcon("external-link")
            .setTooltip(t.installer.openRepo)
            .onClick(() => {
                window.open(repoWebUrl(toRepoRef(plugin)), "_blank");
            })
    );

    // 移除
    setting.addExtraButton((button) =>
        button
            .setIcon("trash")
            .setTooltip(t.installer.remove)
            .onClick(async () => {
                const confirmed = await confirmRemoval(ctx, plugin);
                if (!confirmed) return;
                try {
                    await ctx.service.uninstall(plugin);
                    ctx.service.deps.notifier.success(t.installer.removed(plugin.name));
                    ctx.refresh();
                } catch (err) {
                    ctx.service.deps.notifier.reportError(err, t.installer.removeFailed);
                }
            })
    );
}

/**
 * 移除确认。
 *
 * 用二次确认而不是直接删 —— 移除会删掉整个插件目录，而这个目录里
 * 可能有用户自己放进去的东西（插件的额外资源、配置等）。
 *
 * 这里用原生 `confirm` 而不是自建弹窗：只有一个是否问题，
 * 为它写一个 Modal 类不值得，而且原生 confirm 在 Obsidian 里表现正常。
 */
function confirmRemoval(ctx: TrackedPluginsContext, plugin: TrackedPlugin): boolean {
    return window.confirm(ctx.t.installer.removeConfirm(plugin.name));
}
