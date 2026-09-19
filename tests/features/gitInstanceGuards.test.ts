import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * git 子进程的两个「不能没有」的设置：**非交互**与**无输出超时**。
 *
 * ## 为什么这件事值得单独测
 *
 * 用户报的症状是「尝试推送后一直看到正在推送」。其中一个可能的成因是
 * git 在**等人回答**：它拿不到凭据就会提问（终端提问，或 Windows 上
 * Git Credential Manager 的弹窗），而 Obsidian 里没有人能回答 ——
 * 那个提问读的 stdin 是一根没人写的管子，命令就这么挂着，
 * `isBusy` 永远是 true，所有后续同步都排在它后面。用户只能重载插件。
 *
 * 这两条设置是我们**能**控制的部分（库内部超时到点怎么 kill 子进程，
 * 由 simple-git 自己保证）。所以这里用替身顶掉 simple-git，验「我们到底
 * 交给了它什么」—— 想直接观察真实行为就得真造一个卡死的 git 进程，
 * 而那正是这套设置要防的事。
 *
 * 两个 spawn 路径都要过一遍：`git()`（带鉴权）与 `getRemoteUrl()`
 * （**每次 `git()` 都会先跑它**）。之前这两处各自 `simpleGit(options)`，
 * 逐处补设置必然漏一处 —— 而漏掉的那一处照样能挂住整个同步。
 */

const captured: {
    options: Array<Record<string, unknown>>;
    env: Array<Record<string, string>>;
} = { options: [], env: [] };

beforeEach(() => {
    // 每个用例只看自己那几次调用 —— 累计的比较会把前一个用例的调用算进来。
    captured.options.length = 0;
    captured.env.length = 0;
});

vi.mock("simple-git", () => ({
    simpleGit: (options: Record<string, unknown>) => {
        captured.options.push(options);
        const env: Record<string, string> = {};
        captured.env.push(env);
        const instance: Record<string, unknown> = {
            env(name: string, value: string) {
                env[name] = value;
                return instance;
            },
            async getRemotes() {
                return [];
            },
        };
        return instance;
    },
}));

const { createGitInstance, SimpleGitManager } = await import(
    "../../src/features/sync/simpleGitManager"
);

/** 至少能看到「超时」这一条：具体数值不该被测试钉死，只要它开着。 */
function blockTimeoutOf(options: Record<string, unknown>): number {
    const timeout = options.timeout as { block?: number } | undefined;
    return timeout?.block ?? 0;
}

describe("git 子进程的非交互设置", () => {
    it("禁掉终端提问与凭据弹窗（否则 git 会一直等人回答）", () => {
        createGitInstance({ baseDir: process.cwd() });

        expect(captured.env[0]).toMatchObject({
            GIT_TERMINAL_PROMPT: "0",
            GCM_INTERACTIVE: "never",
        });
    });

    it("**禁的是「问人」，不是「用凭据」** —— 系统凭据助手仍可用", () => {
        // GCM_INTERACTIVE=never 只让它不弹窗；已存的凭据照常使用。
        // 所以自建 GitLab / 内网 git 那类依赖系统凭据助手的用法不受影响。
        createGitInstance({ baseDir: process.cwd() });

        expect(captured.env[0]).not.toHaveProperty("GIT_CONFIG_NOSYSTEM");
        expect(Object.keys(captured.env[0] ?? {})).not.toContain("credential.helper");
    });

    it("开着无输出超时（卡死的子进程会被中止，而不是永远占着队列）", () => {
        createGitInstance({ baseDir: process.cwd() });

        expect(blockTimeoutOf(captured.options[0]!)).toBeGreaterThan(0);
    });

    it("`getRemoteUrl()` 那条 spawn 路径也带上了同样的守卫", async () => {
        // 这条路径每次 `git()` 都会跑（先问远端是谁，再决定注不注令牌）。
        captured.options.length = 0;
        captured.env.length = 0;

        const manager = new SimpleGitManager({ baseDir: process.cwd() });
        await manager.getRemoteUrl();

        expect(captured.options).toHaveLength(1);
        expect(captured.env[0]).toMatchObject({
            GIT_TERMINAL_PROMPT: "0",
            GCM_INTERACTIVE: "never",
        });
        expect(blockTimeoutOf(captured.options[0]!)).toBeGreaterThan(0);
    });

    it("`gitPath` 设置仍然传下去（自定义 git 可执行文件）", () => {
        createGitInstance({ baseDir: process.cwd(), gitPath: "C:/elsewhere/git.exe" });

        expect(captured.options[0]!.binary).toBe("C:/elsewhere/git.exe");
    });

    it("有令牌时 `-c` 参数照旧挂上，且**不覆盖**超时与非交互设置", () => {
        createGitInstance({
            baseDir: process.cwd(),
            config: ["http.extraheader=Authorization: Basic xyz"],
        });

        expect(captured.options[0]!.config).toEqual([
            "http.extraheader=Authorization: Basic xyz",
        ]);
        expect(blockTimeoutOf(captured.options[0]!)).toBeGreaterThan(0);
        expect(captured.env[0]!.GIT_TERMINAL_PROMPT).toBe("0");
    });

    it("没有 `-c` 参数时不传空的 config（避免挂一个没用的插件）", () => {
        createGitInstance({ baseDir: process.cwd(), config: [] });

        expect(captured.options[0]).not.toHaveProperty("config");
    });

    it("超时与非交互都是**每条命令**都生效（由实例级配置保证）", () => {
        // 这两条挂在实例上而不是某一条命令上 —— 否则「哪条命令忘了带」
        // 就是下一个挂住的入口。
        const first = createGitInstance({ baseDir: process.cwd() });
        const second = createGitInstance({ baseDir: process.cwd() });

        expect(first).not.toBe(second);
        expect(captured.env).toHaveLength(2);
        for (const env of captured.env) {
            expect(env.GIT_TERMINAL_PROMPT).toBe("0");
        }
        for (const options of captured.options) {
            expect(blockTimeoutOf(options)).toBeGreaterThan(0);
        }
    });
});
