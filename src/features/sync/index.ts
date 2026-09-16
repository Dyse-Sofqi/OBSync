import type { App } from "obsidian";
import { Platform } from "obsidian";
import { logger } from "../../core/logger";
import type { LocaleStrings } from "../../core/i18n";
import type { Notifier } from "../../core/notice";
import type { ObsyncSettings } from "../../core/settings";
import type { SecretStore } from "../../core/secretStore";
import { getVaultRoot, StatusBar } from "./statusBar";
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

    const statusBar = new StatusBar({ app: deps.app, t: deps.getT() });

    const service = new SyncService(git, {
        app: deps.app,
        notifier: deps.notifier,
        getT: deps.getT,
        getCommitTemplate: () => deps.getSettings().sync.commitMessage,
        getStrategy: (): SyncStrategy => deps.getSettings().sync.syncStrategy,
        getConflictGuideName: () => deps.getT().sync.conflictGuideFile,
    }, statusBar);

    const automatics = new Automatics(service, () => ({
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
