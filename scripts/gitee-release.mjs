/**
 * 在 **Gitee 镜像**上建 release 并上传三件套。
 *
 * ## 用法
 *
 *     GITEE_TOKEN=<私人令牌> node scripts/gitee-release.mjs 0.1.2
 *
 * ## 为什么要有这个脚本（而不是照 `docs/RELEASE.md` 手敲 curl）
 *
 * 1. **Gitee 的「创建发行版」接口没有 `files` 参数** —— 传了会被**静默忽略**
 *    （返回 201、release 建出来了、附件一个都没有）。附件是**独立接口，且一次只能传一个**。
 *    手敲很容易漏掉「逐个上传」这一步，而症状是「release 看起来建好了、其实没附件」——
 *    用户下载时才发现。
 * 2. `RELEASE.md` 的示例用 `jq` 取 release id，而**本机没有 `jq`**。
 * 3. release body 含中文与换行，`-F body=...` 会被 shell 拆坏（RELEASE.md 自己也警告过）。
 *    这里**从 `CHANGELOG.md` 里抽对应版本的段落**当 body —— 单一事实来源，不用维护第二份文案。
 * 4. Gitee 匿名 API 配额极低（连续十几次就 403），所以每一步都带重试。
 *
 * ## 令牌
 *
 * 只从环境变量 `GITEE_TOKEN` 读。**不写进任何文件、不写进 remote URL** ——
 * `git remote -v` 一眼能看到 `.git/config` 里的东西，这个项目自己论证过这条。
 *
 * ⚠️ Gitee 的 API **不接受账号密码**（基本认证一律 401），必须是私人令牌：
 * 设置 → 私人令牌，至少勾 `projects`。
 */

import fs from "node:fs";

const OWNER_REPO = "sofqi/SyncHub";
const API = `https://gitee.com/api/v5/repos/${OWNER_REPO}`;
const ASSETS = ["main.js", "manifest.json", "styles.css"];

const version = process.argv[2];
const token = process.env.GITEE_TOKEN;

if (!version) {
    console.error("用法: GITEE_TOKEN=<令牌> node scripts/gitee-release.mjs <版本号>");
    process.exit(1);
}
if (!token) {
    console.error(
        "缺少 GITEE_TOKEN。\n" +
            "  Gitee 的 API 不接受账号密码（基本认证一律 401），必须是私人令牌：\n" +
            "  Gitee → 设置 → 私人令牌，至少勾选 projects。\n" +
            "  然后：GITEE_TOKEN=<令牌> node scripts/gitee-release.mjs " +
            version
    );
    process.exit(1);
}

/** 带重试的请求 —— Gitee 匿名/低配额下偶发 403、502。 */
async function request(method, url, init = {}, attempt = 1) {
    const maxAttempts = 5;
    try {
        const response = await fetch(url, { method, ...init, signal: AbortSignal.timeout(60_000) });
        const text = await response.text();
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
        }
        return text.length > 0 ? JSON.parse(text) : undefined;
    } catch (err) {
        if (attempt >= maxAttempts) throw err;
        const wait = attempt * 3000;
        console.log(`  请求失败（${err.message.slice(0, 80)}），${wait / 1000}s 后重试 ${attempt}/${maxAttempts - 1}`);
        await new Promise((resolve) => setTimeout(resolve, wait));
        return request(method, url, init, attempt + 1);
    }
}

/** 从 CHANGELOG 里抽该版本的段落当 release body（去掉末尾的链接引用行）。 */
function notesFromChangelog(v) {
    const changelog = fs.readFileSync("CHANGELOG.md", "utf8");
    const marker = `## [${v}]`;
    const start = changelog.indexOf(marker);
    if (start === -1) {
        throw new Error(`CHANGELOG.md 里找不到 ${marker} —— 先把这一版记进变更日志再发版。`);
    }
    const next = changelog.indexOf("\n## [", start + 1);
    // 从**标题行的下一行**开始取 —— 用 `start + marker.length` 会带上「 — 2026-09-20」那段。
    const lineEnd = changelog.indexOf("\n", start);
    return changelog
        .slice(lineEnd + 1, next === -1 ? undefined : next)
        .split("\n")
        .filter((line) => !/^\[\d+\.\d+\.\d+\]:/.test(line.trim()))
        .join("\n")
        .trim();
}

const query = `access_token=${encodeURIComponent(token)}`;
const body = notesFromChangelog(version);

/**
 * 幂等：同一个 tag 已经有 release 时**绝不**再 POST。
 *
 * Gitee 允许同一个 tag 上挂多份 release（不像 GitHub 会拒），所以「重跑一次脚本」
 * 的后果是页面上出现两个 0.1.7 —— 而它看起来完全正常，只有下载页的列表能看出来。
 * 命中时改为：把 body 对齐到 CHANGELOG（幂等本来就该顺带把说明更新到最新），
 * 资产只补缺的那些（Gitee 没有 `--clobber`）。
 */
const existingList = await request("GET", `${API}/releases?per_page=100&${query}`);
const existing = Array.isArray(existingList)
    ? existingList.find((item) => item.tag_name === version)
    : undefined;

let release;
if (existing) {
    console.log(`gitee.com/${OWNER_REPO} 上 ${version} 的 release 已存在（id=${existing.id}），跳过创建`);
    if ((existing.body ?? "") !== body) {
        // Gitee 的 PATCH 会校验整个载荷：`tag_name` / `name` 也必须带上，否则 400。
        await request("PATCH", `${API}/releases/${existing.id}`, {
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                access_token: token,
                tag_name: version,
                name: version,
                body,
            }),
        });
        console.log(`  发版说明已对齐到 CHANGELOG（${body.length} 字符）`);
    }
    release = existing;
} else {
    console.log(`在 gitee.com/${OWNER_REPO} 建 release ${version}`);
    console.log(`  发版说明取自 CHANGELOG.md 的 ${version} 段（${body.length} 字符）`);
    release = await request("POST", `${API}/releases`, {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            access_token: token,
            tag_name: version,
            name: version,
            target_commitish: "main",
            prerelease: "false",
            body,
        }),
    });
    console.log(`✔ release 已建，id=${release.id}`);
}

// ⚠️ 附件必须逐个传：Gitee 没有批量参数，`files` 会被静默忽略。
// 已有的跳过（重传没有覆盖语义，只会多出一份同名附件）。
const alreadyAttached = new Set((release.assets ?? []).map((asset) => asset.name));
for (const name of ASSETS) {
    if (alreadyAttached.has(name)) {
        console.log(`✔ 附件已存在，跳过：${name}`);
        continue;
    }
    if (!fs.existsSync(name)) {
        throw new Error(`本地缺少 ${name} —— 先跑 pnpm build 再发版。`);
    }
    const form = new FormData();
    form.append("access_token", token);
    form.append("file", new Blob([fs.readFileSync(name)]), name);
    const uploaded = await request("POST", `${API}/releases/${release.id}/attach_files`, {
        body: form,
    });
    console.log(`✔ 已上传 ${name}  (${fs.statSync(name).size} 字节 → 服务端 ${uploaded.size ?? "?"})`);
}

const attached = await request("GET", `${API}/releases/${release.id}/attach_files?${query}`);
console.log(`\n服务端附件 ${attached.length} 个：`);
for (const file of attached) {
    console.log(`  ${file.name}  ${file.size ?? "?"} 字节  ${file.browser_download_url ?? ""}`);
}
if (attached.length !== ASSETS.length) {
    console.error(`\n⚠️ 期望 ${ASSETS.length} 个附件，实际 ${attached.length} 个 —— 别急着宣布发版成功。`);
    process.exit(1);
}
console.log(`\n✔ Gitee 镜像发版完成：https://gitee.com/${OWNER_REPO}/releases/tag/${version}`);
