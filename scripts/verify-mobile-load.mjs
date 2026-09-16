/**
 * 模拟移动端加载**构建产物**，验证它会不会在加载阶段就崩。
 *
 * ## 为什么需要这个验证（而不是只靠静态扫描）
 *
 * `manifest.json` 写的是 `isDesktopOnly: false`，意味着移动端用户可以安装并启用。
 * 而同步模块依赖 `simple-git` → 它在**模块初始化阶段**就
 * `require("child_process")` / `require("fs")`。移动端（Capacitor WebView）
 * **没有 Node 集成**，`require` 不存在 —— Obsidian 官方文档明确说这类调用
 * 「会让插件崩溃」。真发生的话，插件在移动端一启用就崩，连纯 HTTP 的安装器都用不了。
 *
 * `scripts/checks.mjs` 的「移动端安全」一项是从 `main.ts` 走**静态导入图**判断的，
 * 快，但只是推断。这个脚本直接跑**打包后的 main.js**，是实证 ——
 * 两者的关系是「快速守卫 + 发布前实证」，都保留。
 *
 * 压缩后的产物读不出结论（`__commonJS` 之类的名字会被改名），所以不读代码，直接跑。
 *
 * ## 做法
 *
 * 把产物包进一个函数，注入一个「对 node 内置模块抛错」的 require，观察加载是否抛异常。
 * 这等价于移动端的条件：那边 `require` 本身就不存在。
 *
 * ## 用法
 *
 *     pnpm verify:mobile      # 会先 build 再跑这个脚本
 *
 * 预期输出「加载结果：没有在加载阶段抛错」且尝试 require 的模块为「（无）」。
 * 若报 `require is not defined: fs`，说明有人把同步模块改回了**静态** import ——
 * 见 `src/main.ts` 里 `loadSyncModule` 的说明。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 仓库根目录 —— 从脚本位置推导，不受调用时的 cwd 影响。 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = path.join(ROOT, "main.js");

if (!fs.existsSync(BUNDLE)) {
    console.error(`找不到 ${BUNDLE}`);
    console.error("先构建：pnpm build（或直接用 pnpm verify:mobile，它会自动构建）");
    process.exit(1);
}

const NODE_BUILTINS = new Set([
    "child_process", "fs", "os", "path", "crypto", "stream", "util", "net",
    "tls", "http", "https", "zlib", "events", "buffer", "assert", "url",
    "querystring", "string_decoder", "tty", "dns", "dgram", "constants",
    "module", "worker_threads", "perf_hooks", "readline", "repl", "vm", "v8",
    "inspector", "async_hooks", "timers", "process",
]);

const attempted = [];
const blockingRequire = (id) => {
    if (id === "obsidian") return obsidianStub;
    if (id === "electron") return {};
    if (NODE_BUILTINS.has(id) || id.startsWith("node:")) {
        attempted.push(id);
        // 移动端没有 Node：require 本身就不存在。这里模拟成抛错。
        throw new Error(`require is not defined: ${id}`);
    }
    attempted.push(id);
    throw new Error(`module not found: ${id}`);
};

/** 够用的 Obsidian 替身：只保证模块顶层能跑（类定义、继承）。 */
const obsidianStub = new Proxy(
    {},
    {
        get(_target, prop) {
            if (prop === "__esModule") return true;
            // 任何被当作基类/构造器用的东西都给一个空类
            return class {
                constructor() {}
                addChild() {}
                registerEvent() {}
                addCommand() {}
                addSettingTab() {}
                addRibbonIcon() {
                    return {};
                }
                addStatusBarItem() {
                    return {};
                }
                registerView() {}
            };
        },
    }
);

const source = fs.readFileSync(BUNDLE, "utf8");

// 产物里会在顶层用到这些浏览器全局量（类定义阶段、模块级常量）。
globalThis.window = globalThis;
globalThis.document = {
    createElement: () => ({
        style: {},
        classList: { add() {}, remove() {}, toggle() {} },
        appendChild: (child) => child,
        addEventListener() {},
        setAttribute() {},
        remove() {},
    }),
    body: {},
    addEventListener() {},
};
globalThis.activeWindow = globalThis;
globalThis.activeDocument = globalThis.document;
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

try {
    const factory = new Function("require", "module", "exports", source);
    factory(blockingRequire, { exports: {} }, {});
    console.log("加载结果：没有在加载阶段抛错");
    console.log("期间尝试 require 的模块:", attempted.length ? attempted.join(", ") : "（无）");
    process.exit(0);
} catch (err) {
    console.log("加载阶段抛错 ❌");
    console.log("  错误:", String(err.message).slice(0, 160));
    console.log("  已尝试 require 的模块:", attempted.join(", ") || "（无）");
    console.log();
    console.log("这会让插件在移动端一启用就崩。检查 src/main.ts 是否有人把");
    console.log('同步模块改回了静态 import（应保持动态 import，见 loadSyncModule 的说明）。');
    process.exit(1);
}
