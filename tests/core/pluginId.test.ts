import { describe, expect, it } from "vitest";
import { isValidPluginId, PLUGIN_ID_RE } from "../../src/core/pluginId";
import { normalizeSettings } from "../../src/core/settings";
import { parsePluginManifest } from "../../src/features/installer/manifest";

/**
 * `src/core/pluginId.ts` 存在的理由就是**不让两个使用者各写一份正则**。
 *
 * 所以这个文件里最重要的不是「正则本身对不对」（那是实现细节），
 * 而是**两个使用者会不会漂**：安装时 `parsePluginManifest` 接受了某个 id，
 * 读 `data.json` 时 `normalizeSettings` 却不认它 —— 那用户的跟踪条目
 * 会在一轮重启后无声消失，而没有任何提示。
 *
 * ## 这两条一致性测试为什么值得单独写
 *
 * `settings.test.ts` 里已经有一组「合法的 id 一个都不能丢」，但它**自己列 id**。
 * 如果哪天有人往 `PLUGIN_ID_RE` 里加了字符（比如放宽到允许下划线），
 * 那组用例的 id 全在旧集合里、照样全绿 —— 漏的恰恰是新允许的那类。
 * 这里不列 id，而是**让两个实现互相对照**：
 * 凡是 `parsePluginManifest` 放行的，`normalizeSettings` 就必须保留。
 */

/** 各种形态：合法的在前，越界的在后。 */
const SAMPLES = [
    "demo",
    "obsidian-git",
    "my-plugin-2",
    "a",
    "9",
    "x-1-2",
    "obsidian",
    "plugin--double",
    // 以下都不该被任何一处接受
    "",
    "..",
    "../..",
    "../../evil",
    "a/b",
    "a\\b",
    "/abs",
    "has space",
    "UPPER",
    "dot.name",
    "under_score",
    "-",
    " trailing",
    "trailing ",
];

/** 拼一个能被 `parsePluginManifest` 接收的 manifest 原文（其余字段都合法）。 */
function manifestRawWith(id: string): string {
    return JSON.stringify({
        id,
        name: "X",
        version: "1.0.0",
        minAppVersion: "1.5.0",
    });
}

function settingsRawWith(id: string) {
    return {
        installer: {
            tracked: [
                { kind: "plugin", host: "github", owner: "owner", repo: "repo", id, name: "X" },
            ],
        },
    };
}

function manifestAccepts(id: string): boolean {
    try {
        parsePluginManifest(manifestRawWith(id), "test");
        return true;
    } catch {
        return false;
    }
}

function settingsKeeps(id: string): boolean {
    return normalizeSettings(settingsRawWith(id)).installer.tracked.length === 1;
}

describe("PLUGIN_ID_RE", () => {
    it("接受：小写字母、数字、连字符", () => {
        for (const id of ["a", "9", "demo", "obsidian-git", "my-plugin-2", "x-1-2"]) {
            expect(PLUGIN_ID_RE.test(id), id).toBe(true);
            expect(isValidPluginId(id), id).toBe(true);
        }

        // 单个连字符也匹配规则。退化、但**不是路径风险**（它就是一段普通目录名），
        // 所以按规则接受；这条写在这里是免得有人看到它出现在接受组时以为写错了。
        expect(isValidPluginId("-")).toBe(true);
    });

    it("拒绝：大写、下划线、点、空格、路径分隔符、上跳", () => {
        for (const id of [
            "",
            "UPPER",
            "under_score",
            "dot.name",
            "has space",
            "a/b",
            "a\\b",
            "/abs",
            "..",
            "../..",
            "../../evil",
            "trailing ",
        ]) {
            expect(PLUGIN_ID_RE.test(id), id).toBe(false);
            expect(isValidPluginId(id), id).toBe(false);
        }
    });

    it("拒绝非字符串（`data.json` 里的值什么类型都可能有）", () => {
        for (const value of [undefined, null, 42, true, {}, [], () => undefined]) {
            expect(isValidPluginId(value)).toBe(false);
        }
    });
});

describe("两个使用者必须一致（防漂移）", () => {
    it("`parsePluginManifest` 放行的 id，`normalizeSettings` 一个都不能丢", () => {
        for (const id of SAMPLES) {
            if (!manifestAccepts(id)) continue;
            expect(
                settingsKeeps(id),
                `parseManifest 接受了 ${JSON.stringify(id)}，但 normalizeSettings 把它丢了 —— ` +
                    `用户装好的插件会在重启后从跟踪列表里无声消失`
            ).toBe(true);
        }
    });

    it("`normalizeSettings` 保留的 id，`parsePluginManifest` 也必须放行", () => {
        // 反方向：如果设置层比安装层宽，一个手改进 data.json 的畸形 id
        // 就能长留在跟踪列表里、并在卸载时被当成目录名 —— 那正是本组要防的。
        for (const id of SAMPLES) {
            if (!settingsKeeps(id)) continue;
            expect(manifestAccepts(id), `normalizeSettings 保留了 ${JSON.stringify(id)}`).toBe(
                true
            );
        }
    });

    it("两条一致性断言真的覆盖到了样本（不是空跑）", () => {
        // 上面两条都是「遍历 + continue」，写错过滤条件就会静默变成空循环。
        const accepted = SAMPLES.filter(manifestAccepts);
        const kept = SAMPLES.filter(settingsKeeps);

        expect(accepted.length).toBeGreaterThanOrEqual(6);
        expect(accepted).toEqual(kept);
    });
});
