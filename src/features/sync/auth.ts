import type { SimpleGitOptions } from "simple-git";
import type { SecretStore } from "../../core/secretStore";
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
 * ## 用户名部分
 *
 * GitHub 与 Gitee 的 HTTPS git 端点都只校令牌不校用户名（文档如此），
 * 惯例是放账号名；拿不到账号时用 `git` 占位（GitHub 官方推荐的形态之一）。
 */

export interface RemoteCredential {
    host: HostKind;
    /** 令牌所有者账号名；未知时为 undefined。 */
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

    const username = credential.account ?? "git";
    return {
        ...options,
        config: [
            ...(options.config ?? []),
            `http.extraheader=${basicAuthHeader(username, credential.token)}`,
        ],
    };
}
