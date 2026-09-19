import { logger } from "../../core/logger";
import { getHost } from "../../host/hostRegistry";
import { formatRepoId } from "../../host/repoRef";
import type { RepoRef } from "../../host/types";
import { parsePluginManifest, parseThemeManifest } from "./manifest";
import { isNewerVersion } from "./versions";

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
 * ## 候选 owner 不止一个
 *
 * 镜像**常常挂在作者自己的 Gitee 账号下，而那个账号名与 GitHub 上的 owner
 * 不一样**（实测：`github.com/Dyse-Sofqi/MDRazor` 的镜像在
 * `gitee.com/sofqi/MDRazor`）。只探同名 owner 会漏掉这类镜像 ——
 * 用户那边看到的是「明明有镜像，却一直走 GitHub」，GitHub 不通时就只能降级报错。
 * 所以候选由调用方给出并**按可信度排序**：先同名（最可信），再 Gitee 账号名。
 *
 * @param candidateOwners 候选 owner，按顺序探测，命中即返回
 * @returns 命中且 `id` 一致时返回 Gitee 仓库引用，否则 undefined
 */
export async function findGiteeMirror(
    githubRef: RepoRef,
    githubToken: string | undefined,
    candidateOwners: readonly string[]
): Promise<RepoRef | undefined> {
    // 源 manifest 必须先拿到：**它是唯一的校验依据**，拿不到就宁可不切镜像
    // （放在探测之前，顺便省掉「反正也验不了」的那些请求）。
    const githubManifest = await getHost("github").readFile(githubRef, "manifest.json", {
        token: githubToken,
    });
    const githubId = readManifestId(githubManifest, formatRepoId(githubRef));
    if (!githubId) return undefined;

    for (const owner of candidateOwners) {
        const candidate: RepoRef = { host: "gitee", owner, repo: githubRef.repo };

        // 刻意不传令牌：镜像探测是「试试看」，不该因为令牌问题抛错，
        // 也不该把私有仓库的凭据发到另一个平台。
        const giteeManifest = await getHost("gitee").readFile(candidate, "manifest.json");
        if (!giteeManifest) continue;

        const giteeId = readManifestId(giteeManifest, formatRepoId(candidate));
        if (!giteeId) continue;

        if (giteeId !== githubId) {
            logger.debug(
                `Gitee repo ${formatRepoId(candidate)} exists but is a different plugin ` +
                    `(id "${giteeId}" vs "${githubId}") — ignoring`
            );
            continue;
        }

        return candidate;
    }

    return undefined;
}

/**
 * 主题的镜像探测。
 *
 * 判据与插件**不同**，因为主题的 manifest 里没有 `id`（身份是目录名 / `name`，
 * 见 `core/themeName.ts`）。这里的条件是两个：
 *
 * 1. 候选仓库的 manifest 里 `name` 与源主题一致 —— 同一个主题；
 * 2. 候选的版本**不比你现在装的旧** —— 换到一个更旧的镜像，用户会静默地
 *    失去更新（甚至看起来像"退回旧版本"），这比找不到镜像糟得多。
 *
 * 这条判据比插件的 `id` 弱一档（名字不是唯一标识），所以它同样**只作为提议**：
 * 采用必须经用户在确认弹窗里拍板（`ConfirmMirrorModal` 里那段警示说的就是这个）。
 */
export async function findGiteeMirrorForTheme(
    githubRef: RepoRef,
    githubToken: string | undefined,
    candidateOwners: readonly string[],
    installed: { name: string; version: string }
): Promise<RepoRef | undefined> {
    // 源仓库的 manifest 先取一次：①顺带确认这个源仓库还读得到（读不到就别切）
    // ②拿到它当前的版本，用来判断候选是不是落后了。
    const sourceRaw = await getHost("github").readFile(githubRef, "manifest.json", {
        token: githubToken,
    });
    let sourceVersion = installed.version;
    let sourceName = installed.name;
    if (sourceRaw) {
        try {
            const parsed = parseThemeManifest(sourceRaw, formatRepoId(githubRef));
            sourceName = parsed.name;
            sourceVersion = parsed.version;
        } catch (err) {
            logger.debug(`manifest of ${formatRepoId(githubRef)} is not a theme manifest`, err);
            return undefined;
        }
    }

    for (const owner of candidateOwners) {
        const candidate: RepoRef = { host: "gitee", owner, repo: githubRef.repo };

        const raw = await getHost("gitee").readFile(candidate, "manifest.json");
        if (!raw) continue;

        let manifest;
        try {
            manifest = parseThemeManifest(raw, formatRepoId(candidate));
        } catch (err) {
            logger.debug(`manifest of ${formatRepoId(candidate)} is not a theme manifest`, err);
            continue;
        }

        if (manifest.name.trim().toLowerCase() !== sourceName.trim().toLowerCase()) {
            logger.debug(
                `Gitee repo ${formatRepoId(candidate)} is a different theme ` +
                    `("${manifest.name}" vs "${sourceName}") — ignoring`
            );
            continue;
        }

        // 不比源仓库（或本地装的）更旧才收 —— 换到更旧的镜像等于让用户失去更新。
        if (isNewerVersion(sourceVersion, manifest.version)) {
            logger.debug(
                `Gitee repo ${formatRepoId(candidate)} is older (${manifest.version} < ` +
                    `${sourceVersion}) — ignoring`
            );
            continue;
        }

        return candidate;
    }

    return undefined;
}
