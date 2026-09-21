import { afterEach, describe, expect, it } from "vitest";
import { __setApiVersion } from "../stubs/obsidian";
import { SecretStore } from "../../src/core/secretStore";
import { createFakeApp } from "../helpers/fakeApp";

/**
 * 令牌存储的**版本守卫**。
 *
 * 这一组用例存在的理由不是「代码能不能跑」——845 条测试里早就跑过了。
 * 它守的是社区审核那条 `obsidianmd/no-unsupported-api`：
 * `app.secretStorage` 与它的 `getSecret` / `setSecret` 都是 **1.11.4** 才有的，
 * 而 manifest 承诺的 `minAppVersion` 是 **1.8.7**。于是「SecretStorage 优先、
 * 老版本回退 localStorage」这个回退**必须真的按版本分支**，
 * 而不是只靠 `typeof … === "function"` 探测。
 *
 * 为什么这条不能只交给 lint：lint 只看**声明**（成员访问是否落在 obsidian.d.ts
 * 的类型上），它证明不了「1.8.7 上不会去调」这件事真的成立。
 * 下面第一条用例就是反过来验的：**把版本调低，SecretStorage 明明在也不许用**。
 * 两条防线缺一不可 —— 只留 lint，代码可以写成「守卫是装饰、实际照样调用」；
 * 只留这条测试，`no-unsupported-api` 又会重新报错。
 */

/** 造一个「有 SecretStorage」的 app，并记录它被读写了什么。 */
function appWithSecretStorage() {
    const fake = createFakeApp();
    const secrets = new Map<string, string>();
    const calls: string[] = [];

    (fake.app as unknown as { secretStorage: unknown }).secretStorage = {
        getSecret(id: string) {
            calls.push(`get:${id}`);
            return secrets.get(id) ?? null;
        },
        setSecret(id: string, value: string) {
            calls.push(`set:${id}`);
            secrets.set(id, value);
        },
    };

    return { fake, store: new SecretStore(fake.app), secrets, calls };
}

afterEach(() => {
    // 别的用例（manifest 那条）也读这个全局版本，别把状态漏出去。
    __setApiVersion("1.13.1");
});

describe("SecretStore 的 SecretStorage 版本守卫", () => {
    it("Obsidian < 1.11.4：SecretStorage 存在也不用，回退 localStorage", () => {
        __setApiVersion("1.10.0");
        const { fake, store, secrets, calls } = appWithSecretStorage();

        store.setToken("github", "tok");
        const read = store.getToken("github");

        // 关键断言：**一次都没碰** SecretStorage。这正是审核要的语义 ——
        // 1.8.7~1.11.3 上没有这个 API，碰它就是崩。
        expect(calls).toEqual([]);
        expect(secrets.size).toBe(0);
        expect(store.isUsingSecretStorage()).toBe(false);

        // 值确实进了按库隔离的 localStorage，没丢。
        expect(read).toBe("tok");
        expect(fake.app.loadLocalStorage("obsync-token-github")).toBe("tok");
    });

    it("恰好 1.11.4：开始使用 SecretStorage（边界不是 1.11.5）", () => {
        __setApiVersion("1.11.4");
        const { fake, store, secrets, calls } = appWithSecretStorage();

        store.setToken("github", "tok");

        expect(store.isUsingSecretStorage()).toBe(true);
        expect(secrets.get("obsync-token-github")).toBe("tok");
        expect(calls).toContain("set:obsync-token-github");
        // 走了 SecretStorage 就不该再往 localStorage 写一份。
        expect(fake.app.loadLocalStorage("obsync-token-github")).toBeNull();
    });

    it("1.11.4 但 app.secretStorage 缺失（真机可能如此）：仍回退 localStorage", () => {
        __setApiVersion("1.13.1");
        const fake = createFakeApp();
        const store = new SecretStore(fake.app);

        store.setToken("github", "tok");

        expect(store.isUsingSecretStorage()).toBe(false);
        expect(fake.app.loadLocalStorage("obsync-token-github")).toBe("tok");
    });

    it("清空令牌在两条路径下都生效", () => {
        __setApiVersion("1.13.1");
        const { fake, store, secrets } = appWithSecretStorage();

        store.setToken("github", "tok");
        store.clearToken("github");

        // SecretStorage 没有 delete，约定用空串清除。
        expect(secrets.get("obsync-token-github")).toBe("");
        expect(store.getToken("github")).toBeUndefined();
        expect(fake.app.loadLocalStorage("obsync-token-github")).toBeNull();
    });
});
