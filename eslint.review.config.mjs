import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

/**
 * 审核闸门 —— `pnpm lint:review`，**接在 `pnpm build` 里**。
 *
 * ## 为什么要有它
 *
 * 0.1.4 被社区审核打回两条，都是 `pnpm check`（`scripts/checks.mjs`）**看不见**的：
 *
 * | 审核报的 | 本仓库原有的防线 | 为什么没拦住 |
 * | --- | --- | --- |
 * | `obsidianmd/no-unsupported-api` ×4 | `checks.mjs` 第 1 项 | 它按**成员名**扫，而 `SecretStorage.*` 就在它的 `KNOWN_SAFE` 里被豁免了 —— 恰恰把审核要查的放过去了 |
 * | `eslint-comments/require-description` | 无 | 根本没查过指令注释 |
 *
 * 教训和前几轮同型：**自己重写一遍判据，就会重写一遍它的盲区。**
 * 所以这里不重写规则 —— 直接跑官方规则的**本体**。审核用哪条，闸门就用哪条。
 *
 * ## 为什么只开两条，而不是整套 recommended
 *
 * `pnpm lint`（完整那套）在 `src/` 上有约 48 条既有告警。把它们全设成 error
 * 会让闸门**从第一天起就是红的**，于是没人看 —— 那和没有闸门一样。
 * 所以这里**只把「审核打回过的」两条设成 error**，其余显式关闭：
 *
 * - 关闭是**算出来**的（下面遍历 recommended 收集规则名），不是手写清单 ——
 *   插件新增规则时，它会自动落进「关闭」一侧，不会某天突然把 build 弄红；
 * - 想纳入新规则，就在下面 `rules` 里加一行并写清为什么。
 *
 * 配套的运行时证据在 `tests/core/secretStore.test.ts`：lint 只能证明
 * 「成员访问没落在 obsidian.d.ts 的类型上」，证明不了「1.8.7 上真的不去调」。
 * 两条防线各管一半，缺一不可。
 */

const RECOMMENDED = obsidianmd.configs.recommended;

/** recommended 里出现过的全部规则名 —— 用来「只留两条、其余关掉」。 */
const recommendedRuleIds = new Set();
for (const block of RECOMMENDED) {
    for (const ruleId of Object.keys(block.rules ?? {})) recommendedRuleIds.add(ruleId);
}
const allOff = Object.fromEntries([...recommendedRuleIds].map((id) => [id, "off"]));

export default defineConfig([
    {
        ignores: [
            "node_modules/**",
            ".probe/**",
            "main.js",
            "esbuild.config.mjs",
            "scripts/**",
            "tests/**",
            "vitest.config.ts",
        ],
    },
    // 先铺开官方配置：parser、plugins、type-aware 设置都从它来。
    ...RECOMMENDED,
    {
        files: ["src/**/*.ts"],
        languageOptions: {
            parserOptions: {
                projectService: {
                    allowDefaultProject: ["eslint.config.*", "eslint.review.config.*"],
                },
                tsconfigRootDir: import.meta.dirname,
            },
        },
    },
    {
        files: ["src/**/*.ts"],
        /**
         * 关掉「没用到的 disable 指令」这条检查。
         *
         * 它在本配置里**必然误报**：下面把绝大多数规则设成了 off，于是
         * `// eslint-disable-next-line no-control-regex` 这类指令看起来「没用上」——
         * 但那是**这个配置没跑那条规则**，不是代码里的指令多余。
         * 实测：`themeName.ts` 的 `no-control-regex` 指令在这里被报 unused，
         * 而在完整的 `pnpm lint` 里是有效的。
         *
         * 判断「指令是否过期」需要完整规则集，那是 `pnpm lint` 的职责。
         */
        linterOptions: {
            reportUnusedDisableDirectives: "off",
        },
        rules: {
            ...allOff,

            /**
             * 用到的 API 不能比 manifest 的 minAppVersion 新。
             *
             * 判据：成员访问的类型来自 `obsidian.d.ts`，且该成员的 `@since`
             * 高于 manifest 承诺的版本时，必须被 `requireApiVersion("x.y.z")`
             * 守卫住（`if` / `&&` / 三元都认）。
             *
             * 踩坑记录：`typeof app.secretStorage?.getSecret === "function"`
             * 这种**运行时探测**它不认 —— 逻辑上够用，但审核会报错。
             */
            "obsidianmd/no-unsupported-api": "error",

            /**
             * `eslint-disable` 必须写明理由。
             *
             * 判据：`// eslint-disable-next-line rule -- 说明`。没有 `--` 之后的
             * 描述就报错。
             *
             * 由来：`themeName.ts` 里那条 `no-control-regex` 是**有意**匹配控制
             * 字符的（不是笔误），但注释里没写，审核按「无法判断是否有必要」打回。
             */
            "eslint-comments/require-description": "error",
        },
    },
]);