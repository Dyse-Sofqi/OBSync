/**
 * 测试环境的全局补丁。
 *
 * Node 里没有 DOM，而设置页/弹窗代码会在模块顶层或构造时碰 `document`。
 * 这里补一个最小的 DOM 环境，避免测试因为无关的 DOM 缺失而失败。
 */

if (typeof globalThis.document === "undefined") {
    const createElement = (tag: string): unknown => {
        const element: Record<string, unknown> = {
            tagName: tag.toUpperCase(),
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
            createEl(t: string) {
                return createElement(t);
            },
            createDiv() {
                return createElement("div");
            },
            createSpan() {
                return createElement("span");
            },
            addEventListener() {},
            removeEventListener() {},
            setAttribute() {},
            setText() {},
            remove() {},
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
