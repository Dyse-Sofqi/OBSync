import { describe, expect, it } from "vitest";
import { normalizeSettings } from "../../src/core/settings";
import { SecretStore } from "../../src/core/secretStore";
import { getHost, SUPPORTED_HOSTS } from "../../src/host/hostRegistry";
import { parseRepoRef, repoWebUrl } from "../../src/host/repoRef";
import type { RepoRef } from "../../src/host/types";
import { createFakeApp } from "../helpers/fakeApp";

/**
 * 「有哪些平台」只能有一处（`SUPPORTED_HOSTS`），其余使用点都从它派生。
 *
 * 这条规则不是洁癖 —— 四处副本里有一处是**持久化校验**：
 * `settings` 的 `VALID_HOSTS` 漏掉某个平台时，用户在**那个平台**上装的插件
 * 会在下次加载 `data.json` 时被当成非法条目**无声丢弃**（不报错，列表里就没了）。
 * `secretStore` 那处漏了，症状是「令牌明明存过却用不上」；设置页那处漏了，
 * 症状是「那个平台没有填令牌的地方」。
 *
 * 所以这里让四个使用点**互相印证**，而不是各自列一份平台名 ——
 * 各自列的话，加平台时每处都会照旧通过，漏的恰恰是新加的那个。
 */
describe("平台列表的单一事实来源", () => {
    /**
     * 兜住下面所有用例：它们都是「遍历 SUPPORTED_HOSTS」，一旦这个数组空了，
     * 循环体一次都不跑，全部照样绿。
     */
    it("前提：列表非空、无重复", () => {
        expect(SUPPORTED_HOSTS.length).toBeGreaterThan(0);
        expect(new Set(SUPPORTED_HOSTS).size).toBe(SUPPORTED_HOSTS.length);
    });

    it("每个平台都注册了 provider，且自称的平台名与列表一致", () => {
        // 复制粘贴写错（`gitee: new GitHubHost()`）只能这样抓 ——
        // 类型看不出来，两个类都满足 IRepoHost。
        const declared = SUPPORTED_HOSTS.map((kind) => {
            const host = getHost(kind);
            expect(host, kind).toBeDefined();
            expect(host.displayName.length, kind).toBeGreaterThan(0);
            return host.kind;
        });

        expect(declared).toEqual([...SUPPORTED_HOSTS]);
    });

    it("每个平台都能走一遍「拼网页地址 → 解析回来」", () => {
        // 域名映射漏一个，用户输这个平台的地址会被报成
        // 「该平台不是 GitHub 或 Gitee」—— 而它明明在受支持列表里。
        for (const kind of SUPPORTED_HOSTS) {
            const ref: RepoRef = { host: kind, owner: "owner", repo: "repo" };
            const url = repoWebUrl(ref);

            expect(parseRepoRef(url).host, `${kind}: ${url}`).toBe(kind);
        }
    });

    it("跟踪列表的校验接受所有受支持平台（否则条目会无声消失）", () => {
        for (const kind of SUPPORTED_HOSTS) {
            const settings = normalizeSettings({
                installer: {
                    tracked: [
                        {
                            host: kind,
                            owner: "owner",
                            repo: "repo",
                            pluginId: "demo",
                            name: "Demo",
                        },
                    ],
                },
            });

            expect(settings.installer.tracked.map((item) => item.host), kind).toEqual([kind]);
        }
    });

    it("令牌快照覆盖所有受支持平台", () => {
        const fake = createFakeApp();
        const store = new SecretStore(fake.app);
        for (const kind of SUPPORTED_HOSTS) store.setToken(kind, `${kind}-token`);

        const snapshot = store.snapshot();

        for (const kind of SUPPORTED_HOSTS) {
            expect(snapshot[kind], kind).toBe(`${kind}-token`);
        }
    });
});
