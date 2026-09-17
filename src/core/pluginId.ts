/**
 * 插件 id 的合法性判定。
 *
 * ## 为什么单独立一个模块
 *
 * 这个规则有两个**互不相干**的使用者：
 *
 * - `features/installer/manifest.ts` —— 安装时校验远端 manifest，不合规就拒绝安装；
 * - `core/settings.ts` —— 读 `data.json` 时校验 `tracked[].pluginId`。
 *
 * 后者容易漏掉（它是内层的一个 `typeof pluginId !== "string"`），但它的风险和前者
 * 一样真实：卸载时 `resolvePluginFolder()` 找不到同名目录就回落到
 * `{configDir}/plugins/{pluginId}`，紧接着 `rmdir(folder, true)` **递归**执行 ——
 * 也就是说一个含 `..` 的 id 会让删除目标跑出 `plugins/`。
 *
 * 两份正则各写各的，迟早会漂。放在这里，两边都从这里取。
 *
 * ## 规则本身
 *
 * Obsidian 的约定：**小写字母、数字、连字符**。不接受大写、下划线、点、空格 ——
 * 真插件全是这个形态，而放宽只会让「这个值是路径的一截」这件事失去保证。
 */
export const PLUGIN_ID_RE = /^[a-z0-9-]+$/;

export function isValidPluginId(value: unknown): value is string {
    return typeof value === "string" && PLUGIN_ID_RE.test(value);
}
