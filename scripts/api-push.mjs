/**
 * 用 GitHub REST API（api.github.com）把本地 HEAD 这个提交推到远端 main。
 *
 * 为什么要这么绕：github.com:443（git 通道）当前被时段性阻断，`git push` 直接
 * OpenSSL reset；而 api.github.com 通。Git Data API 能把同一件事做完：
 * blob → tree → commit → 更新 ref。
 *
 * 关键点：**author / committer / message / parents 全部照抄本地提交**，
 * 于是远端算出来的 commit SHA 与本地那个**逐字节相同** —— 历史不会分叉，
 * 等 github.com 恢复后 `git push` 是一次空操作，而不是一个重复内容的合并。
 *
 * 用法：GH_TOKEN=<token> node api-push.mjs <owner/repo> <branch> <localCommitSha>
 */
import { execFileSync } from "node:child_process";

const [repo, branch, headSha] = process.argv.slice(2);
const token = process.env.GH_TOKEN;
if (!repo || !branch || !headSha || !token) {
    throw new Error("用法: GH_TOKEN=<token> node api-push.mjs <owner/repo> <branch> <sha>");
}

const API = "https://api.github.com";
const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
    "User-Agent": "SyncHub-release-script",
};

/**
 * 带重试的 API 调用。
 *
 * 这台机器到 api.github.com 的连接是**间歇性**的（实测：同一个脚本上一次
 * 136 个 blob 全成，下一次就 Connect Timeout）—— 所以每一步都要能重试，
 * 否则跑到一半失败就得从头再来。
 */
async function api(method, path, body, attempt = 1) {
    const maxAttempts = 5;
    try {
        const response = await fetch(`${API}${path}`, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(60_000),
        });
        const text = await response.text();
        // 5xx / 429 也值得重试；4xx（除 429）说明请求本身有问题，立刻抛
        if (!response.ok && (response.status >= 500 || response.status === 429)) {
            throw new Error(`${method} ${path} → ${response.status}: ${text.slice(0, 200)}`);
        }
        if (!response.ok) {
            throw Object.assign(
                new Error(`${method} ${path} → ${response.status}: ${text.slice(0, 400)}`),
                { fatal: true }
            );
        }
        return text ? JSON.parse(text) : undefined;
    } catch (err) {
        if (err.fatal || attempt >= maxAttempts) throw err;
        const wait = attempt * 3000;
        console.warn(
            `\n  ${method} ${path} 失败（第 ${attempt} 次）：${err.message.slice(0, 120)}` +
                ` —— ${wait / 1000}s 后重试`
        );
        await new Promise((resolve) => setTimeout(resolve, wait));
        return api(method, path, body, attempt + 1);
    }
}

/** `git` 包装：一律不用工作区文件，而是直接读 HEAD 里的对象。 */
function git(args) {
    return execFileSync("git", args, { maxBuffer: 1 << 28 });
}

function gitText(args) {
    return git(args).toString("utf8");
}

// ── 1. 远端当前状态 ──────────────────────────────────────────────────────
const baseCommitSha = (await api("GET", `/repos/${repo}/git/ref/heads/${branch}`)).object.sha;
const baseCommit = await api("GET", `/repos/${repo}/git/commits/${baseCommitSha}`);
console.log(`远端 ${branch} = ${baseCommitSha.slice(0, 7)}`);
console.log(`本地 HEAD    = ${headSha.slice(0, 7)}`);

// ── 2. 差异清单（相对于远端那个提交）───────────────────────────────────
// --no-renames：重命名会拆成 A+D 两条，结果树完全一样，但解析简单得多
// --no-renames/-z：NUL 分隔，文件名里的空格与中文都不需要额外转义
const raw = gitText([
    "-c",
    "core.quotepath=false",
    "diff",
    "--name-status",
    "--no-renames",
    "-z",
    baseCommitSha,
    headSha,
]);
const parts = raw.split("\0").filter(Boolean);
const changes = [];
for (let i = 0; i < parts.length; i += 2) {
    changes.push({ status: parts[i][0], path: parts[i + 1] });
}
console.log(`需要推送的变更：${changes.length} 个`);

// 文件模式（git 里只有 100644 / 100755 两种，后者要保留）
const modes = new Map();
for (const line of gitText(["ls-tree", "-r", "-z", headSha]).split("\0").filter(Boolean)) {
    const [meta, path] = line.split("\t");
    // ls-tree 的一行是 "<mode> SP <type> SP <sha> TAB <path>"
    const [mode] = meta.split(/\s+/);
    if (!["100644", "100755", "120000", "160000"].includes(mode)) {
        throw new Error(`意外的文件模式 ${mode}（${path}）`);
    }
    modes.set(path, mode);
}

// ── 3. 逐个上传 blob（只传新增/修改的）─────────────────────────────────
const treeEntries = [];
let uploaded = 0;
const deleted = changes.filter((change) => change.status === "D");
const upserts = changes.filter((change) => change.status !== "D");

const CONCURRENCY = 8;
for (let i = 0; i < upserts.length; i += CONCURRENCY) {
    const batch = upserts.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
        batch.map(async (change) => {
            // 从 HEAD 的 blob 取内容（不读工作区：那里可能被 autocrlf 换过行尾）
            const content = git(["show", `${headSha}:${change.path}`]);
            const blob = await api("POST", `/repos/${repo}/git/blobs`, {
                content: content.toString("base64"),
                encoding: "base64",
            });
            return {
                path: change.path,
                mode: modes.get(change.path) ?? "100644",
                type: "blob",
                sha: blob.sha,
                local: gitText(["rev-parse", `${headSha}:${change.path}`]).trim(),
            };
        })
    );
    for (const entry of results) {
        if (entry.sha !== entry.local) {
            throw new Error(
                `blob 校验失败 ${entry.path}: 远端 ${entry.sha} ≠ 本地 ${entry.local}`
            );
        }
        treeEntries.push(entry);
        uploaded += 1;
    }
    process.stdout.write(`\r  已上传 ${uploaded}/${upserts.length}`);
}

// 删除的文件：树里把 sha 置空
for (const change of deleted) {
    treeEntries.push({ path: change.path, mode: "100644", type: "blob", sha: null });
}
console.log(`\n  上传完成：新增/修改 ${upserts.length}，删除 ${deleted.length}`);

// ── 4. 建树 ──────────────────────────────────────────────────────────────
const tree = await api("POST", `/repos/${repo}/git/trees`, {
    base_tree: baseCommit.tree.sha,
    tree: treeEntries.map((entry) => ({
        path: entry.path,
        mode: entry.mode,
        type: "blob",
        sha: entry.sha,
    })),
});
console.log(`新 tree = ${tree.sha}`);

// ── 5. 提交：作者/提交者/时间/信息全部照抄本地那个提交 ────────────────
const local = gitText(["cat-file", "-p", headSha]);
const field = (name) => {
    const line = local
        .split("\n")
        .find((candidate) => candidate.startsWith(`${name} `));
    if (!line) throw new Error(`本地提交里没有 ${name}`);
    const match = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(line.slice(name.length + 1));
    if (!match) throw new Error(`解析不了 ${name}: ${line}`);
    const [, who, email, epoch, offset] = match;
    // epoch + 原样时区偏移 → ISO 8601（GitHub 会按这个算 commit 内容，
    // 所以时区必须原样保留，否则 SHA 会对不上）
    const shifted = new Date((Number(epoch) + offsetToSeconds(offset)) * 1000)
        .toISOString()
        .replace("Z", "");
    return { name: who, email, date: `${shifted}${offset.slice(0, 3)}:${offset.slice(3)}` };
};
function offsetToSeconds(offset) {
    const sign = offset.startsWith("-") ? -1 : 1;
    return sign * (Number(offset.slice(1, 3)) * 3600 + Number(offset.slice(3)) * 60);
}
const message = local.slice(local.indexOf("\n\n") + 2);

const commit = await api("POST", `/repos/${repo}/git/commits`, {
    message,
    tree: tree.sha,
    parents: [baseCommitSha],
    author: field("author"),
    committer: field("committer"),
});
console.log(`新 commit = ${commit.sha}`);
if (commit.sha !== headSha) {
    console.warn(
        `⚠ 远端算出的 SHA 与本地不同（本地 ${headSha}）—— 内容一致但元信息有差异，` +
            `将来 git push 会需要人工对齐`
    );
}

// ── 6. 更新 main ─────────────────────────────────────────────────────────
await api("PATCH", `/repos/${repo}/git/refs/heads/${branch}`, { sha: commit.sha, force: false });
console.log(`✔ ${branch} 已更新`);

// ── 7. 可选：打标签（发版时用；release API 也能建标签，这里显式建便于核对）──
const tag = process.env.RELEASE_TAG;
if (tag) {
    await api("POST", `/repos/${repo}/git/refs`, { ref: `refs/tags/${tag}`, sha: commit.sha });
    console.log(`✔ 标签 ${tag} 已创建`);
} else {
    console.log("（未设 RELEASE_TAG，跳过打标签）");
}
