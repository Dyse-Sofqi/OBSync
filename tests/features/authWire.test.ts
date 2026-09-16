import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { simpleGit } from "simple-git";
import { basicAuthHeader, withAuth } from "../../src/features/sync/auth";

/**
 * 鉴权链路的**传递**验证。
 *
 * `auth.test.ts` 只证明「我们构造出的 config 字符串是对的」，
 * 证明不了这个字符串经过 simple-git 的 `config` 选项后，**真的变成了
 * git 进程命令行上的 `-c key=value`**。这一环静默失效（simple-git 换了传参方式）
 * 的症状是「私有仓库推送 401」，排查时会先怀疑令牌、再怀疑权限，绕很远。
 *
 * 手法：`-c` 设置的配置只在**本次 git 进程内**可见，所以让同一次调用把该值读回来 ——
 * 读得到就说明传进去了。不碰网络、不需要服务器、不需要令牌。
 *
 * ## 已验证 / 未验证的边界
 *
 * - ✅ simple-git 的 `config` → git 的 `-c`（本文件）
 * - ✅ git 会把该配置变成 HTTP 请求上的 `Authorization` 头，
 *   且在**第一个请求**就带上、不等 401 挑战（`.probe/probe_auth.mjs` 用
 *   本地 HTTP 服务器实测：`/info/refs?service=git-upload-pack` 已带正确头）
 * - ❌ **Gitee 服务端是否接受「令牌当密码」的 Basic 认证** —— 需要真实令牌与私有仓库，
 *   属 live 验证（HANDOVER 第六节唯一待实测项）
 *
 * ## 踩过的坑：不要给 simple-git 传 `.env({...process.env})`
 *
 * simple-git 3.36 起会检查通过 `.env()` 显式传入的环境变量，遇到
 * `GIT_PAGER` / `GIT_EDITOR` 这类会注入配置的变量直接抛
 * `Use of "GIT_PAGER" is not permitted without enabling allowUnsafePager`。
 * 本机环境恰好有 `GIT_PAGER=cat`，于是测试会以「服务器收到 0 个请求」的形式失败 ——
 * 看起来像网络问题，实际是参数校验。
 * 生产代码不调 `.env()`，所以不受影响。
 */

let root: string;

beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "obsync-auth-"));
    await simpleGit(root).raw(["init", "-q"]);
});

afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("simple-git 的 config 选项到 git -c 的传递", () => {
    it("withAuth 产出的 extraheader 真的进了 git 进程", async () => {
        const options = withAuth(
            { baseDir: root },
            { host: "gitee", account: "sofqi", token: "tok-123" }
        );

        const value = await simpleGit(options as never).raw([
            "config",
            "--get",
            "http.extraheader",
        ]);

        expect(value.trim()).toBe(basicAuthHeader("sofqi", "tok-123"));
    });

    it("账号名缺失时用 git 占位，值仍是合法 Basic 头", async () => {
        const options = withAuth({ baseDir: root }, { host: "github", token: "gh-tok" });

        const value = await simpleGit(options as never).raw([
            "config",
            "--get",
            "http.extraheader",
        ]);

        expect(value.trim()).toMatch(/^Authorization: Basic /);
        expect(Buffer.from(value.trim().slice("Authorization: Basic ".length), "base64").toString()).toBe(
            "git:gh-tok"
        );
    });

    it("保留调用方已有的 -c 配置，两者共存", async () => {
        const options = withAuth(
            { baseDir: root, config: ["core.autocrlf=false"] },
            { host: "github", token: "t" }
        );

        const git = simpleGit(options as never);
        // 两条 -c 都该生效
        await expect(git.raw(["config", "--get", "core.autocrlf"])).resolves.toContain("false");
        await expect(git.raw(["config", "--get", "http.extraheader"])).resolves.toContain("Basic");
    });

    it("没有凭据时不注入 extraheader（匿名访问不该带空凭据）", async () => {
        const options = withAuth({ baseDir: root }, undefined);

        // `git config --get` 在键不存在时退出码为 1，simple-git 把它解析成空串
        // 而不是抛错 —— 断言空串即可，别断言 rejects。
        const value = await simpleGit(options as never).raw([
            "config",
            "--get",
            "http.extraheader",
        ]);

        expect(value.trim()).toBe("");
    });
});
