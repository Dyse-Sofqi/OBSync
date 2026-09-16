import { describe, expect, it } from "vitest";
import { basicAuthHeader, credentialForRemote, withAuth } from "../../src/features/sync/auth";
import { SecretStore } from "../../src/core/secretStore";
import { createFakeApp } from "../helpers/fakeApp";

/**
 * extraheader 鉴权的纯函数部分。
 *
 * 注意：这里验证的是「构造出的 git 配置长什么样」；
 * 配置真的能通过 Gitee/GitHub 的私有仓库推送，属于 live 验证
 * （PLAN.md 风险表第一条，见 docs/HANDOVER.md 第七节）。
 */

function storeWith(tokens: Partial<Record<"github" | "gitee", string>>): SecretStore {
    const fake = createFakeApp();
    const store = new SecretStore(fake.app);
    for (const [host, token] of Object.entries(tokens)) {
        store.setToken(host as "github" | "gitee", token!);
    }
    return store;
}

describe("basicAuthHeader", () => {
    it("生成 base64(user:token) 形式的 Authorization 头", () => {
        // base64("git:tok-123") = "Z2l0OnRvay0xMjM="
        expect(basicAuthHeader("git", "tok-123")).toBe(
            "Authorization: Basic Z2l0OnRvay0xMjM="
        );
    });

    it("用户名原样进 base64（本函数不做任何平台判断）", () => {
        // 用户名该填什么由 host 层决定（见下面的 withAuth 用例），
        // 这里只保证编码是「用户名:令牌」的直译，不掺别的逻辑。
        expect(basicAuthHeader("someone", "t")).toContain(
            Buffer.from("someone:t").toString("base64")
        );
    });
});

describe("credentialForRemote", () => {
    it("从远端 URL 认出平台并取对应令牌", () => {
        const store = storeWith({ gitee: "gitee-token" });

        expect(credentialForRemote("https://gitee.com/owner/repo.git", store)).toEqual({
            host: "gitee",
            token: "gitee-token",
        });
    });

    it("GitHub 远端取 GitHub 令牌", () => {
        const store = storeWith({ github: "gh-token" });

        expect(credentialForRemote("git@github.com:owner/repo.git", store)).toEqual({
            host: "github",
            token: "gh-token",
        });
    });

    it("对应平台没有令牌时返回 undefined（匿名操作）", () => {
        const store = storeWith({ github: "gh-token" });

        expect(credentialForRemote("https://gitee.com/owner/repo.git", store)).toBeUndefined();
    });

    it("认不出的远端（如 GitLab）返回 undefined，不抛错", () => {
        const store = storeWith({ github: "gh-token" });

        expect(
            credentialForRemote("https://gitlab.com/owner/repo.git", store)
        ).toBeUndefined();
    });
});

describe("withAuth", () => {
    it("把 extraheader 追加进 simple-git 的 config 数组", () => {
        const result = withAuth(
            { baseDir: "/tmp/vault" },
            { host: "github", token: "tok" }
        );

        expect(result.config).toHaveLength(1);
        expect(result.config![0]).toMatch(/^http\.extraheader=Authorization: Basic /);
        // 用户名来自 host 层（GitHub → x-access-token），不是写死的占位符
        expect(result.config![0]).toContain(
            Buffer.from("x-access-token:tok").toString("base64")
        );
    });

    it("**Gitee 用 `oauth2` 当用户名** —— 用 `git` 会被 Gitee 直接拒绝", () => {
        // 这条是回归用例。Gitee 服务端只接受 账号名 / oauth2 / gitee.com 三种用户名，
        // 其它一律拒绝：
        //   remote: Username, "oauth2" or "gitee.com" is supported as username
        //           when using access token to pull or push the repository
        // 曾经这里填的是 `git`（GitHub 的习惯写法），后果是 Gitee 私有仓库的
        // push/pull 全部失败，而公开仓库照常能读 —— 很容易被误判成令牌问题。
        const result = withAuth({ baseDir: "/tmp" }, { host: "gitee", token: "tok" });

        expect(result.config![0]).toContain(
            Buffer.from("oauth2:tok").toString("base64")
        );
        expect(result.config![0]).not.toContain(Buffer.from("git:tok").toString("base64"));
    });

    it("有账号名时优先用账号名（两个平台都接受）", () => {
        const result = withAuth(
            { baseDir: "/tmp" },
            { host: "gitee", account: "sofqi", token: "tok" }
        );

        expect(result.config![0]).toContain(
            Buffer.from("sofqi:tok").toString("base64")
        );
    });

    it("保留调用方已有的 -c 配置", () => {
        const result = withAuth(
            { baseDir: "/tmp", config: ["core.autocrlf=false"] },
            { host: "gitee", token: "t" }
        );

        expect(result.config).toEqual([
            "core.autocrlf=false",
            expect.stringMatching(/^http\.extraheader=/),
        ]);
    });

    it("没有凭据时原样返回", () => {
        const options = { baseDir: "/tmp", config: ["core.autocrlf=false"] };
        expect(withAuth(options, undefined)).toBe(options);
    });
});
