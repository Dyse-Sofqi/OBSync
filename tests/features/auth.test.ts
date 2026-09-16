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

    it("账号名缺失时用 git 占位", () => {
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
        // base64("git:tok")
        expect(result.config![0]).toContain(Buffer.from("git:tok").toString("base64"));
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
