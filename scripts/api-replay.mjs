/**
 * 用 GitHub REST API（api.github.com）把本地历史**逐个提交**推到远端。
 *
 * 为什么不是一次推一个「当前状态」的提交：远端 main 还停在 initial commit，
 * 本地有 43 个提交 —— 只推一个合并后的提交等于把整个开发历史压成一条，
 * 那些提交信息（每一个都对应一个真实的 bug 或决策）就没了。而 git 通道
 * （github.com:443）当前被阻断，所以改走 Git Data API 把提交一条条重放。
 *
 * 做法与保真度：
 * - 每个提交的 tree 按 `git ls-tree -r <sha>` **完整重建**（内容是同一个 blob
 *   对象，所以 tree SHA 与本地**逐字节相同**，这里会断言）；
 * - author / committer（含时区）/ message 从 `git cat-file -p` 原样照抄；
 * - blob 按内容 SHA 缓存，跨提交不重复上传。
 * 唯一可能对不上的是 commit 自身的 SHA（GitHub 内部可能把时区归一到 UTC），
 * 所以脚本最后会把本地分支对齐到远端，避免「内容相同但历史分叉」。
 *
 * 用法：GH_TOKEN=<token> node _tmp_api_replay.mjs <owner/repo> <fromSha> <toSha>
 */
import { execFileSync } from "node:child_process";

const [repo, fromSha, toSha] = process.argv.slice(2);
const token = process.env.GH_TOKEN;
if (!repo || !fromSha || !toSha || !token) {
    throw new Error("用法: GH_TOKEN=<token> node _tmp_api_replay.mjs <owner/repo> <fromSha> <toSha>");
}

const API = "https://api.github.com";
const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
    "User-Agent": "SyncHub-release-script",
};

async function api(method, path, body, attempt = 1) {
    const maxAttempts = 6;
    try {
        const response = await fetch(`${API}${path}`, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(90_000),
        });
        const text = await response.text();
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
            `\n  ${method} ${path} 失败（第 ${attempt} 次）：${err.message.slice(0, 100)} —— 重试`
        );
        await new Promise((resolve) => setTimeout(resolve, wait));
        return api(method, path, body, attempt + 1);
    }
}

const git = (args, encoding) =>
    encoding === undefined
        ? execFileSync("git", args, { maxBuffer: 1 << 28 })
        : execFileSync("git", args, { maxBuffer: 1 << 28, encoding });
const text = (args) => git(args, "utf8");

function offsetToSeconds(offset) {
    const sign = offset.startsWith("-") ? -1 : 1;
    return sign * (Number(offset.slice(1, 3)) * 3600 + Number(offset.slice(3)) * 60);
}

/** 把 git 的 `Name <mail> 1758… +0800` 转成 API 要的对象（时区原样保留）。 */
function identity(line, label) {
    const match = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(line);
    if (!match) throw new Error(`解析不了 ${label}: ${line}`);
    const [, name, email, epoch, offset] = match;
    const shifted = new Date((Number(epoch) + offsetToSeconds(offset)) * 1000)
        .toISOString()
        .slice(0, 19);
    return { name, email, date: `${shifted}${offset.slice(0, 3)}:${offset.slice(3)}` };
}

const blobCache = new Map(); // 本地 blob sha → 远端 blob sha
async function ensureBlob(localSha) {
    if (blobCache.has(localSha)) return blobCache.get(localSha);
    const content = git(["cat-file", "blob", localSha]);
    const blob = await api("POST", `/repos/${repo}/git/blobs`, {
        content: content.toString("base64"),
        encoding: "base64",
    });
    if (blob.sha !== localSha) {
        throw new Error(`blob 内容对不上：本地 ${localSha} ≠ 远端 ${blob.sha}`);
    }
    blobCache.set(localSha, blob.sha);
    return blob.sha;
}

const commits = text(["rev-list", "--reverse", `${fromSha}..${toSha}`])
    .split("\n")
    .filter(Boolean);
console.log(`要重放 ${commits.length} 个提交（${fromSha.slice(0, 7)} → ${toSha.slice(0, 7)}）`);

let parent = fromSha;
let index = 0;
for (const sha of commits) {
    index += 1;
    const subject = text(["log", "-1", "--format=%s", sha]).trim();

    // 这个提交的完整树
    const entries = [];
    for (const line of text(["ls-tree", "-r", "-z", sha]).split("\0").filter(Boolean)) {
        const [meta, path] = line.split("\t");
        const [mode, , blobSha] = meta.split(/\s+/);
        entries.push({ path, mode, type: "blob", sha: await ensureBlob(blobSha) });
    }

    const tree = await api("POST", `/repos/${repo}/git/trees`, { tree: entries });
    const localTree = text(["rev-parse", `${sha}^{tree}`]).trim();
    if (tree.sha !== localTree) {
        throw new Error(`tree 对不上 ${sha.slice(0, 7)}：远端 ${tree.sha} ≠ 本地 ${localTree}`);
    }

    const raw = text(["cat-file", "-p", sha]);
    const headers = raw.slice(0, raw.indexOf("\n\n")).split("\n");
    const pick = (name) => headers.find((line) => line.startsWith(`${name} `)).slice(name.length + 1);
    const commit = await api("POST", `/repos/${repo}/git/commits`, {
        message: raw.slice(raw.indexOf("\n\n") + 2),
        tree: tree.sha,
        parents: [parent],
        author: identity(pick("author"), "author"),
        committer: identity(pick("committer"), "committer"),
    });
    const exact = commit.sha === sha ? "SHA 一致" : `SHA ${commit.sha.slice(0, 7)}`;
    console.log(`  [${index}/${commits.length}] ${sha.slice(0, 7)} → ${commit.sha.slice(0, 7)} ${exact}  ${subject.slice(0, 40)}`);
    parent = commit.sha;
}

await api("PATCH", `/repos/${repo}/git/refs/heads/main`, { sha: parent, force: true });
console.log(`✔ main → ${parent}`);

// 标签**不在这里碰**。发版时 tag 由「建 release 的 `tag_name`」自动创建，而 GitHub 会把
// 它指向**当时默认分支的 HEAD** —— 所以顺序必须是「先推分支、再建 release」
// （见 docs/RELEASE.md 第三、四节）。
//
// 这里曾经硬编码着一行 `PATCH .../tags/0.1.1 { sha: parent }`，那是**首推时的一次性
// 修正**（当时 release 的 tag 指向了一个后来被丢弃的合并提交）。留在通用脚本里就成了
// 定时炸弹：第二次用它推历史时，会把**本来正确**的 `0.1.1` 标签也拖到新提交上 ——
// 2026-09-20 发 0.1.2 时实测踩到，症状是「checkout 0.1.1 拿到的是 0.1.2 的代码」。
// 要修正某个标签时，用一条显式的 PATCH 命令去做，别写进通用脚本。

console.log(`\n远端 main = ${parent}`);
console.log(`本地 HEAD = ${toSha}`);
