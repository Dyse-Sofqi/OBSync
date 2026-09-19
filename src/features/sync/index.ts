import type { App } from "obsidian";
import { Platform } from "obsidian";
import { logger } from "../../core/logger";
import type { LocaleStrings } from "../../core/i18n";
import type { Notifier } from "../../core/notice";
import type { ObsyncSettings } from "../../core/settings";
import type { SecretStore } from "../../core/secretStore";
import { getVaultRoot, StatusBar } from "./statusBar";
import { describeSyncError } from "./errors";
import { SimpleGitManager } from "./simpleGitManager";
import { SyncService } from "./syncService";
import { Automatics } from "./automatics";
import type { SyncStrategy } from "./types";

/**
 * 同步模块的装配入口（与 `features/installer/index.ts` 同构）。
 *
 * 移动端返回 undefined —— 决策是 v1 不支持移动端 git，
 * 主类据此跳过命令注册与定时器。
 */

export interface SyncModule {
    git: SimpleGitManager;
    service: SyncService;
    statusBar: StatusBar;
    automatics: Automatics;
    /** onLayoutReady 后调用：起定时器 + 首次状态刷新。 */
    start(): void;
    /** 插件卸载。 */
    stop(): void;
    /** 设置变化后调用（间隔/gitPath 变了要重起定时器与实例）。 */
    reload(): void;
}

export interface SyncDeps {
    app: App;
    notifier: Notifier;
    secretStore: SecretStore;
    getSettings(): ObsyncSettings;
    getT(): LocaleStrings;
    /** `plugin.addStatusBarItem()` —— 该 API 在 Plugin 类上，不在 workspace 上。 */
    createStatusBarItem(): HTMLElement;
    /** 点击状态栏条目时打开仓库同步视图（主类上的入口）。 */
    openSourceControlView(): void;
}

export function createSyncModule(deps: SyncDeps): SyncModule | undefined {
    // 决策（PLAN.md）：v1 仅桌面。isomorphic-git 的缺口是有意的。
    if (!Platform.isDesktopApp) {
        logger.info("sync module unavailable on mobile");
        return undefined;
    }

    const git = new SimpleGitManager({
        baseDir: getVaultRoot(deps.app),
        gitPath: deps.getSettings().sync.gitPath || undefined,
        secretStore: deps.secretStore,
    });

    // 注册本模块的错误翻译器：git 层抛的是技术性描述（它拿不到 t），
    // 用户能看懂的话在这里按类型拼。注册后所有调用点自动生效，不会漏。
    deps.notifier.registerErrorTranslator(describeSyncError);

    const statusBar = new StatusBar({
        item: deps.createStatusBarItem(),
        getT: deps.getT,
        onClick: () => deps.openSourceControlView(),
    });

    const service = new SyncService(git, {
        app: deps.app,
        notifier: deps.notifier,
        secretStore: deps.secretStore,
        getT: deps.getT,
        getCommitTemplate: () => deps.getSettings().sync.commitMessage,
        getStrategy: (): SyncStrategy => deps.getSettings().sync.syncStrategy,
        getConflictGuideName: () => deps.getT().sync.conflictGuideFile,
    }, statusBar);

    const automatics = new Automatics(service, () => ({
        enabled: deps.getSettings().sync.enabled,
        // 策略也必须传进来：`reset` 与自动同步不能并存（见 `AutomaticsSettings`）。
        // 只在设置页把开关灰掉是不够的 —— 库里**已经**存着 enabled + reset 的用户
        // 根本不会去动设置页，定时器会照跑，而 UI 看起来一切正常。
        syncStrategy: deps.getSettings().sync.syncStrategy,
        autoCommitMinutes: deps.getSettings().sync.autoCommitMinutes,
        autoPushMinutes: deps.getSettings().sync.autoPushMinutes,
        autoPullMinutes: deps.getSettings().sync.autoPullMinutes,
    }));

    return {
        git,
        service,
        statusBar,
        automatics,

        start(): void {
            automatics.start();
            void service.refresh();
        },

        stop(): void {
            automatics.stop();
        },

        reload(): void {
            // gitPath 变了要重建实例；间隔变了要重起定时器。
            git.applySettings({
                gitPath: deps.getSettings().sync.gitPath || undefined,
            });
            automatics.restart();
            void service.refresh();
        },
    };
}
