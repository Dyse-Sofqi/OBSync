import semver from "semver";

/**
 * 版本号比较。
 *
 * 插件的 release tag 与 manifest 里的 version 经常不同形：
 * tag 可能是 `v1.2.3`、`1.2.3-beta.1`、`release-1.2.3`，
 * 而 manifest 里通常是干净的 `1.2.3`。直接用字符串比较会得出错误结论
 * （`"1.10.0" < "1.9.0"`），所以先做 `semver.coerce` 归一化。
 *
 * coerce 也失败时返回 undefined，由调用方决定怎么降级 ——
 * 而不是在这里瞎猜一个结果。
 */
export function compareVersions(a: string, b: string): number | undefined {
    const left = semver.coerce(a);
    const right = semver.coerce(b);
    if (!left || !right) return undefined;
    return semver.compare(left, right);
}

/** 判断 `candidate` 是否比 `current` 新。无法比较时保守地返回 false。 */
export function isNewerVersion(candidate: string, current: string): boolean {
    const result = compareVersions(candidate, current);
    if (result === undefined) {
        // 无法解析版本号时退化成「字符串不同即视为有更新」，
        // 但要求两者确实不一样，避免把同一版本反复当成新版本。
        return candidate.trim() !== current.trim();
    }
    return result > 0;
}
