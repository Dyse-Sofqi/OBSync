#!/usr/bin/env node
/**
 * 项目自查。`pnpm check` 运行，全部只读。
 *
 * 这四项都是「编译器管不着、但会真出问题」的检查 —— 每一条都对应一个
 * 实际踩过的坑，不是理论洁癖：
 *
 * 1. **minAppVersion 一致性** —— manifest 承诺的最低版本必须覆盖代码用到的 API。
 *    写低了，低版本用户装上就崩（方法是 undefined），而 TypeScript 不会提醒
 *    （`node_modules/obsidian` 的类型永远是最新版）。实测踩过。
 * 2. **硬编码中文** —— i18n 的编译期保证只管「locale 之间结构一致」，
 *    管不住「代码里直接写了一句中文」。实测扫出 22 处用户可见的错误文案，
 *    意味着英文界面下会冒中文。
 * 3. **未使用的 i18n 键** —— 死键是信号：通常意味着漏接的本地化或没接线的功能。
 *    实测 4 个死键背后都是真缺口（撤销后无反馈、进度文案闲置、来源没显示…）。
 * 4. **CSS 类覆盖** —— 用了但没定义的类会静默丢样式；定义了没用的类是残留。
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SRC = path.join(ROOT, "src");
const failures = [];

// ── 工具 ────────────────────────────────────────────────────────────────────

function walk(dir, extension) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(full, extension));
        else if (entry.name.endsWith(extension)) out.push(full);
    }
    return out;
}

function read(file) {
    return fs.readFileSync(file, "utf8");
}

function relative(file) {
    return path.relative(ROOT, file).replace(/\\/g, "/");
}

/**
 * 剥掉注释。
 *
 * 扫描类检查（硬编码中文、CSS 类名）都要先剥注释，否则**注释里提到的类名/中文**
 * 会被算成"用到了"，掩盖真问题。字符串里的 `//` 会被误伤，但用于扫描足够。
 */
function stripComments(source) {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .filter((line) => {
            const trimmed = line.trim();
            return !trimmed.startsWith("//") && !trimmed.startsWith("*");
        })
        .join("\n");
}

function versionTuple(value) {
    const parts = String(value).match(/\d+/g) ?? [];
    return parts.map(Number);
}

function compareVersions(a, b) {
    const left = versionTuple(a);
    const right = versionTuple(b);
    for (let index = 0; index < Math.max(left.length, right.length); index++) {
        const diff = (left[index] ?? 0) - (right[index] ?? 0);
        if (diff !== 0) return diff;
    }
    return 0;
}

// ── 1. minAppVersion 一致性 ─────────────────────────────────────────────────

function checkMinAppVersion() {
    const dtsPath = path.join(ROOT, "node_modules/obsidian/obsidian.d.ts");
    if (!fs.existsSync(dtsPath)) {
        return { name: "minAppVersion", skipped: "未安装 obsidian 类型包" };
    }

    const manifest = JSON.parse(read(path.join(ROOT, "manifest.json")));
    const minApp = manifest.minAppVersion;

    /**
     * 我们会调用其成员的 Obsidian 类。
     *
     * **必须按类限定**：只按成员名匹配会大量误报 —— `.search()` / `.status()` /
     * `.filter()` 既可能是 Obsidian 的，也可能是我们自己的方法；而 Obsidian 新增的
     * 声明式设置 API（`SettingDefinition`）里有 `name` / `desc` / `addButton` 等同名成员，
     * `@since 1.13.0` —— 不限定就会把「我们没用过的 API」报成问题。
     */
    const WATCHED = new Set([
        "App", "ButtonComponent", "Component", "DataAdapter", "DropdownComponent",
        "Events", "ExtraButtonComponent", "FuzzySuggestModal", "ItemView", "Menu",
        "MenuItem", "Modal", "Notice", "Plugin", "PluginSettingTab", "SecretStorage",
        "Setting", "SuggestModal", "TextComponent", "ToggleComponent", "Vault",
        "Workspace", "WorkspaceLeaf",
    ]);

    /**
     * 已知「要求高于 minAppVersion 但安全」的用法。
     * 加进来**必须写清为什么安全** —— 否则这张表会变成掩盖问题的地方。
     */
    const KNOWN_SAFE = new Map([
        ["App.secretStorage", "SecretStore 运行时用 typeof 检查 getSecret 是否存在，老版本回退 localStorage"],
        ["SecretStorage.setSecret", "只在 secretStorage 存在时才调用（同上）"],
        ["SecretStorage.getSecret", "只在 secretStorage 存在时才调用（同上）"],
        ["Plugin.settings", "误报：d.ts 里一段提到 this.plugin.settings 的文档被算到了类作用域上"],
    ]);

    const source = read(dtsPath);

    // 顶层类/接口的位置，用来划分作用域
    const scopes = [];
    const scopeRe = /^export\s+(?:abstract\s+)?(?:class|interface)\s+(\w+)/gm;
    for (let match = scopeRe.exec(source); match; match = scopeRe.exec(source)) {
        scopes.push([match.index, match[1]]);
    }

    const scopeAt = (position) => {
        let current = undefined;
        for (const [start, name] of scopes) {
            if (start <= position) current = name;
            else break;
        }
        return current;
    };

    const annotations = new Map();
    const docRe = /\/\*\*(?<doc>[\s\S]*?)\*\/\s*(?<decl>[^\n;{]*)/g;
    for (let match = docRe.exec(source); match; match = docRe.exec(source)) {
        const since = /@since\s+([\d.]+)/.exec(match.groups.doc);
        if (!since) continue;

        const owner = scopeAt(match.index);
        if (!owner) continue;

        const name = /^(?:readonly\s+|static\s+|get\s+|set\s+)?([A-Za-z_$][\w$]*)/.exec(
            match.groups.decl.trim()
        );
        if (!name) continue;

        const key = `${owner}.${name[1]}`;
        const current = annotations.get(key);
        if (!current || compareVersions(since[1], current) > 0) {
            annotations.set(key, since[1]);
        }
    }

    const code = walk(SRC, ".ts").map(read).join("\n");
    const offenders = [];
    const exempted = [];

    for (const [key, since] of annotations) {
        const owner = key.split(".")[0];
        if (!WATCHED.has(owner)) continue;
        if (compareVersions(since, minApp) <= 0) continue;

        const member = key.split(".")[1];
        if (!new RegExp(`\\.${member}\\b`).test(code)) continue;

        if (KNOWN_SAFE.has(key)) exempted.push(`${key} (要求 ${since}，${KNOWN_SAFE.get(key)})`);
        else offenders.push(`${key} 要求 ${since}`);
    }

    if (offenders.length > 0) {
        failures.push(
            `minAppVersion 是 ${minApp}，但代码用到更高的 API：\n      ` +
                offenders.join("\n      ") +
                `\n      要么换掉这些 API，要么把 manifest.json 的 minAppVersion 提上去；` +
                `确实安全就加进 scripts/checks.mjs 的 KNOWN_SAFE 并写清理由。`
        );
    }

    return {
        name: "minAppVersion 一致性",
        detail: `minAppVersion=${minApp}，豁免 ${exempted.length} 处`,
    };
}

// ── 2. 硬编码中文 ───────────────────────────────────────────────────────────

function checkHardcodedCjk() {
    const CJK = /[\u4e00-\u9fff]/;

    /**
     * 允许保留的硬编码中文，附理由。
     *
     * 加进来时必须能回答一个问题：**这句中文会给用户看吗？**
     * 会的话就该进 locale；不会的话说明理由。
     */
    const ALLOWED = new Map([
        [
            "src/core/i18n/index.ts",
            "语言下拉的选项标签 —— 本就该用各自的母语书写（English 同理）",
        ],
        [
            "src/host/giteeHost.ts",
            "用于匹配 Gitee 限流响应体的检测词，不是给用户看的文案",
        ],
    ]);

    const findings = [];
    const allowed = [];
    for (const file of walk(SRC, ".ts")) {
        const rel = relative(file);
        if (rel.includes("/locales/")) continue;

        const reason = ALLOWED.get(rel);
        const lines = stripComments(read(file)).split("\n");
        lines.forEach((line, index) => {
            if (!CJK.test(line)) return;
            for (const match of line.match(/"[^"\n]*"|'[^'\n]*'|`[^`\n]*`/g) ?? []) {
                if (!CJK.test(match)) continue;
                const entry = `${rel}:${index + 1}  ${match.slice(0, 60)}`;
                if (reason) allowed.push(`${entry}  ← ${reason}`);
                else findings.push(entry);
                break;
            }
        });
    }

    if (findings.length > 0) {
        failures.push(
            `locale 之外有 ${findings.length} 处硬编码中文（英文界面下会露出来）：\n      ` +
                findings.join("\n      ") +
                `\n      确实不该进 locale 的，加进 scripts/checks.mjs 的 ALLOWED 并写清理由。`
        );
    }

    return {
        name: "硬编码中文",
        detail: `${findings.length} 处待处理，${allowed.length} 处已豁免`,
    };
}

// ── 3. 未使用的 i18n 键 ─────────────────────────────────────────────────────

function checkUnusedI18nKeys() {
    const localePath = path.join(SRC, "core/i18n/locales/zh-cn.ts");
    if (!fs.existsSync(localePath)) return { name: "未使用的 i18n 键", skipped: true };

    const collectKeys = (source) => {
        const keys = [];
        const stack = [];
        for (const line of source.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("/*")) continue;

            const match = /^(\w+):\s*(.*)$/.exec(trimmed);
            if (!match) continue;

            const indent = line.length - line.trimStart().length;
            while (stack.length > 0 && stack[stack.length - 1][0] >= indent) stack.pop();

            if (match[2].startsWith("{")) {
                stack.push([indent, match[1]]);
                continue;
            }
            keys.push([...stack.map((entry) => entry[1]), match[1]].join("."));
        }
        return keys;
    };

    const leafKeys = collectKeys(read(localePath));
    const code = walk(SRC, ".ts")
        .filter((file) => !relative(file).includes("/locales/"))
        .map(read)
        .join("\n");

    // 通用 UI 词汇表：留着比删了再加省事，不算问题。
    const GENERIC_PREFIXES = ["common.", "notice."];

    const unused = leafKeys.filter((key) => {
        if (GENERIC_PREFIXES.some((prefix) => key.startsWith(prefix))) return false;

        const parts = key.split(".");
        const leaf = parts.pop();
        const parent = parts.pop();

        // 静态访问：`.leaf`
        if (new RegExp(`\\.${leaf}\\b`).test(code)) return false;

        // 动态索引：`parent[expr]` —— 比如 `t.sync.diagnoseCheck[check.id]`。
        // 静态扫不到具体键名，但这类写法**确实在用整组键**，
        // 报成死键是误报。所以只要父对象被索引访问过，就视为已用。
        if (parent && new RegExp(`\\.${parent}\\s*\\[`).test(code)) return false;

        return true;
    });

    if (unused.length > 0) {
        failures.push(
            `有 ${unused.length} 个 i18n 键定义了却没被引用（通常是漏接的本地化或没接线的功能）：\n      ` +
                unused.join("\n      ")
        );
    }

    return { name: "未使用的 i18n 键", detail: `${unused.length} 个` };
}

// ── 4. CSS 类覆盖 ───────────────────────────────────────────────────────────

function checkCssClasses() {
    const cssPath = path.join(ROOT, "styles.css");
    if (!fs.existsSync(cssPath)) return { name: "CSS 类覆盖", skipped: true };

    /**
     * **不是** CSS 类名的 `obsync-*` 字符串。
     *
     * `obsync-` 这个前缀也被别的东西用着（存储键、视图类型标识）。
     * 加进来必须说明它是什么 —— 否则这张表会变成掩盖漏样式的地方。
     */
    const NOT_A_CLASS = [
        {
            match: (name) => name.startsWith("obsync-token-"),
            why: "SecretStore 的密钥 id 前缀",
        },
        {
            match: (name) => name.startsWith("obsync-last-auto-"),
            why: "Automatics 的「上次执行时间」存储键前缀",
        },
        {
            match: (name) => name === "obsync-sync-view",
            why: "源码控制视图的类型标识（registerView 用），不是 CSS 类",
        },
    ];

    /**
     * 收集代码里用到的类名。
     *
     * 全文扫而不是按行扫 —— 类名可能出现在多类名字符串里
     * （`cls: "obsync-badge obsync-badge-update"`）、
     * 或者跨行的三元赋值里（`const cls = a ? "obsync-x" : "obsync-y"`）。
     * 按行匹配会漏掉这两种，把它们误报成「定义了没用到」。
     */
    const used = new Set();
    for (const file of walk(SRC, ".ts")) {
        for (const match of stripComments(read(file)).matchAll(/obsync-[\w-]+/g)) {
            const name = match[0];
            if (NOT_A_CLASS.some((entry) => entry.match(name))) continue;
            used.add(name);
        }
    }

    const defined = new Set(
        [...read(cssPath).matchAll(/\.(obsync-[\w-]+)/g)].map((match) => match[1])
    );

    const missing = [...used].filter((name) => !defined.has(name));
    const zombie = [...defined].filter((name) => !used.has(name));

    if (missing.length > 0 || zombie.length > 0) {
        const parts = [];
        if (missing.length > 0) parts.push(`用了但没定义（会静默丢样式）：${missing.join(", ")}`);
        if (zombie.length > 0) parts.push(`定义了但没用到：${zombie.join(", ")}`);
        failures.push(parts.join("\n      "));
    }

    return { name: "CSS 类覆盖", detail: `${used.size} 用 / ${defined.size} 定义` };
}

// ── 跑 ──────────────────────────────────────────────────────────────────────

const results = [
    checkMinAppVersion(),
    checkHardcodedCjk(),
    checkUnusedI18nKeys(),
    checkCssClasses(),
];

console.log("OBSync 项目自查\n");
for (const result of results) {
    const status = result.skipped ? "跳过" : "通过";
    const detail = result.skipped ? `（${result.skipped}）` : result.detail ? ` — ${result.detail}` : "";
    console.log(`  [${status}] ${result.name}${detail}`);
}

if (failures.length > 0) {
    console.log("\n发现问题：\n");
    for (const failure of failures) console.log(`  - ${failure}\n`);
    process.exit(1);
}

console.log("\n全部通过 ✅");
