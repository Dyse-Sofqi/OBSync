/**
 * 测试环境的全局补丁。
 *
 * Node 里没有 DOM，而设置页/弹窗代码会在模块顶层或构造时碰 `document`。
 * 这里补一个最小的 DOM 环境，避免测试因为无关的 DOM 缺失而失败。
 */

if (typeof globalThis.document === "undefined") {
    // 记录 `{ text, cls }` 这两个选项：列表/设置页的断言要看「这一行上写了什么」，
    // 空实现会让所有关于文案与徽标的用例失去意义（只能断言「没抛错」）。
    const createElement = (
        tag: string,
        options?: { text?: string; cls?: string; attr?: Record<string, string> }
    ): unknown => {
        const element: Record<string, unknown> = {
            tagName: tag.toUpperCase(),
            text: options?.text ?? "",
            cls: options?.cls ?? "",
            attrs: options?.attr ?? {},
            children: [] as unknown[],
            style: {},
            classList: { add: () => {}, remove: () => {}, toggle: () => {} },
            dataset: {},
            appendChild(child: unknown) {
                (element.children as unknown[]).push(child);
                return child;
            },
            removeChild() {},
            empty() {
                element.children = [];
            },
            // 真实的 Obsidian 里 `el.createEl()` **创建并挂到父节点上** ——
            // 替身若不挂，断言「这一行上有什么」就永远读到空数组。
            createEl(t: string, o?: { text?: string; cls?: string; attr?: Record<string, string> }) {
                const child = createElement(t, o);
                (element.children as unknown[]).push(child);
                return child;
            },
            createDiv(o?: { text?: string; cls?: string }) {
                const child = createElement("div", o);
                (element.children as unknown[]).push(child);
                return child;
            },
            createSpan(o?: { text?: string; cls?: string }) {
                const child = createElement("span", o);
                (element.children as unknown[]).push(child);
                return child;
            },
            // 真实的 Obsidian 里 `el.appendText()` 追加一个文本节点。
            // 替身把它记成子对象（与 `createEl({ text })` 同一形状），
            // 这样「这一行上写了什么」的断言仍然读得到 —— 缺了它，
            // 「前缀文字 + 可点开的链接」这种写法一跑就 TypeError。
            appendText(value: string) {
                (element.children as unknown[]).push({
                    text: value,
                    children: [] as unknown[],
                });
            },
            /**
             * 监听器**要真的记下来**，并给一个 `trigger(name)` 手动触发。
             *
             * 裸 DOM 上的交互（点提交 hash、点「查看差异」那个图标）此前
             * 完全测不到 —— 空实现下「点了有没有反应」只能靠肉眼。
             * 记下来之后，那些入口才验得了「点下去真的走到了服务」。
             */
            listeners: {} as Record<string, Array<(...args: unknown[]) => void>>,
            addEventListener(name: string, handler: (...args: unknown[]) => void) {
                const bucket = (element.listeners as Record<string, Array<(...a: unknown[]) => void>>)[
                    name
                ] ?? [];
                bucket.push(handler);
                (element.listeners as Record<string, Array<(...a: unknown[]) => void>>)[name] =
                    bucket;
            },
            /** 触发某个监听器（模拟用户点击）。 */
            trigger(name: string, ...args: unknown[]) {
                for (const handler of (element.listeners as Record<
                    string,
                    Array<(...a: unknown[]) => void>
                >)[name] ?? []) {
                    handler(...args);
                }
            },
            removeEventListener() {},
            setAttribute(name: string, value: string) {
                (element.attrs as Record<string, string>)[name] = value;
            },
            // Obsidian 在 HTMLElement 上加了这几个类操作，渲染路径会用到
            // （设置页切「已配置 / 未配置」的状态、列表加主操作强调色…）。
            // 替身少了任何一个，对应那一页就只会在真机上炸。
            addClass(cls: string) {
                const current = (element.cls as string).split(/\s+/).filter(Boolean);
                if (!current.includes(cls)) current.push(cls);
                element.cls = current.join(" ");
            },
            removeClass(cls: string) {
                element.cls = (element.cls as string)
                    .split(/\s+/)
                    .filter((item) => item && item !== cls)
                    .join(" ");
            },
            toggleClass(cls: string, value?: boolean) {
                const has = (element.cls as string).split(/\s+/).includes(cls);
                if (value ?? !has) (element.addClass as (c: string) => void)(cls);
                else (element.removeClass as (c: string) => void)(cls);
            },
            hasClass(cls: string) {
                return (element.cls as string).split(/\s+/).includes(cls);
            },
            setText(value: string) {
                element.text = value;
            },
            remove() {},
            // 弹窗会在 setTimeout 里对输入框调 focus()，缺失会变成未捕获异常
            focus() {},
            blur() {},
            // 真实 input 元素的原生方法：单文件重命名弹窗用它把预填的文件名
            // 整段选中。缺了它，「打开那个弹窗」这一步就直接 TypeError。
            select() {},
        };
        return element;
    };

    (globalThis as Record<string, unknown>).document = {
        createElement,
        body: createElement("body"),
        addEventListener() {},
        removeEventListener() {},
    };
}

if (typeof globalThis.window === "undefined") {
    (globalThis as Record<string, unknown>).window = globalThis;
}
