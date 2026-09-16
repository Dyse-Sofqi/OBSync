import type { SimpleGitOptions } from "simple-git";
import type { SecretStore } from "../../core/secretStore";
import { getHost } from "../../host/hostRegistry";
import { parseGitRemoteUrl } from "../../host/repoRef";
import type { HostKind } from "../../host/types";

/**
 * 远端鉴权：把平台令牌翻译成 git 能懂的形式。
 *
 * ## 方案：`http.extraheader`
 *
 * git 的 HTTPS 凭据有多种注入方式，取舍如下：
 *
 * - **凭据 helper / askpass 脚本**（obsidian-git 的做法）：交互式，
 *   要写脚本、监听文件、弹窗收集输入。适合「用户现场输密码」，
 *   但我们已经把 PAT 存在 secretStore 里，不需要交互。
 * - **把令牌写进 remote URL**（`https://user:token@host/...`）：
 *   令牌会落进 `.git/config`，`git remote -v` 一眼可见，还会随配置文件泄漏。
 * - **`http.extraheader`**（本方案）：`Authorization: Basic base64(user:token)`
 *   只存在于本次 git 进程的命令行参数里，不落盘。
 *
 * simple-git 的 `config` 选项会把键值对作为 `-c key=value` 加到**每条**命令上，
 * 所以在构造 SimpleGit 实例时注入一次即可，pull/push/fetch 全部生效。
 *
 * > 风险提示（PLAN.md 风险表第一条）：此方案对 Gitee 私有仓库的行为
 * > 需实测确认；若失败，回退方案是 askpass 弹窗（复刻 obsidian-git）。
 *
 * ## 用户名部分（这里踩过一个坑）
 *
 * 曾经按「两个平台都只校令牌、不校用户名」的假设，拿不到账号名就填 `git`。
 * 这个假设对 GitHub 成立，**对 Gitee 不成立** —— Gitee 只接受三种用户名：
 *
 *     remote: Username, "oauth2" or "gitee.com" is supported as username
 *             when using access token to pull or push the repository
 *
 * 于是 Gitee 私有仓库的 push/pull 全部被拒，而公开仓库照常能读 ——
 * 症状很容易被误判成「令牌不对」或「权限不足」。现在用户名由 host 层提供
 * （`IRepoHost.gitAuthUsername`），因为这就是一个平台差异。
 *
 * 注意这条**无法靠 live 测试以外的办法发现**：单测只能验「我们构造了什么」，
 * 而构造出来的东西本身是合法的 —— 不合法的是「Gitee 接不接受这个用户名」。
 */

export interface RemoteCredential {
    host: HostKind;
    /** 令牌所有者账号名；未知时为 undefined（此时用 host 层的默认用户名）。 */
    account?: string;
    token: string;
}

/** 从远端 URL 推断平台并取对应令牌。认不出平台或没有令牌时返回 undefined。 */
export function credentialForRemote(
    remoteUrl: string,
    store: SecretStore
): RemoteCredential | undefined {
    const ref = parseGitRemoteUrl(remoteUrl);
    if (!ref) return undefined;

    const token = store.getToken(ref.host);
    if (!token) return undefined;

    return { host: ref.host, token };
}

/** 构造 `Authorization: Basic ...` 请求头的值。 */
export function basicAuthHeader(username: string, token: string): string {
    // Buffer 在 Electron 渲染进程可用；这是 git extraheader 要求的编码。
    return `Authorization: Basic ${Buffer.from(`${username}:${token}`).toString("base64")}`;
}

/**
 * 给 simple-git 的构造选项追加鉴权配置。
 *
 * simple-git 的 `config` 是逐项 `-c key=value` 的字符串数组；
 * 已有的条目会被保留 —— extraheader 不该顶掉调用方的其他 `-c` 设置。
 */
export function withAuth(
    options: Partial<SimpleGitOptions>,
    credential: RemoteCredential | undefined
): Partial<SimpleGitOptions> {
    if (!credential) return options;

    // 有账号名就用账号名（两个平台都接受），否则用 host 层声明的恒定可用值。
    // **不要**退回硬编码的 `git` —— Gitee 会拒绝，理由见文件头的「用户名部分」。
    const username = credential.account ?? getHost(credential.host).gitAuthUsername;
    return {
        ...options,
        config: [
            ...(options.config ?? []),
            `http.extraheader=${basicAuthHeader(username, credential.token)}`,
        ],
    };
}
