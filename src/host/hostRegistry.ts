import { GiteeHost } from "./giteeHost";
import { GitHubHost } from "./githubHost";
import type { IRepoHost } from "./IRepoHost";
import type { HostKind, RepoRef } from "./types";

/**
 * 平台注册表。
 *
 * 调用方永远通过这里拿 provider，不直接 new 具体类 —— 这样将来加
 * GitLab / Bitbucket 只需要在这里注册一项，两个功能模块都不用改。
 */

const HOSTS: Record<HostKind, IRepoHost> = {
    github: new GitHubHost(),
    gitee: new GiteeHost(),
};

export const SUPPORTED_HOSTS: readonly HostKind[] = ["github", "gitee"];

/** 按平台取 provider。 */
export function getHost(kind: HostKind): IRepoHost {
    return HOSTS[kind];
}

/** 按仓库引用取 provider。 */
export function hostFor(ref: RepoRef): IRepoHost {
    return HOSTS[ref.host];
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
