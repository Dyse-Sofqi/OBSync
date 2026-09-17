import { GiteeHost } from "./giteeHost";
import { GitHubHost } from "./githubHost";
import type { IRepoHost } from "./IRepoHost";
import type { HostKind } from "./types";

/**
 * 平台注册表。
 *
 * 调用方永远通过这里拿 provider，不直接 new 具体类。
 *
 * 加一个平台要动的地方 —— 原来这里写着「只需要在这里注册一项，
 * 两个功能模块都不用改」，那是不准确的，照着做会漏：
 *
 * 1. `SUPPORTED_HOSTS`（`types.ts`）—— 平台列表的唯一事实来源，
 *    持久化校验、令牌快照、设置页的令牌输入框都由它驱动；
 * 2. 在这里注册一个 provider —— `Record<HostKind, IRepoHost>` 会**强制**，
 *    漏了编译不过，这一步不用靠自觉；
 * 3. `repoRef.ts` 的域名映射 —— 漏了用户输这个平台的地址会被报成
 *    「该平台不是 GitHub 或 Gitee」；
 * 4. i18n 的平台名与令牌说明（`t.host.*` / `t.settings.token.*`）。
 */

const HOSTS: Record<HostKind, IRepoHost> = {
    github: new GitHubHost(),
    gitee: new GiteeHost(),
};

/** 按平台取 provider。 */
export function getHost(kind: HostKind): IRepoHost {
    return HOSTS[kind];
}

export { GiteeHost, GitHubHost };
export type { IRepoHost };
export * from "./types";
export * from "./errors";
export {
    commitWebUrl,
    fileHistoryWebUrl,
    fileWebUrl,
    formatRemoteUrl,
    formatRepoId,
    isSameRepo,
    parseGitRemoteUrl,
    parseRepoRef,
    repoWebUrl,
    tryParseRepoRef,
} from "./repoRef";
