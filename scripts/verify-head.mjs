/**
 * 在 **HEAD** 上跑一遍单元测试 —— 用来回答「我刚提交的东西是自洽的吗」。
 *
 * ## 为什么需要它（而不是直接 `pnpm test`）
 *
 * `pnpm test` 读的是**工作区文件**。工作区里还压着没提交的改动时，全绿只说明
 * 「我磁盘上这一坨是好的」，说明不了 **HEAD 是好的** —— 而 HEAD 才是别人
 * 克隆下来看到的东西。
 *
 * 实测踩过（2026-09-19）：`d939df2`（状态栏全宽开关）提交了测试与 i18n 键，
 * **唯独漏了 `src/settingsTab.ts`**，于是 HEAD 上三条已提交的用例是红的，
 * 而本地一直是绿的。这个错**只在别人克隆或 CI 上才会暴露**。
 *
 * 所以「提交后跑一次」得是个固定动作，不能靠记性。
 *
 * ## 做法
 *
 * 把工作区（**含未跟踪文件**）stash 起来 → 跑 `pnpm test` → 无论成败都 pop 回来。
 *
 * `--include-untracked` 不是可选的：新加的测试文件如果还没 `git add`，不 stash 掉
 * 就会混进「HEAD 的测试」里 —— 那验的就不是 HEAD 了，等于白跑。
 *
 * pop 放在 `finally` 里，且**不吞掉测试的退出码**：这个脚本有两个职责 ——
 * 「报告 HEAD 的真实状态」和「保证工作区原样还给你」，缺一个都会让人不敢用。
 *
 * ## 用法
 *
 *     pnpm verify:head
 *
 * 全量测试约 3 分钟（`simpleGitManager.test.ts` 一个文件就占 177 秒，它起真 git）。
 *
 * ⚠️ 中途 Ctrl+C 的话 `finally` **不会**执行（SIGINT 直接终止进程，而 `spawnSync`
 * 还阻塞着事件循环），改动会留在 stash 里。取回方式：
 *
 *     git stash list      # 找 "obsync-verify-head" 那条
 *     git stash pop
 *
 * ## 已知的边界
 *
 * 它只能发现「HEAD 的测试是红的」，发现不了「HEAD 缺了个改动、而测试恰好不覆盖它」。
 * 所以它是**兜底**，不是「提交前检查」的替代 —— 提交前仍然要对着 `git status`
 * 核一遍「改了哪些文件、提交了哪些文件」。
 */

import { spawnSync } from "node:child_process";

/** stash 的说明文字。出问题时用户靠它在 `git stash list` 里找到自己的改动。 */
const STASH_MESSAGE = "obsync-verify-head";

const IS_WINDOWS = process.platform === "win32";

/** 跑一条命令并继承 stdio（测试输出要能实时看到）。 */
function run(command, args) {
    // Windows 上 `pnpm` 是 `.cmd`，不套 shell 会 ENOENT。
    return spawnSync(command, args, { stdio: "inherit", shell: IS_WINDOWS });
}

/** 跑一条命令并取回 stdout（只用于 git 的状态查询）。 */
function capture(command, args) {
    return spawnSync(command, args, { encoding: "utf8", shell: IS_WINDOWS });
}

const status = capture("git", ["status", "--porcelain"]);
if (status.status !== 0) {
    console.error("verify:head 中止：这里不是可用的 git 仓库。");
    process.exit(1);
}

let stashed = false;

if (status.stdout.trim().length > 0) {
    console.log("verify:head 工作区有未提交改动 —— 先 stash 起来，好在干净的 HEAD 上跑。");
    const push = run("git", ["stash", "push", "--include-untracked", "-m", STASH_MESSAGE]);
    if (push.status !== 0) {
        console.error("verify:head 中止：stash 失败，**没有**动你的工作区。");
        process.exit(1);
    }
    stashed = true;
} else {
    console.log("verify:head 工作区干净 —— 直接在当前状态（= HEAD）上跑。");
}

let testsFailed = false;
let popFailed = false;

try {
    testsFailed = run("pnpm", ["test"]).status !== 0;
} finally {
    if (stashed) {
        console.log("\nverify:head 恢复工作区…");
        popFailed = run("git", ["stash", "pop"]).status !== 0;
    }
}

if (popFailed) {
    // 绝不能静默：改动还在 stash 里，用户需要知道去哪找。
    console.error(
        "verify:head 警告：`git stash pop` 失败，你的改动**仍在 stash 里**。\n" +
            "  手动取回：`git stash list` → `git stash pop`"
    );
    process.exitCode = 1;
} else if (testsFailed) {
    console.error(
        "\nverify:head HEAD 的测试**没有全过** —— 先别推。\n" +
            "  常见原因：某个改动改了代码却没提交（测试提交了、实现没提交）。\n" +
            "  对着 `git status` 核一遍「改了哪些文件、提交了哪些文件」。"
    );
    process.exitCode = 1;
} else {
    console.log("\nverify:head HEAD 的测试全过。");
}
