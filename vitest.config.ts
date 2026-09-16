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
        // Live tests hit the real GitHub/Gitee APIs and are opt-in.
        exclude: process.env.OBSYNC_LIVE
            ? []
            : ["node_modules/**", "tests/live/**"],
    },
});
