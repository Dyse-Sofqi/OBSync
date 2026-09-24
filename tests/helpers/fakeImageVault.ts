import type { App } from "obsidian";
import { TFile, TFolder, type TAbstractFile } from "../stubs/obsidian";

/**
 * 图片同步测试用的假库。
 *
 * ## 为什么不复用 `createFakeApp`
 *
 * 那个替身是给**安装器**写的：它的 vault 只有 `configDir` 与 `adapter`，
 * 文件系统走的是「路径 → 字符串」的内存 Map。图片同步用的是另一套 API
 * （`getFiles` / `readBinary` / `createBinary` / `modifyBinary` / `trashFile`），
 * 而且关心的是**字节**与**mtime**。硬塞进那个替身会让两边都变糊。
 *
 * ## 为什么要能控制 mtime
 *
 * 「本地有改动」的判据是 `mtime > 上次记录的 mtime`，而真实文件系统的
 * mtime 精度与写入时机都不受测试控制 —— 没有显式设 mtime 的能力，
 * 「本地改了要上传」这条最核心的用例根本写不出来（只能靠 sleep，
 * 那会让测试又慢又不稳）。
 */
export interface FakeImageVault {
    app: App;
    /** 路径 → 内容。 */
    files: Map<string, ArrayBuffer>;
    /** 已存在的目录。 */
    folders: Set<string>;
    /** 走过 `fileManager.trashFile` 的路径（删除本地就是靠它）。 */
    trashed: string[];
    /** 每库隔离的本地存储（状态清单在里面）。 */
    localStorage: Map<string, unknown>;
    /** 写入次数，用来断言「没有多余的动作」。 */
    writes: string[];

    /** 放一个文件进去，返回它的 `TFile`（可继续改 `stat.mtime`）。 */
    seed(path: string, options?: { text?: string; bytes?: number; mtime?: number }): TFile;
    /**
     * 把文件从库里拿掉 —— 模拟用户在 Obsidian 里删了它。
     *
     * 存在的理由是一个**时序**：Obsidian 的 `vault.on("delete")` 是在文件
     * **已经消失之后**才触发的。测试里 `seed` 出一个 `TFile` 来当事件参数，
     * 却忘了删掉它，被测代码看到的就还是「文件还在」——
     * 于是「删掉本地图 → 问要不要删云端」这条路径根本走不到。
     */
    remove(path: string): void;
    /** 读回文本（断言下载结果用）。 */
    text(path: string): string | undefined;
    /** 这个路径还在不在。 */
    has(path: string): boolean;
    /** 设一个文件的 mtime。 */
    setMtime(path: string, mtime: number): void;

    /**
     * 设一条 frontmatter —— 引用扫描要从 `metadataCache.getFileCache` 读它。
     */
    setFrontmatter(path: string, frontmatter: Record<string, unknown>): void;
    /**
     * 指定某个链接解析到哪儿。
     *
     * 不设时走替身自己的宽松解析（相对路径 → 库内绝对路径 → 同名文件）。
     * 需要精确控制「Obsidian 会把它解析成哪一个」时用它 —— 例如同名文件
     * 出现在两个文件夹里，而真正被引用的只是其中一个。
     */
    linkTo(link: string, path: string): void;
    /** 走过 `fileManager.renameFile` 的记录（重命名功能靠它）。 */
    renames: Array<{ from: string; to: string }>;
}

function toBuffer(options: { text?: string; bytes?: number } | undefined): ArrayBuffer {
    if (options?.text !== undefined) {
        return new TextEncoder().encode(options.text).buffer as ArrayBuffer;
    }
    const size = options?.bytes ?? 16;
    // 内容不重要（图片同步不解析像素），但长度必须准 ——
    // 「本地有改动」的第一条判据就是 `size` 变了没有。
    return new Uint8Array(size).fill(0x42).buffer;
}

export function createFakeImageVault(): FakeImageVault {
    const files = new Map<string, ArrayBuffer>();
    const mtimes = new Map<string, number>();
    const folders = new Set<string>();
    const trashed: string[] = [];
    const localStorage = new Map<string, unknown>();
    const writes: string[] = [];
    const frontmatter = new Map<string, Record<string, unknown>>();
    const linkTargets = new Map<string, string>();
    const renames: Array<{ from: string; to: string }> = [];

    const fileAt = (path: string): TFile | undefined => {
        if (!files.has(path)) return undefined;
        const file = new TFile(path);
        const data = files.get(path)!;
        file.stat = { size: data.byteLength, mtime: mtimes.get(path) ?? 0, ctime: 0 };
        return file;
    };

    const readText = (file: TFile): string => {
        const data = files.get(file.path);
        if (!data) throw new Error(`ENOENT: ${file.path}`);
        return new TextDecoder().decode(data);
    };

    const vault = {
        getFiles(): TFile[] {
            return [...files.keys()].map((path) => fileAt(path)!);
        },
        getAbstractFileByPath(path: string): TAbstractFile | null {
            const file = fileAt(path);
            if (file) return file;
            if (folders.has(path)) {
                const folder = new TFolder(path);
                return folder;
            }
            return null;
        },
        async read(file: TFile): Promise<string> {
            return readText(file);
        },
        /**
         * 引用扫描走的是它（真实 Obsidian 里 `cachedRead` 不落盘、快得多）。
         * 替身两者等价 —— 行为差异在这里不重要，重要的是**调用得到**。
         */
        async cachedRead(file: TFile): Promise<string> {
            return readText(file);
        },
        getResourcePath(file: TFile): string {
            return `app://fake/${file.path}`;
        },
        async readBinary(file: TFile): Promise<ArrayBuffer> {
            const data = files.get(file.path);
            if (!data) throw new Error(`ENOENT: ${file.path}`);
            return data;
        },
        async modifyBinary(file: TFile, data: ArrayBuffer): Promise<void> {
            writes.push(file.path);
            files.set(file.path, data);
            mtimes.set(file.path, Date.now());
        },
        async createBinary(path: string, data: ArrayBuffer): Promise<TFile> {
            writes.push(path);
            files.set(path, data);
            mtimes.set(path, Date.now());
            const parent = path.slice(0, path.lastIndexOf("/"));
            if (parent) folders.add(parent);
            return fileAt(path)!;
        },
        async createFolder(path: string): Promise<TFolder> {
            folders.add(path);
            return new TFolder(path);
        },
    };

    const state: FakeImageVault = {
        app: undefined as unknown as App,
        files,
        folders,
        trashed,
        localStorage,
        writes,
        renames,

        seed(path, options): TFile {
            files.set(path, toBuffer(options));
            mtimes.set(path, options?.mtime ?? 1_000);
            const parts = path.split("/");
            for (let index = 1; index < parts.length; index++) {
                folders.add(parts.slice(0, index).join("/"));
            }
            return fileAt(path)!;
        },

        text(path): string | undefined {
            const data = files.get(path);
            return data ? new TextDecoder().decode(data) : undefined;
        },

        remove(path): void {
            files.delete(path);
            mtimes.delete(path);
        },

        has(path): boolean {
            return files.has(path);
        },

        setMtime(path, mtime): void {
            mtimes.set(path, mtime);
        },

        setFrontmatter(path, value): void {
            frontmatter.set(path, value);
        },

        linkTo(link, path): void {
            linkTargets.set(link, path);
        },
    };

    state.app = {
        vault,
        /**
         * 删除本地走的是它 —— 与生产代码一致（见 `imageSyncService.execute`）。
         * 记下来而不是真删，是为了能断言「删的是哪一个」以及「有没有越界」。
         */
        fileManager: {
            async trashFile(file: TFile): Promise<void> {
                trashed.push(file.path);
                files.delete(file.path);
            },
            /**
             * 重命名。真实实现会**顺带更新库里所有指向它的链接**，替身不模拟
             * 那一步 —— 被断言的是「有没有走官方入口」，而链接更新是 Obsidian
             * 的保证，不是我们的代码。
             */
            async renameFile(file: TFile, newPath: string): Promise<void> {
                const data = files.get(file.path);
                if (!data) throw new Error(`ENOENT: ${file.path}`);
                if (files.has(newPath)) throw new Error(`EEXIST: ${newPath}`);
                const mtime = mtimes.get(file.path) ?? Date.now();
                renames.push({ from: file.path, to: newPath });
                files.delete(file.path);
                mtimes.delete(file.path);
                files.set(newPath, data);
                mtimes.set(newPath, mtime);
            },
        },
        metadataCache: {
            /**
             * 宽松解析：显式指定的目标 → 相对来源文件 → 库内绝对路径 → 同名文件。
             * 顺序与 Obsidian 的实际优先级接近，而引用扫描**本来就不依赖**
             * 它的精确性（所有匹配方式取并集）。
             */
            getFirstLinkpathDest(link: string, sourcePath: string): TFile | null {
                const explicit = linkTargets.get(link);
                if (explicit) return fileAt(explicit) ?? null;

                const slash = sourcePath.lastIndexOf("/");
                const base = slash < 0 ? "" : sourcePath.slice(0, slash + 1);
                const relative = `${base}${link}`;
                if (files.has(relative)) return fileAt(relative)!;
                if (files.has(link)) return fileAt(link)!;

                const name = link.slice(link.lastIndexOf("/") + 1);
                for (const path of files.keys()) {
                    if (path === name || path.endsWith(`/${name}`)) return fileAt(path)!;
                }
                return null;
            },
            getFileCache(file: TFile): { frontmatter?: Record<string, unknown> } {
                const value = frontmatter.get(file.path);
                return value ? { frontmatter: value } : {};
            },
        },
        loadLocalStorage(key: string): unknown {
            return localStorage.get(key) ?? null;
        },
        saveLocalStorage(key: string, data: unknown): void {
            if (data === null || data === undefined) localStorage.delete(key);
            else localStorage.set(key, data);
        },
    } as unknown as App;

    return state;
}
