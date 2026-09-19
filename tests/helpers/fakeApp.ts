import os from "node:os";
import path from "node:path";
import type { App } from "obsidian";

/**
 * 假的 Obsidian app —— 用内存 Map 充当 vault 文件系统。
 *
 * 安装器最需要测的两件事（写入前备份、失败回滚）都发生在文件系统层面，
 * 用真实 vault 测不了「写到一半失败」这种情况，所以这里实现一个可以
 * **按需注入故障**的适配器。
 */

export interface FakePluginManager {
    enabledPlugins: Set<string>;
    manifests: Record<string, unknown>;
    loadManifest(path: string): Promise<void>;
    loadManifests(): Promise<void>;
    enablePluginAndSave(id: string): Promise<void>;
    disablePluginAndSave(id: string): Promise<void>;
}

/**
 * `app.customCss` 的替身 —— 主题相关的那个非公开 API。
 *
 * 只实现代码真正用到、且**行为要能被断言**的那几件：读当前主题、切换主题、
 * 请求重载。做成有状态而不是空壳，是因为这些状态决定了真实行为：
 * 「移除正在使用的主题要先切回默认」这段逻辑，靠空壳替身根本测不到。
 *
 * 想测「非公开 API 不可用」那条降级路径时，直接
 * `delete (fake.app as { customCss?: unknown }).customCss` 即可 ——
 * 守卫读的是 `app.customCss` 的存在性。
 */
export interface FakeCustomCss {
    /** 当前主题名。空串表示默认主题（与 Obsidian 里的语义一致）。 */
    theme: string;
    /** 收到的 setTheme 调用，按顺序记录。 */
    setThemeCalls: string[];
    /** requestLoadTheme 被调了几次。 */
    reloadRequests: number;
}

export interface FakeApp {
    app: App;
    /** 内存文件系统：路径 → 内容。 */
    files: Map<string, string>;
    /** 已存在的目录。 */
    folders: Set<string>;
    plugins: FakePluginManager;
    /** `app.customCss` 的替身（主题的非公开 API）。 */
    customCss: FakeCustomCss;
    /** 写入次数，用于断言"失败时没有留下半成品"。 */
    writes: string[];
    /**
     * 让匹配的路径**每次都**写入失败。
     * 用于测试「回滚也失败」这种最坏情况。
     */
    failWriteOn?: (path: string) => boolean;
    /**
     * 让匹配的路径**只失败一次**，之后恢复正常。
     * 用于模拟瞬时故障 —— 这是回滚机制真正要处理的场景。
     */
    failWriteOnceOn?: (path: string) => boolean;
    /** 触发已注册的 onLayoutReady 回调（模拟 Obsidian 启动完成）。 */
    runLayoutReady(): void;
    /** 已注册的工作区事件监听器（如 file-menu），供断言与手动触发。 */
    workspaceEvents: Array<{ event: string; callback: (...args: never[]) => void }>;
    /**
     * 右侧边栏叶子的替身 —— 记录「有没有真的去打开那个视图」。
     *
     * `openSyncView()` 这条路（侧栏图标 / 状态栏 / 命令面板）只有**请求**
     * Obsidian 打开视图这一步是可观察的，而这一步此前完全没被测过：
     * 图标点开的是安装器、状态栏压根不可点，用户找不到同步面板。
     */
    workspaceLeaves: {
        /** 收到的 setViewState 调用（打开视图）。 */
        viewStates: Array<{ type: string }>;
        /** revealLeaf 的入参。 */
        revealed: unknown[];
    };
}

const CONFIG_DIR = ".obsidian";

export function createFakeApp(initialFiles: Record<string, string> = {}): FakeApp {
    const files = new Map<string, string>(Object.entries(initialFiles));
    const folders = new Set<string>([
        CONFIG_DIR,
        `${CONFIG_DIR}/plugins`,
        // 真实的库未必有主题目录，但「有」是常态；测试要测没有的情况时
        // 用空的主题目录即可（list 返回空数组，与不存在时的降级路径等价）。
        `${CONFIG_DIR}/themes`,
    ]);
    const basePath = path.join(os.tmpdir(), "obsync-fake-vault");

    const layoutReadyCallbacks: Array<() => void> = [];
    const workspaceEvents: Array<{ event: string; callback: (...args: never[]) => void }> = [];
    const workspaceLeaves: FakeApp["workspaceLeaves"] = { viewStates: [], revealed: [] };
    /** 右侧边栏叶子的替身：只实现 `openSyncView()` 用到的那一个方法。 */
    const rightLeaf = {
        async setViewState(state: { type: string }): Promise<void> {
            workspaceLeaves.viewStates.push(state);
        },
    };

    // 从初始文件反推目录结构。不做这一步的话 `exists(某目录)` 会返回 false，
    // 于是「目录是否已存在」的判断全部失真 —— 回滚逻辑会误判成"全新安装"，
    // 把本该保留的插件目录整个删掉。
    for (const path of files.keys()) {
        const parts = path.split("/");
        for (let index = 1; index < parts.length; index++) {
            folders.add(parts.slice(0, index).join("/"));
        }
    }

    const state: FakeApp = {
        files,
        folders,
        writes: [],
        plugins: {
            enabledPlugins: new Set<string>(),
            manifests: {},
            async loadManifest() {},
            async loadManifests() {},
            async enablePluginAndSave(id: string) {
                state.plugins.enabledPlugins.add(id);
            },
            async disablePluginAndSave(id: string) {
                state.plugins.enabledPlugins.delete(id);
            },
        },
        app: undefined as unknown as App,
        customCss: {
            theme: "",
            setThemeCalls: [],
            reloadRequests: 0,
        },
        // 这两个在下面装配完 workspace 之后再赋真实实现（那时才有回调列表可触发）。
        runLayoutReady: () => undefined,
        workspaceEvents: [],
        workspaceLeaves,
    };

    const adapter = {
        /**
         * git 的 baseDir 来源。装配路径会调用它（见 `getVaultRoot`），
         * 缺了会在 `onload` 里直接 TypeError。
         *
         * 默认指向一个**不存在 git 仓库**的临时目录：这样 `git status`
         * 会走「不是仓库」的分支（UI 本就支持这个状态），而不是真去操作什么。
         */
        getBasePath(): string {
            return basePath;
        },
        async exists(path: string): Promise<boolean> {
            return files.has(path) || folders.has(path);
        },
        async list(dir: string): Promise<{ files: string[]; folders: string[] }> {
            // 与真实 adapter.list 同形：返回 vault 相对路径的直接子项。
            const prefix = dir.endsWith("/") ? dir : `${dir}/`;
            const childOf = (path: string): boolean =>
                path.startsWith(prefix) && !path.slice(prefix.length).includes("/");
            return {
                files: [...files.keys()].filter(childOf),
                folders: [...folders].filter((folder) => folder !== dir && childOf(folder)),
            };
        },
        async read(path: string): Promise<string> {
            const content = files.get(path);
            if (content === undefined) throw new Error(`ENOENT: ${path}`);
            return content;
        },
        async write(path: string, data: string): Promise<void> {
            if (state.failWriteOn?.(path)) {
                throw new Error(`injected write failure: ${path}`);
            }
            if (state.failWriteOnceOn?.(path)) {
                // 一次性：触发后立刻撤销，让回滚能正常写回去。
                state.failWriteOnceOn = undefined;
                throw new Error(`injected transient write failure: ${path}`);
            }
            state.writes.push(path);
            files.set(path, data);
            const parent = path.slice(0, path.lastIndexOf("/"));
            if (parent) folders.add(parent);
        },
        async mkdir(path: string): Promise<void> {
            folders.add(path);
        },
        async remove(path: string): Promise<void> {
            files.delete(path);
        },
        async rmdir(path: string, recursive: boolean): Promise<void> {
            const prefix = `${path}/`;
            for (const key of [...files.keys()]) {
                if (key === path || (recursive && key.startsWith(prefix))) files.delete(key);
            }
            for (const key of [...folders]) {
                if (key === path || (recursive && key.startsWith(prefix))) folders.delete(key);
            }
        },
    };

    state.app = {
        vault: { configDir: CONFIG_DIR, adapter },
        plugins: state.plugins,
        /**
         * 主题的非公开 API。形状照着真实实现收窄（见 themeFolder.ts 的
         * InternalCustomCss）—— 只放代码真正调用的那三个入口。
         */
        customCss: {
            get theme(): string {
                return state.customCss.theme;
            },
            set theme(value: string) {
                state.customCss.theme = value;
            },
            getTheme(): string {
                return state.customCss.theme;
            },
            setTheme(name: string): void {
                state.customCss.theme = name;
                state.customCss.setThemeCalls.push(name);
            },
            requestLoadTheme(): void {
                state.customCss.reloadRequests += 1;
            },
        },
        // 最小工作区。装配路径（main.ts 的 onload）会用到这几个方法 ——
        // 少一个就会以 TypeError 的形式在启动时炸，所以宁可都留着。
        workspace: {
            onLayoutReady(callback: () => void) {
                layoutReadyCallbacks.push(callback);
            },
            getActiveFile: () => null,
            // 右侧叶子的替身做成有状态的：`setViewState` 之后再查
            // `getLeavesOfType` 就能查到它 —— `openSyncView()` 是「先查、
            // 没有就建、建完再 reveal」，一个恒返回空的替身会让这条路径
            // 看起来"什么都没发生"。
            getLeavesOfType: (type: string) =>
                workspaceLeaves.viewStates.some((state) => state.type === type)
                    ? [rightLeaf]
                    : [],
            getRightLeaf: () => rightLeaf,
            revealLeaf: (leaf: unknown) => {
                workspaceLeaves.revealed.push(leaf);
            },
            on(event: string, callback: (...args: never[]) => void) {
                workspaceEvents.push({ event, callback });
                return { event, callback };
            },
        },
        // SecretStore 在拿不到 secretStorage 时会回退到这里。
        localStorage: new Map<string, unknown>(),
        loadLocalStorage(key: string) {
            return (state.app as unknown as { localStorage: Map<string, unknown> })
                .localStorage.get(key) ?? null;
        },
        saveLocalStorage(key: string, data: unknown) {
            const store = (state.app as unknown as { localStorage: Map<string, unknown> })
                .localStorage;
            if (data === null || data === undefined) store.delete(key);
            else store.set(key, data);
        },
    } as unknown as App;

    state.workspaceEvents = workspaceEvents;
    state.runLayoutReady = () => {
        for (const callback of layoutReadyCallbacks) callback();
    };

    return state;
}

/** 便捷方法：读取某个插件的文件。 */
export function readPluginFile(fake: FakeApp, pluginId: string, file: string): string | undefined {
    return fake.files.get(`${CONFIG_DIR}/plugins/${pluginId}/${file}`);
}

/** 便捷方法：构造一个已安装的插件目录。 */
export function seedPlugin(
    pluginId: string,
    files: Record<string, string>
): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [name, content] of Object.entries(files)) {
        result[`${CONFIG_DIR}/plugins/${pluginId}/${name}`] = content;
    }
    return result;
}

/** 便捷方法：读取某个主题的文件。 */
export function readThemeFile(fake: FakeApp, themeName: string, file: string): string | undefined {
    return fake.files.get(`${CONFIG_DIR}/themes/${themeName}/${file}`);
}

/** 便捷方法：构造一个已安装的主题目录。 */
export function seedTheme(
    themeName: string,
    files: Record<string, string>
): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [name, content] of Object.entries(files)) {
        result[`${CONFIG_DIR}/themes/${themeName}/${name}`] = content;
    }
    return result;
}

/**
 * 便捷方法：一份合法的主题 manifest。
 *
 * 字段形状取自真实主题（Minimal / Things / AnuPpuccin）：**没有 id**，
 * `minAppVersion` 有但不强制，多一个 `fundingUrl`。
 */
export function themeManifestRaw(
    name: string,
    version: string,
    extra: Record<string, unknown> = {}
): string {
    return JSON.stringify({ name, version, minAppVersion: "1.0.0", author: "someone", ...extra });
}
