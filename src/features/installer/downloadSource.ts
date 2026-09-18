import type { LocaleStrings } from "../../core/i18n";
import type { HostKind, RepoRef } from "../../host/types";

/**
 * 「这次下载是从哪来的」—— 完成提示里要报的那个名字。
 *
 * 存在的理由：**用户看不出走没走镜像**。跟踪列表里那一行只有在 `origin`
 * 存在时才出现，而「没出现」既可能是没探测到、也可能是根本没探测 ——
 * 于是每次更新后的提示就成了唯一能确认「东西实际从哪来」的地方。
 *
 * 服务层的结果都带这一对字段（`InstallResult` / `ThemeUpdateResult` ——
 * 见 `installer/types.ts` 的 `repoRef`）：只有服务知道**实际**用了哪个地址，
 * 调用方手里那个 `TrackedItem` 可能已经过期（更新时才发现的镜像会让
 * `host` 换掉）。所以这个函数收的是结果对象，不是跟踪条目。
 */
export interface DownloadSource {
    /** 实际下载用的地址（命中镜像时就是镜像）。 */
    repoRef: RepoRef;
    /** 走了镜像时的源地址；没走镜像就是 `undefined`。 */
    origin?: RepoRef;
}

/** 平台名。平台名只在 locale 里有一份，不要在各调用点各写一遍。 */
export function hostLabel(t: LocaleStrings, host: HostKind): string {
    return host === "gitee" ? t.host.gitee : t.host.github;
}

/**
 * 下载来源的用户可读名。
 *
 * 命中镜像时报「Gitee 镜像」而不是「Gitee」：用户跟踪的地址是 GitHub，
 * 只写「Gitee」会让他以为跟踪的地址被换掉了（那是另一个仓库，不是镜像）。
 * 跟踪列表里那行镜像文案出于同样的理由点了「下载使用此源」。
 */
export function downloadSourceLabel(t: LocaleStrings, source: DownloadSource): string {
    const host = hostLabel(t, source.repoRef.host);
    return source.origin ? t.installer.mirrorSource(host) : host;
}
