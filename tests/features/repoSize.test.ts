import { describe, expect, it } from "vitest";
import {
    formatBytes,
    parseCountObjects,
    sumFileBytes,
} from "../../src/features/sync/repoSize";

/**
 * 体积的解析与格式化。
 *
 * 这组数字是**给用户看的**，所以两件事都要钉住：
 *
 * 1. `parseCountObjects` 认的是 `git count-objects -v` 的**真实输出**
 *    （fixture 逐字照抄，不是凭记忆写的 —— 记忆写错会静默退化成「读不到」）；
 * 2. `formatBytes` 的单位与小数位（`12.3 MB` / `345 KB` / `12 B`）——
 *    数字错了用户会以为库有问题。
 */

/** `git count-objects -v` 的真实输出（照抄，一个字符都不改）。 */
const REAL_OUTPUT = [
    "count: 12",
    "size: 48",
    "in-pack: 1234",
    "packs: 1",
    "size-pack: 20480",
    "prune-packable: 0",
    "garbage: 0",
    "size-garbage: 0",
    "",
].join("\n");

describe("parseCountObjects", () => {
    it("把松散对象与 pack 加起来（单位 KiB → 字节）", () => {
        const size = parseCountObjects(REAL_OUTPUT);

        // (48 + 20480) KiB
        expect(size?.bytes).toBe((48 + 20480) * 1024);
        // 12 + 1234
        expect(size?.objects).toBe(1246);
    });

    it("没有 pack 的仓库也算得出来（只有松散对象）", () => {
        const size = parseCountObjects("count: 3\nsize: 8\nin-pack: 0\nsize-pack: 0\n");

        expect(size?.bytes).toBe(8 * 1024);
        expect(size?.objects).toBe(3);
    });

    it("**认不出体积行时返回 undefined**（不返回 0 —— 0 B 会被当成空仓库）", () => {
        expect(parseCountObjects("")).toBeUndefined();
        expect(parseCountObjects("fatal: not a git repository")).toBeUndefined();
    });

    it("容忍 CRLF 与多余空格（Windows 上 git 输出的是 \\r\\n）", () => {
        const size = parseCountObjects("count: 1\r\nsize: 4\r\nin-pack: 0\r\nsize-pack: 0\r\n");

        expect(size?.bytes).toBe(4 * 1024);
    });
});

describe("formatBytes", () => {
    it("小于 1 KB 时用字节，且不带小数", () => {
        expect(formatBytes(0)).toBe("0 B");
        expect(formatBytes(12)).toBe("12 B");
        expect(formatBytes(1023)).toBe("1023 B");
    });

    it("KB / MB / GB 按 1024 进制换算", () => {
        expect(formatBytes(1024)).toBe("1 KB");
        expect(formatBytes(1024 * 1024)).toBe("1 MB");
        expect(formatBytes(1024 * 1024 * 1024)).toBe("1 GB");
    });

    it("小数值保留一位小数，超过 100 就不带小数", () => {
        expect(formatBytes(Math.round(12.3 * 1024 * 1024))).toBe("12.3 MB");
        // 345.2 KB → 345 KB（这个量级上小数位没有意义）
        expect(formatBytes(Math.round(345.2 * 1024))).toBe("345 KB");
    });

    it("非法输入给一个占位符，而不是 NaN", () => {
        expect(formatBytes(Number.NaN)).toBe("—");
        expect(formatBytes(-1)).toBe("—");
    });
});

describe("sumFileBytes", () => {
    it("把各文件大小加起来", async () => {
        const sizes: Record<string, number> = { "a.md": 5, "b.md": 6 };

        await expect(
            sumFileBytes(["a.md", "b.md"], async (path) => sizes[path])
        ).resolves.toBe(11);
    });

    it("**取不到大小按 0 计**（文件已删除 / 读不了都不该让整条链路失败）", async () => {
        await expect(sumFileBytes(["gone.md"], async () => undefined)).resolves.toBe(0);
        await expect(sumFileBytes(["x"], async () => Number.NaN)).resolves.toBe(0);
        await expect(sumFileBytes(["x"], async () => -5)).resolves.toBe(0);
    });

    it("空列表是 0（不调 stat）", async () => {
        let calls = 0;

        await expect(
            sumFileBytes([], async () => {
                calls += 1;
                return 1;
            })
        ).resolves.toBe(0);
        expect(calls).toBe(0);
    });
});
