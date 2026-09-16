import type { App } from "obsidian";
import { CommunityPluginIndex } from "./communityPlugins";
import { describeInstallerError } from "./errors";
import { InstallerService, type InstallerHost } from "./installerService";
import { AddRepoModal } from "./ui/AddRepoModal";
import { BindExistingModal } from "./ui/BindExistingModal";
import { UpdateChecker } from "./updateChecker";

/**
 * 安装器模块的装配入口。
 *
 * 主类只调用 `createInstallerModule()` 拿到一组能力，再挂到命令和设置页上；
 * 模块内部怎么组织是模块自己的事。这样主类保持「只做装配」，
 * 不会像参考项目 obsidian-git 的 main.ts 那样长到 60KB。
 */

export interface InstallerModule {
    service: InstallerService;
    checker: UpdateChecker;
    communityIndex: CommunityPluginIndex;
    /** 打开「添加插件仓库」弹窗。 */
    openAddRepoModal(): void;
    /** 打开「绑定已有插件」弹窗。 */
    openBindExistingModal(onBound?: (count: number) => void): void;
    /** 启动后的自动更新检查（受设置控制）。 */
    scheduleStartupCheck(): void;
}

export function createInstallerModule(host: InstallerHost, app: App): InstallerModule {
    const service = new InstallerService(host);
    const checker = new UpdateChecker(service);
    const communityIndex = new CommunityPluginIndex();

    // 注册本模块的错误翻译器：逻辑层（manifest / pluginFiles / pluginFolder）
    // 抛的是「类型码 + 参数」，用户能看懂的话在这里按类型拼。
    // 不注册的话英文界面下会冒出中文错误（早期就是这么错的）。
    host.notifier.registerErrorTranslator(describeInstallerError);

    const module: InstallerModule = {
        service,
        checker,
        communityIndex,

        openAddRepoModal(): void {
            new AddRepoModal(app, service, communityIndex, host.getT(), () => {
                // 安装成功后不需要额外动作 —— 设置页下次渲染时自然带上新记录。
            }).open();
        },

        openBindExistingModal(onBound?: (count: number) => void): void {
            new BindExistingModal(
                app,
                service,
                communityIndex,
                host.getT(),
                (count) => onBound?.(count)
            ).open();
        },

        scheduleStartupCheck(): void {
            const settings = host.getSettings().installer;
            if (!settings.enabled || !settings.autoCheckOnStartup) return;

            const delayMs = settings.autoCheckDelaySeconds * 1000;
            window.setTimeout(() => {
                void runStartupCheck(module, host);
            }, delayMs);
        },
    };

    return module;
}

/**
 * 启动后的更新检查。
 *
 * 参考项目 BRAT 是「启动后延迟 60 秒检查，发现有更新就直接装」。
 * 这里只检查并提示，不自动安装 —— 插件替用户决定覆盖已装插件是越界的，
 * 而且更新失败时用户完全不知道发生了什么。
 */
async function runStartupCheck(module: InstallerModule, host: InstallerHost): Promise<void> {
    const t = host.getT();
    const tracked = host.getSettings().installer.tracked;
    if (tracked.length === 0) return;

    try {
        const summary = await module.checker.checkAll(tracked);
        if (summary.outdated === 0) return;

        const names = summary.results
            .filter((result) => result.hasUpdate)
            .map((result) => result.tracked.name)
            .join("、");

        host.notifier.info(t.installer.updatesAvailable(summary.outdated, names));
    } catch (err) {
        // 启动检查失败不该打扰用户 —— 它只是「顺便看看」。
        host.notifier.warn(t.installer.checkFailed);
        void err;
    }
}
