import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
    resolve: {
        alias: {
            // Obsidian's API is only available inside the app, so tests run
            // against a hand-written stub of the surface we actually use.
            obsidian: path.resolve(__dirname, "tests/stubs/obsidian.ts"),
        },
    },
    test: {
        environment: "node",
        include: ["tests/**/*.test.ts"],
        setupFiles: ["tests/setup.ts"],
        /**
         * 默认的 5 秒对纯 JS 单测够用，但这个仓库里有一类**必须起真实进程**的测试：
         * `simpleGitManager.test.ts` 直接调系统 git（git 的行为面 mock 表达不了）。
         *
         * 本机实测：**每次进程创建约 340ms**（连 `cmd /c echo` 也要 317ms，
         * 不是 git 特有的开销，是这台机器的进程创建成本）。而 `makeCluster()`
         * 一个用例就要起十几次 git（init / addConfig×2 / checkout / remote add /
         * stage / commit / push / symbolic-ref / clone …），光启动开销就 4~5 秒，
         * 叠加测试体自身操作必然超过 5 秒 —— 表现为「用例超时 + 清理时 EBUSY」，
         * 很容易被误读成被测代码有 bug。
         *
         * 30 秒留了约 3 倍余量，同时仍能暴露真正卡死的用例。
         */
        testTimeout: 30_000,
        hookTimeout: 30_000,
        // Live tests hit the real GitHub/Gitee APIs and are opt-in.
        exclude: process.env.OBSYNC_LIVE
            ? []
            : ["node_modules/**", "tests/live/**"],
    },
});
