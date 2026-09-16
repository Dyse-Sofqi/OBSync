/**
 * Obsidian API 的最小 stub。
 *
 * Obsidian 的 API 只在应用内部存在，所以测试通过 vitest 的 alias
 * 把 `obsidian` 指到这里（见 vitest.config.ts）。参考项目 obsidian-git
 * 用的是同一套办法（`tests/stubs/obsidian.ts`）。
 *
 * 只实现我们真正用到的部分 —— 多实现的部分如果行为不对，比不实现更危险。
 */

type RequestUrlHandler = (request: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string | ArrayBuffer;
}) => Promise<{
    status: number;
    headers?: Record<string, string>;
    text?: string;
    arrayBuffer?: ArrayBuffer;
}>;

let requestUrlHandler: RequestUrlHandler | undefined;
let language = "en";

/** 测试里注入假的 HTTP 响应。 */
export function __setRequestUrlHandler(handler: RequestUrlHandler | undefined): void {
    requestUrlHandler = handler;
}

/** 测试里模拟 Obsidian 的界面语言。 */
export function __setLanguage(value: string): void {
    language = value;
}

export function getLanguage(): string {
    return language;
}

let apiVersion = "1.13.1";

/** 测试里模拟当前 Obsidian 版本，用于校验 manifest 的 minAppVersion。 */
export function __setApiVersion(value: string): void {
    apiVersion = value;
}

/** 与真实实现同义：当前版本是否 ≥ 传入版本。 */
export function requireApiVersion(version: string): boolean {
    const parse = (input: string): number[] =>
        input
            .split(".")
            .map((part) => Number.parseInt(part, 10))
            .map((part) => (Number.isFinite(part) ? part : 0));

    const current = parse(apiVersion);
    const required = parse(version);

    for (let index = 0; index < Math.max(current.length, required.length); index++) {
        const a = current[index] ?? 0;
        const b = required[index] ?? 0;
        if (a !== b) return a > b;
    }
    return true;
}

let desktop = true;

/** 测试里模拟移动端 / 桌面端。 */
export function __setDesktop(value: boolean): void {
    desktop = value;
}

export class Platform {
    static get isDesktopApp(): boolean {
        return desktop;
    }
    static get isMobileApp(): boolean {
        return !desktop;
    }
    static get isDesktop(): boolean {
        return desktop;
    }
    static get isMobile(): boolean {
        return !desktop;
    }
    static get isWin(): boolean {
        return process.platform === "win32";
    }
    static get isMacOS(): boolean {
        return process.platform === "darwin";
    }
    static get isLinux(): boolean {
        return process.platform === "linux";
    }
}

export class Notice {
    static instances: Notice[] = [];
    constructor(
        public message: string | DocumentFragment,
        public timeout?: number
    ) {
        Notice.instances.push(this);
    }
    setMessage(message: string): this {
        this.message = message;
        return this;
    }
    hide(): void {}
}

export function requestUrl(request: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string | ArrayBuffer;
    throw?: boolean;
}): Promise<{
    status: number;
    headers: Record<string, string>;
    text: string;
    arrayBuffer: ArrayBuffer;
    json: unknown;
}> {
    if (!requestUrlHandler) {
        return Promise.reject(
            new Error(`requestUrl called without a handler: ${request.url}`)
        );
    }
    return requestUrlHandler(request).then((response) => {
        const text = response.text ?? "";
        return {
            status: response.status,
            headers: response.headers ?? {},
            text,
            // 真实 Obsidian 的 arrayBuffer 始终反映响应体。处理器只给文本时
            // 必须从文本派生，否则 release 资产下载（走 arrayBuffer）会静默
            // 变成空内容，测试就会以「manifest 不是合法 JSON」的方式误报。
            arrayBuffer:
                response.arrayBuffer ?? new TextEncoder().encode(text).buffer as ArrayBuffer,
            // 真实 Obsidian 的 `json` 是惰性 getter，只在访问时才解析。
            // 写成立即求值会让非 JSON 响应（比如 raw 文件）误抛异常。
            get json(): unknown {
                return text ? JSON.parse(text) : undefined;
            },
        };
    });
}

export function normalizePath(path: string): string {
    return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
}

export function debounce<T extends (...args: never[]) => unknown>(
    fn: T,
    timeout = 0
): (...args: Parameters<T>) => void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return (...args: Parameters<T>) => {
        if (timer !== undefined) clearTimeout(timer);
        timer = setTimeout(() => fn(...args), timeout);
    };
}

/** 设置项构建器的最小可用版本 —— 只够让设置页代码跑起来不报错。 */
export class Setting {
    settingEl = document.createElement("div");
    constructor(public containerEl: HTMLElement) {
        containerEl.appendChild(this.settingEl);
    }
    setName(): this {
        return this;
    }
    setDesc(): this {
        return this;
    }
    setHeading(): this {
        return this;
    }
    setClass(): this {
        return this;
    }
    addText(): this {
        return this;
    }
    addToggle(): this {
        return this;
    }
    addDropdown(): this {
        return this;
    }
    addButton(): this {
        return this;
    }
    addExtraButton(): this {
        return this;
    }
    then(callback: (value: this) => unknown): this {
        callback(this);
        return this;
    }
}

export class PluginSettingTab {
    containerEl = document.createElement("div");
    constructor(
        public app: unknown,
        public plugin: unknown
    ) {}
    display(): void {}
    hide(): void {}
}

/**
 * 插件基类。
 *
 * 这几个 `addXxx` 方法**必须存在**，否则装配路径（`main.ts` 的 `onload`）
 * 一跑就 `TypeError`。这不是假想的风险：曾经把状态栏元素挂到
 * `app.workspace.addStatusBarItem()` 上，而真实 API 在 `Plugin` 类上 ——
 * 单测全绿、真机启动才炸。补上这些方法后，`tests/pluginBoot.test.ts`
 * 能在编译期之外把这类错误也拦住。
 */
export class Plugin {
    app: unknown = {};
    manifest = { id: "obsync", version: "0.0.0" };
    /** 记录注册了什么，供冒烟测试断言。 */
    readonly registered = {
        commands: [] as Array<{ id: string; name: string }>,
        views: [] as string[],
        settingTabs: 0,
        ribbonIcons: 0,
        statusBarItems: 0,
        events: 0,
    };

    constructor(app?: unknown, manifest?: unknown) {
        if (app) this.app = app;
        if (manifest) this.manifest = manifest as typeof this.manifest;
    }
    async loadData(): Promise<unknown> {
        return {};
    }
    async saveData(): Promise<void> {}
    addSettingTab(): void {
        this.registered.settingTabs += 1;
    }
    addRibbonIcon(): HTMLElement {
        this.registered.ribbonIcons += 1;
        return document.createElement("div");
    }
    addCommand(command: { id: string; name: string }): void {
        this.registered.commands.push({ id: command.id, name: command.name });
    }
    addStatusBarItem(): HTMLElement {
        this.registered.statusBarItems += 1;
        return document.createElement("div");
    }
    registerView(type: string): void {
        this.registered.views.push(type);
    }
    registerEvent(): void {
        this.registered.events += 1;
    }
}

export class Events {
    on(): void {}
    off(): void {}
    trigger(): void {}
}

export class ItemView {
    containerEl = document.createElement("div");
    constructor(public leaf: unknown) {}
    getViewType(): string {
        return "";
    }
    getDisplayText(): string {
        return "";
    }
    async onOpen(): Promise<void> {}
    async onClose(): Promise<void> {}
}

export class Modal {
    containerEl = document.createElement("div");
    constructor(public app: unknown) {}
    open(): void {}
    close(): void {}
    onOpen(): void {}
    onClose(): void {}
}

export class FuzzySuggestModal<T> extends Modal {
    getItems(): T[] {
        return [];
    }
    getItemText(): string {
        return "";
    }
    onChooseItem(): void {}
}

export class SuggestModal<T> extends Modal {
    getSuggestions(): T[] {
        return [];
    }
    renderSuggestion(): void {}
    onChooseSuggestion(): void {}
}
