/**
 * 仓库体积与改动体积。
 *
 * ## 两个体积回答的是两个不同的问题
 *
 * - **仓库体积**（`git count-objects -v`）：这个库有多大 —— 判断「推送要传多少」
 *   「为什么同步慢」「远端仓库是不是快满了」。它统计的是 `.git` 里的对象库
 *   （松散对象 + pack），这是仓库占用的绝大部分。
 * - **待提交改动体积**：这次要提交/推上去多少。git **不直接给这个数**，
 *   只能把「有改动的文件」的大小加起来（见 `sumFileBytes`）。所以它是**近似值**：
 *   实际传输量还要看压缩率与 git 的对象复用，删除的文件本来也没有体积。
 *
 * 两者都是给用户看的数字，所以**单位换算与文案分开**：这里只算字节与格式化，
 * 单位怎么写、这句话怎么说由 locale 决定（`formatBytes` 输出的 `12.3 MB` 是
 * 数字 + 国际通用单位，不需要翻译）。
 */

import type { RepoSize } from "./types";

/**
 * `git count-objects -v` 的输出 → 体积与对象数。
 *
 * 输出是「键: 值」逐行，例如：
 *
 *     count: 0
 *     size: 0
 *     in-pack: 1234
 *     packs: 1
 *     size-pack: 5678
 *     prune-packable: 0
 *     garbage: 0
 *     size-garbage: 0
 *
 * **不加 `-H`**：`-H` 会把体积变成 `12.34 MiB` 这种字符串，我们就得反过来解析
 * 它（还得处理它的单位选择规则）。用默认的 KiB 整数自己换算更可靠。
 *
 * 认不出任何体积行时返回 undefined —— 调用方据此显示「读不到」，
 * 而不是显示一个编出来的 `0 B`。
 */
export function parseCountObjects(output: string): RepoSize | undefined {
    const values = new Map<string, number>();
    for (const line of output.split(/\r?\n/)) {
        const match = /^([\w-]+):\s*(\d+)\s*$/.exec(line.trim());
        if (match) values.set(match[1]!, Number.parseInt(match[2]!, 10));
    }

    const looseKib = values.get("size");
    const packKib = values.get("size-pack");
    if (looseKib === undefined && packKib === undefined) return undefined;

    return {
        // git 给的是 KiB。
        bytes: ((looseKib ?? 0) + (packKib ?? 0)) * 1024,
        objects: (values.get("count") ?? 0) + (values.get("in-pack") ?? 0),
    };
}

const UNITS = ["B", "KB", "MB", "GB", "TB"];

/**
 * 字节 → 人能读的大小（`12.3 MB`）。
 *
 * 用 1024 进制但写 `KB` / `MB`（而不是 `KiB` / `MiB`）：文件管理器与 Windows
 * 都是这么写的，用户对 `MB` 的直觉就是 1024 进制 —— 写成 `MiB` 反而要解释。
 * 保留一位小数的规则：**超过 100 就不带小数**（`345 KB` 比 `345.2 KB` 好读），
 * 字节数本身永远是整数。
 */
export function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) return "—";

    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < UNITS.length - 1) {
        value /= 1024;
        unit += 1;
    }

    const rounded =
        unit === 0 || value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
    return `${rounded} ${UNITS[unit]}`;
}

/**
 * 把若干文件的大小加起来。
 *
 * `statSize` 取不到大小（文件已删除、读不了）时返回 undefined —— 那部分按 0 计。
 * 删除的文件本来就该是 0，而「读不了」也不该让整条链路失败：这只是个参考数字。
 *
 * **串行**而不是 `Promise.all`：一次改动可能涉及上千个文件，同时发上千个
 * stat 会把文件系统打满，而这里没有任何实时性要求。
 */
export async function sumFileBytes(
    paths: string[],
    statSize: (path: string) => Promise<number | undefined>
): Promise<number> {
    let total = 0;
    for (const path of paths) {
        const size = await statSize(path);
        if (size !== undefined && Number.isFinite(size) && size > 0) total += size;
    }
    return total;
}
