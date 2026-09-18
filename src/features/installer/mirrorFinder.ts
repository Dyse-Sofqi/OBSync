import { logger } from "../../core/logger";
import { getHost } from "../../host/hostRegistry";
import { formatRepoId } from "../../host/repoRef";
import type { RepoRef } from "../../host/types";
import { parsePluginManifest } from "./manifest";

/**
 * GitHub → Gitee 镜像发现。
 *
 * ## 为什么用 manifest 的 id 做校验
 *
 * 最初的设计是「Gitee 上有没有同 owner 同名的仓库」。但实测抽样了 40 个
 * 社区插件（含 7 个中文插件），**命中 0 个** —— 插件作者并不把仓库镜像到 Gitee
 * 并保持同名。所以：
 *
 * - 这个功能默认关闭（`settings.installer.discoverGiteeMirrors`），
 *   它服务的是「用户知道某个插件有 Gitee 镜像」这种少数场景，不是普遍优化。
 * - 一旦探测到同名仓库，**必须**用 manifest 的 `id` 二次校验。
 *   Gitee 上同名不同项目很常见，只比仓库名会装错插件 ——
 *   而「装错插件」比「没找到镜像」严重得多。
 *
 * ## 为什么这条路径不消耗 API 配额
 *
 * 两个平台的 manifest 都通过 **raw 通道**读取：
 * GitHub 走 `raw.githubusercontent.com`，Gitee 走网页 raw 通道。
 * 两者都不占用 `/api/v5` 的配额 —— 这一点很关键，因为 Gitee 的匿名 API
 * 配额实测极低（连续请求后会直接 403 且一分钟内不恢复）。
 */

function readManifestId(raw: string | undefined, context: string): string | undefined {
    if (!raw) return undefined;
    try {
        return parsePluginManifest(raw, context).id;
    } catch (err) {
        // 对方仓库里的 manifest 不合法（或根本不是插件仓库）—— 不算错误，只是不匹配。
        logger.debug(`manifest of ${context} is not a valid plugin manifest`, err);
        return undefined;
    }
}

/**
 * 探测 `owner/repo` 在 Gitee 上是否存在内容等价的镜像。
 *
 * @returns 命中且 `id` 一致时返回 Gitee 仓库引用，否则 undefined。
 */
export async function findGiteeMirror(
    githubRef: RepoRef,
    githubToken?: string
): Promise<RepoRef | undefined> {
    const candidate: RepoRef = {
        host: "gitee",
        owner: githubRef.owner,
        repo: githubRef.repo,
    };

    const [githubManifest, giteeManifest] = await Promise.all([
        getHost("github").readFile(githubRef, "manifest.json", { token: githubToken }),
        // 刻意不传令牌：镜像探测是「试试看」，不该因为令牌问题抛错，
        // 也不该把私有仓库的凭据发到另一个平台。
        getHost("gitee").readFile(candidate, "manifest.json"),
    ]);

    if (!giteeManifest) return undefined;

    const giteeId = readManifestId(giteeManifest, formatRepoId(candidate));
    if (!giteeId) return undefined;

    // 拿不到源 manifest 就无法校验。宁可不切镜像，也不冒装错的风险。
    const githubId = readManifestId(githubManifest, formatRepoId(githubRef));
    if (!githubId) return undefined;

    if (githubId !== giteeId) {
        logger.debug(
            `Gitee repo ${formatRepoId(candidate)} exists but is a different plugin ` +
                `(id "${giteeId}" vs "${githubId}") — ignoring`
        );
        return undefined;
    }

    return candidate;
}
