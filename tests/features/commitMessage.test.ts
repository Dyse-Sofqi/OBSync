import { describe, expect, it } from "vitest";
import os from "node:os";
import { renderCommitMessage } from "../../src/features/sync/commitMessage";

/**
 * 模板变量与 obsidian-git 对齐：用户从它迁移时模板不用改。
 * 所有时间/机器名都显式注入，保证断言可复现。
 */

describe("renderCommitMessage", () => {
    const now = new Date(2026, 8, 16, 14, 30, 5); // 2026-09-16 14:30:05 本地时间

    it("展开全部变量", () => {
        const message = renderCommitMessage(
            "{{date}} on {{hostname}}: {{numFiles}} files ({{files}})",
            {
                files: ["a.md", "b/c.md"],
                now,
                hostname: "desk-01",
            }
        );

        expect(message).toBe(
            "2026-09-16 14:30:05 on desk-01: 2 files (a.md, b/c.md)"
        );
    });

    it("默认模板可用", () => {
        const message = renderCommitMessage("vault backup: {{date}}", {
            files: ["a.md"],
            now,
        });

        expect(message).toMatch(/^vault backup: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    });

    it("hostname 缺省时用真实机器名（非空）", () => {
        const message = renderCommitMessage("{{hostname}}", { files: [], now });
        expect(message.trim().length).toBeGreaterThan(0);
        expect(message).not.toBe("{{hostname}}");
        expect(message).toBe(os.hostname());
    });

    it("未知变量原样保留 —— 模板不是沙箱，不猜用户意图", () => {
        const message = renderCommitMessage("{{branch}} {{date}}", {
            files: [],
            now,
        });
        expect(message).toContain("{{branch}}");
    });

    it("文件列表过长时截断并加省略号", () => {
        const long = Array.from({ length: 50 }, (_, index) => `very-long-file-name-${index}.md`);
        const message = renderCommitMessage("{{files}}", { files: long, now });

        expect(message.length).toBeLessThanOrEqual(200 + 1); // 200 字符 + 省略号
        expect(message.endsWith("…")).toBe(true);
    });
});
