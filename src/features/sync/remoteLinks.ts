import { encodePathSegments } from "../../host/http";
import { commitWebUrl, fileHistoryWebUrl, fileWebUrl, parseGitRemoteUrl } from "../../host/repoRef";
import type { RepoRef } from "../../host/types";
import type { GitManager } from "./gitManager";

/**
 * 「在浏览器中打开」所需的远端上下文。
 *
 * 参考项目 obsidian-git 的 `openInGitHub.ts` 把正则和 URL 模板全部硬编码
 * `github.com`（见 docs/reference-analysis.md 1.5），加 Gitee 就得改一遍。
 * 这里 URL 模板留在 host 层（`repoRef.ts` 的 `fileWebUrl` / `commitWebUrl`），
 * 本模块只负责「把当前仓库的状态凑齐」。
 *
 * 两个平台的网页路径格式一致，所以模板本身不需要平台分支：
 * - 文件：`{webUrl}/blob/{branch}/{path}`
 * - 历史：`{webUrl}/commits/{branch}/{path}`
 * - 提交：`{webUrl}/commit/{hash}`
 */

export interface RemoteContext {
    ref: RepoRef;
    branch: string;
}

/**
 * 凑齐远端上下文：origin 的 URL + 当前分支。
 *
 * 任一项拿不到（没有远端 / 远端不是 GitHub 或 Gitee / 仓库还没有提交）
 * 都返回 undefined —— 调用方据此给出「无法生成链接」的提示，
 * 而不是拼出一个必然 404 的地址。
 */
export async function resolveRemoteContext(
    git: GitManager
): Promise<RemoteContext | undefined> {
    const [url, branches] = await Promise.all([git.getRemoteUrl(), git.listBranches()]);

    if (!url) return undefined;

    const ref = parseGitRemoteUrl(url);
    if (!ref) return undefined;

    const branch = branches.find((item) => item.current)?.name;
    if (!branch) return undefined;

    return { ref, branch };
}

/** 文件在远端网页上的地址。 */
export function fileOnRemoteUrl(context: RemoteContext, repoRelativePath: string): string {
    return fileWebUrl(
        context.ref,
        encodePathSegments(context.branch),
        encodePathSegments(repoRelativePath)
    );
}

/** 文件历史在远端网页上的地址。 */
export function fileHistoryOnRemoteUrl(
    context: RemoteContext,
    repoRelativePath: string
): string {
    return fileHistoryWebUrl(
        context.ref,
        encodePathSegments(context.branch),
        encodePathSegments(repoRelativePath)
    );
}

/** 某个提交在远端网页上的地址。 */
export function commitOnRemoteUrl(context: RemoteContext, hash: string): string {
    return commitWebUrl(context.ref, hash);
}
