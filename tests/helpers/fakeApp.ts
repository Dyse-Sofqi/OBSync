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

export interface FakeApp {
    app: App;
    /** 内存文件系统：路径 → 内容。 */
    files: Map<string, string>;
    /** 已存在的目录。 */
    folders: Set<string>;
    plugins: FakePluginManager;
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
}

const CONFIG_DIR = ".obsidian";

export function createFakeApp(initialFiles: Record<string, string> = {}): FakeApp {
    const files = new Map<string, string>(Object.entries(initialFiles));
    const folders = new Set<string>([CONFIG_DIR, `${CONFIG_DIR}/plugins`]);

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
    };

    const adapter = {
        async exists(path: string): Promise<boolean> {
            return files.has(path) || folders.has(path);
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
