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
    /**
     * 提示条的内容元素。
     *
     * 真实 Notice 暴露 `noticeEl`，进度提示就是往它里面塞「圆环 + 文案」的
     * （见 `core/notice.ts` 的 `SpinnerNotice`）—— 替身少了它，那条路径
     * 一跑就 TypeError，而测试里根本到不了「有没有转圈」这个问题。
     */
    readonly noticeEl = document.createElement("div");
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

/**
 * `Setting` 里各控件的替身。
 *
 * 为什么不能是空实现：真实 `addText` / `addButton` 会把组件实例交给回调，回调里
 * 链式设置属性并注册事件。替身若不真的调用回调、不真的记住状态，那么「输入之后
 * 按钮才可用」这类**交互逻辑在测试里根本跑不到** —— AddRepoModal 的「识别」按钮
 * 一直置灰的缺陷，正是从这个盲区漏过去的（渲染一次算死，没有测试能发现）。
 *
 * 因此这里让替身保存真实状态，并提供 `type()` / `click()` 这样的「模拟用户操作」
 * 入口，使弹窗类代码可以在纯 Node 环境里被驱动与断言。
 */

export class TextComponent {
    value: string;
    disabled = false;
    placeholder = "";
    readonly inputEl = document.createElement("input");
    private changeHandler: ((value: string) => unknown) | undefined;

    constructor(value = "") {
        this.value = value;
    }
    setValue(value: string): this {
        this.value = value;
        return this;
    }
    getValue(): string {
        return this.value;
    }
    setPlaceholder(value: string): this {
        this.placeholder = value;
        return this;
    }
    setDisabled(value: boolean): this {
        this.disabled = value;
        return this;
    }
    onChange(callback: (value: string) => unknown): this {
        this.changeHandler = callback;
        return this;
    }
    /** 模拟用户输入：同步 value 并触发 onChange（等价于真实 input 事件）。 */
    type(value: string): this {
        this.value = value;
        this.changeHandler?.(value);
        return this;
    }
}

export class ButtonComponent {
    text = "";
    disabled = false;
    /**
     * 真实组件暴露的元素，列表用它给「主操作」加类（见 TrackedItemsList）。
     *
     * 注意这个属性在真实 API 里属于 **`ExtraButtonComponent`**（`addExtraButton`
     * 的回调拿到的是它）。替身把两个组件合成一个，所以 `addExtraButton` 也走这里。
     */
    readonly extraSettingsEl = document.createElement("div");
    /**
     * 真实 `ButtonComponent` 的元素（`extraSettingsEl` 是另一个组件的）。
     * 视图用它给单个按钮加类 —— 例如把「立即同步」顶到工具条右侧。
     */
    readonly buttonEl = document.createElement("div");
    cta = false;
    /** 「危险动作」标记（真实的 ButtonComponent 会把它渲染成警示色）。 */
    warning = false;
    tooltip = "";
    icon = "";
    clicks = 0;
    private clickHandler: (() => unknown) | undefined;

    setButtonText(value: string): this {
        this.text = value;
        return this;
    }
    setDisabled(value: boolean): this {
        this.disabled = value;
        return this;
    }
    setTooltip(value: string): this {
        this.tooltip = value;
        return this;
    }
    setIcon(value: string): this {
        this.icon = value;
        return this;
    }
    setCta(): this {
        this.cta = true;
        return this;
    }
    setWarning(): this {
        this.warning = true;
        return this;
    }
    onClick(callback: () => unknown): this {
        this.clickHandler = callback;
        return this;
    }
    /** 模拟点击，返回回调结果以便 await 异步流程。 */
    click(): unknown {
        this.clicks += 1;
        return this.clickHandler?.();
    }
}

export class ToggleComponent {
    value = false;
    disabled = false;
    private changeHandler: ((value: boolean) => unknown) | undefined;

    setValue(value: boolean): this {
        this.value = value;
        return this;
    }
    getValue(): boolean {
        return this.value;
    }
    setDisabled(value: boolean): this {
        this.disabled = value;
        return this;
    }
    onChange(callback: (value: boolean) => unknown): this {
        this.changeHandler = callback;
        return this;
    }
    /** 模拟用户切换。 */
    toggle(value: boolean): this {
        this.value = value;
        this.changeHandler?.(value);
        return this;
    }
}

export class DropdownComponent {
    /**
     * 真实的 `DropdownComponent` 暴露 `<select>` 元素本身。
     *
     * 视图会把「分支」这个标签挂到它的 `aria-label` 上（工具条里没有位置再写
     * 一个可见的标签），替身少了这个元素，那条路径一跑就 TypeError。
     */
    readonly selectEl = document.createElement("select");
    value = "";
    disabled = false;
    options: Array<{ value: string; label: string }> = [];
    private changeHandler: ((value: string) => unknown) | undefined;

    addOption(value: string, label: string): this {
        this.options.push({ value, label });
        return this;
    }
    addOptions(record: Record<string, string>): this {
        for (const [value, label] of Object.entries(record)) this.addOption(value, label);
        return this;
    }
    setValue(value: string): this {
        this.value = value;
        return this;
    }
    getValue(): string {
        return this.value;
    }
    setDisabled(value: boolean): this {
        this.disabled = value;
        return this;
    }
    onChange(callback: (value: string) => unknown): this {
        this.changeHandler = callback;
        return this;
    }
    /** 模拟用户选择。 */
    select(value: string): this {
        this.value = value;
        this.changeHandler?.(value);
        return this;
    }
}

/**
 * 测试用：按创建顺序记录所有 `Setting`。
 *
 * 弹窗的 `render()` 会在 `contentEl` 上直接 `new Setting(...)`，调用方拿不到引用，
 * 所以由替身集中登记。注意 `render()` 会重建内容区，因此断言时应取**最后一条**
 * 匹配项（或先 `resetCreatedSettings()`）。
 */
export const createdSettings: Setting[] = [];

export function resetCreatedSettings(): void {
    createdSettings.length = 0;
}

/** 设置项构建器的最小可用版本 —— 只够让设置页/弹窗代码跑起来并被驱动。 */
export class Setting {
    settingEl = document.createElement("div");
    readonly nameEl = document.createElement("div");
    readonly descEl = document.createElement("div");
    /** 名称与描述 —— 断言列表/设置页写了什么时要用。 */
    name = "";
    desc = "";
    readonly classes: string[] = [];
    readonly texts: TextComponent[] = [];
    readonly buttons: ButtonComponent[] = [];
    readonly toggles: ToggleComponent[] = [];
    readonly dropdowns: DropdownComponent[] = [];
    /**
     * 控件的**调用顺序**。
     *
     * 真实的 `Setting` 把每个控件按调用顺序 append 进同一个 `controlEl`，
     * 所以「谁在谁左边」就等于调用顺序。只分别看 `buttons` / `dropdowns`
     * 是验不了排布的 —— 而排布本身可能正是需求（「刷新在最右」「立即同步在
     * 分支下拉右边」这类），所以这里要能还原出完整的一条。
     */
    readonly controls: Array<
        ButtonComponent | DropdownComponent | ToggleComponent | TextComponent
    > = [];

    constructor(public containerEl: HTMLElement) {
        containerEl.appendChild(this.settingEl);
        createdSettings.push(this);
    }
    setName(name?: string): this {
        this.name = name ?? "";
        return this;
    }
    setDesc(desc?: string): this {
        this.desc = desc ?? "";
        return this;
    }
    setHeading(): this {
        return this;
    }
    setClass(cls?: string): this {
        if (cls) this.classes.push(cls);
        return this;
    }
    addText(callback?: (text: TextComponent) => unknown): this {
        const component = new TextComponent();
        this.texts.push(component);
        this.controls.push(component);
        callback?.(component);
        return this;
    }
    addButton(callback?: (button: ButtonComponent) => unknown): this {
        const component = new ButtonComponent();
        this.buttons.push(component);
        this.controls.push(component);
        callback?.(component);
        return this;
    }
    addExtraButton(callback?: (button: ButtonComponent) => unknown): this {
        return this.addButton(callback);
    }
    addToggle(callback?: (toggle: ToggleComponent) => unknown): this {
        const component = new ToggleComponent();
        this.toggles.push(component);
        this.controls.push(component);
        callback?.(component);
        return this;
    }
    addDropdown(callback?: (dropdown: DropdownComponent) => unknown): this {
        const component = new DropdownComponent();
        this.dropdowns.push(component);
        this.controls.push(component);
        callback?.(component);
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
    manifest = { id: "ob-sync", version: "0.0.0" };
    /** 记录注册了什么，供冒烟测试断言。 */
    readonly registered = {
        commands: [] as Array<{ id: string; name: string }>,
        views: [] as string[],
        settingTabs: 0,
        ribbonIcons: 0,
        /**
         * 侧栏图标的内容。
         *
         * 只数个数是不够的 —— 「唯一那个图标打开的是安装器，于是没人找得到
         * 同步面板」正是只数个数漏掉的问题。这里连图标名、悬停文案与点击
         * 回调一起记下来，测试才能验「点这个图标会发生什么」。
         */
        ribbons: [] as Array<{ icon: string; title: string; onClick: () => void }>,
        statusBarItems: 0,
        events: 0,
    };

    constructor(app?: unknown, manifest?: unknown) {
        if (app) this.app = app;
        if (manifest) this.manifest = manifest as typeof this.manifest;
    }
    /**
     * 落盘的数据。替身做成**有状态**的：启动路径里「加载 → 改设置 → 存回」
     * 这类行为（例如加载时清掉「待重启」标记）只有能读到存了什么才验得了。
     * 测试直接 `plugin.__data = {...}` 塞一份 data.json 进去即可。
     */
    __data: unknown = {};
    readonly savedData: unknown[] = [];

    async loadData(): Promise<unknown> {
        return this.__data;
    }
    async saveData(data: unknown): Promise<void> {
        this.savedData.push(data);
        this.__data = data;
    }
    addSettingTab(): void {
        this.registered.settingTabs += 1;
    }
    addRibbonIcon(icon: string, title: string, onClick: () => void): HTMLElement {
        this.registered.ribbonIcons += 1;
        this.registered.ribbons.push({ icon, title, onClick });
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
    /**
     * 视图的内容区。
     *
     * 真实的 `ItemView` 有它（视图把整页内容挂在上面），替身缺了它，
     * 任何「渲染一次看看画出了什么」的测试都跑不到 —— 一构造就 TypeError。
     */
    contentEl = document.createElement("div");
    /** 真实的 `ItemView`（Component）能拿到 app；视图用它打开库里的文件。 */
    app: unknown = {};
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
    readonly titleEl = document.createElement("div");
    readonly contentEl = document.createElement("div");
    constructor(public app: unknown) {}
    /** 与真实行为一致：open 触发 onOpen（弹窗的渲染都挂在它上面）。 */
    open(): void {
        this.onOpen();
    }
    close(): void {
        this.onClose();
    }
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
