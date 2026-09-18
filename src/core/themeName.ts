/**
 * 主题目录名的校验 —— 它同时是主题的**身份**。
 *
 * ## 为什么不能复用 `PLUGIN_ID_RE`
 *
 * `core/pluginId.ts` 的规则是 `/^[a-z0-9-]+$/`，管的是插件 manifest 的 `id` ——
 * 作者自己定的技术标识，全小写加连字符。主题**没有 id 字段**：主题的身份就是
 * 它在 `{configDir}/themes/` 下的**目录名**（`app.customCss.setTheme()` 收的也是
 * 这个名字），而那个名字来自 manifest 的 `name`，即用户在「外观」里看到的名字 ——
 * `Minimal`、`Blue Topaz`、`AnuPpuccin`、`Rose Red`。拿插件 id 的正则去卡它们，
 * 绝大多数真实主题都会被判非法，于是「一个都绑不上」。
 *
 * ## 要守的不变量和 pluginId 是同一条：这一串会成为路径的一截
 *
 * 移除时 `removeItemFolder()` 会 `rmdir(folder, true)` **递归**删除，而 folder 由
 * `{configDir}/themes/{name}` 拼出。`".."`、`"../.."`、带路径分隔符的名字会让删除
 * 目标跑出 `themes/`。所以判据只管**路径安全**，不管名字长什么样：
 *
 * - 允许：空格、大写、非 ASCII（含中日韩）；
 * - 拦下：空串、`.`、`..`、首尾空白、任何路径分隔符、控制字符，
 *   以及以点结尾的名字（Windows 会静默去掉结尾的点，写进去和读出来就不是
 *   同一个名字了 —— 那种「找不到自己刚建的目录」最难查）。
 *
 * 反过来说，**不**在这里拦 Windows 的非法字符（`:` `?` `*` 等）：它们在 macOS /
 * Linux 上合法，而这段代码跑在用户自己的机器上，比文件系统更严只会挡住合法主题。
 */
export function isValidThemeName(value: unknown): value is string {
    if (typeof value !== "string" || value.length === 0) return false;
    if (value === "." || value === "..") return false;
    // 首尾空白一并拦掉：`"Minimal "` 与 `"Minimal"` 在 Windows 上是同一个目录，
    // 在 Linux 上不是 —— 这种名字只会在跨设备时制造「主题凭空消失」。
    if (value !== value.trim()) return false;
    if (value.endsWith(".")) return false;
    if (value.includes("/") || value.includes("\\")) return false;
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(value)) return false;
    return true;
}
