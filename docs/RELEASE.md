# 发版清单

> 目标：任何人在任何时候照着走都能发出版本，不用重新推导步骤、不用重新踩坑。
> 下面带 ⚠ 的都是**实测踩过**的，不是理论提醒。

---

## 一、发版前

```bash
pnpm check        # 项目自查（minAppVersion / 硬编码中文 / 死键 / CSS 类 / 移动端安全）
pnpm typecheck
pnpm test         # 单元测试，约 2.5 分钟
pnpm build        # 会先跑 check，然后构建 + 部署到测试库
pnpm verify:mobile  # 构建 + 用真实产物验证「移动端能加载」（见下）
```

`pnpm check` 里最容易漏的是 **minAppVersion 一致性** ——
它是发布阻断级的：manifest 承诺的最低版本低于代码实际用到的 API，
低版本用户装上就崩，而 TypeScript 不会提醒（类型包永远是最新版）。
自查会拦下这种情况。

**`pnpm verify:mobile` 为什么单独一步**：自查里的「移动端安全」是从
`src/main.ts` 走**静态导入图**判断的（快，但只是推断）；这一步直接把打包后的
`main.js` 放进一个「`require` 对 node 内置模块抛错」的环境里加载，
等价于移动端的条件 —— 是**实证**。它守的性质是「插件在移动端不会一启用就崩」，
而这个不变式很容易被顺手改回静态 import 破坏，且在桌面上测不出来。
预期输出「加载结果：没有在加载阶段抛错」。

### 手工确认（自查覆盖不到的）

- [ ] 在测试库里**手动点一遍**两个功能的入口：安装器弹窗能打开、设置页四个标签能切、
      同步命令出现在命令面板里
- [ ] `manifest.json` 的 `id` 仍是 `obsync`（改 id 等于换插件，用户数据会断）
- [ ] 中英文都扫一眼：把语言切成 English，确认没有中文残留
- [ ] 设置页「OBSync 自身」：点一次「检查更新」，版本号应与 `manifest.json` 一致
      （这条同时验了发布件里的 manifest 与仓库坐标没写错）
- [ ] **在真实库里走一遍主题链路**：绑定一个已装主题（来源应被识别）→ 检查更新 →
      更新后你当前用的主题**不应该变** → 点「取消绑定」后主题目录与文件必须还在（它不删文件）
      （这一段依赖 Obsidian 的非公开 API，自查扫不到，只能真机看）
- [ ] **在一个真实的私有仓库上验一次鉴权**（发版前最值得做的一条，见下）

### 私有仓库鉴权：一条命令验完

```bash
# GitHub
export OBSYNC_LIVE_PRIVATE_REPO="https://github.com/<你>/<私有仓库>.git"
pnpm test:live

# Gitee（要令牌；GitHub 上可省略，会自动回退 gh auth token）
export OBSYNC_LIVE_PRIVATE_REPO="https://gitee.com/<你>/<私有仓库>.git"
export OBSYNC_LIVE_TOKEN="<私人令牌>"
pnpm test:live
```

它会跑两条：**不带凭据必须失败**（对照组 —— 缺了它，「成功」什么也证明不了）、
**带令牌必须成功**。未配置环境变量时整组跳过，不影响常规 `pnpm test:live`。

⚠ **`pnpm check` / 单测都替代不了这条**：它们能证明「我们构造出了合法的 Basic 头」，
但证明不了「对端接不接受」。曾经就因为用户名填 `git`（GitHub 的习惯写法）导致
Gitee 私有仓库必然被拒，而所有单测都是绿的。

⚠ **「设置 → 连接测试」也发现不了用户名问题**：它走 `ls-remote`（fetch 路径），
而 Gitee 的用户名白名单只在 **push 路径**的服务端钩子里执行。想连这条也覆盖，
加一个环境变量开启 push 预检（`--dry-run`，不发送对象、不更新引用）：

```bash
export OBSYNC_LIVE_ALLOW_PUSH_DRY_RUN=1
```

---

## 二、改版本号

两处**必须同步**，漏一个就会出现「Obsidian 提示更新但装上去版本没变」：

```
manifest.json   → "version": "X.Y.Z"
versions.json   → { "X.Y.Z": "<manifest 里的 minAppVersion>" }
```

`versions.json` 是 Obsidian 用来判断「这个插件版本要求的最低 Obsidian 版本」的，
**值要和 manifest 的 `minAppVersion` 一致**，不是插件版本。

然后重新 `pnpm build`（产物里的 manifest 会被复制到部署目录）。

---

## 三、提交并推送

```bash
git add -A && git commit -m "chore(release): vX.Y.Z"
```

⚠ **本机 `git push` 走 HTTPS 到 GitHub 会先卡约 97 秒**：
系统级 `credential.helper=helper-selector`（PortableGit 自带）在非交互环境里干等超时，
之后才轮到 `gh` 的凭据助手。看起来像网络问题，其实不是。
绕过的姿势（不落盘任何凭据）：

```bash
export GH_TOKEN="$(gh auth token)"
git -c credential.helper= \
    -c 'credential.helper=!f() { echo username=x-access-token; echo password="$GH_TOKEN"; }; f' \
    push origin main
```

要点：`-c credential.helper=` 传**空值**会重置助手链，从而跳过 selector，
也避免 approve/store 往磁盘写东西。

⚠ **`gh auth status` 不可信** —— 它常报「未登录」，但 `gh auth token` 其实能返回有效令牌。
判断有无凭据一律以 `gh auth token` 为准。

### 当 `github.com:443` 被阻断时：走 api.github.com 推分支

**实测（2026-09-18 发 0.1.1 时）**：`github.com` 整站连不上（`curl` 直接
`000` / git 报 `OpenSSL SSL_read: Connection was reset`），而 **`api.github.com`
一直通**（同一时刻 0.7 秒 200）。这时 `git push` 一条路都走不通，但 Git Data API
能把同一件事做完：blob → tree → commit → 更新 ref。

```bash
export GH_TOKEN="$(gh auth token)"

# 只推「当前 HEAD 这一个提交」（远端已有它的父提交时用这个）
node scripts/api-push.mjs Dyse-Sofqi/OBSync main "$(git rev-parse HEAD)"

# 远端落后很多、要把整段历史都推上去时用这个（逐个提交重放）
node scripts/api-replay.mjs Dyse-Sofqi/OBSync <远端当前 sha> "$(git rev-parse HEAD)"
```

两个脚本的共同点：**author / committer（含时区）/ message 全部照抄本地提交**，
并且每个提交的 tree 按 `git ls-tree -r` 完整重建 —— 于是**连 commit SHA 都逐字节相同**
（实测 49 个提交全部 `SHA 一致`），远端历史与本地严格一致，将来 `git push` 是空操作。
脚本在写每个 blob / tree 后都会拿服务端返回的 sha 与本地比对，对不上就立刻失败。

⚠ **不要用「只推一个合并后的提交」的偷懒办法**：远端落后很多时那等于把整段开发
历史压成一条，提交信息全丢，而且本地与远端从此分叉（内容相同、历史不同，
下次 `git push` 会被拒，pull 又会造出一个重复内容的合并提交）。

⚠ **这台机器到 `api.github.com` 的连接也是间歇性的**：同一个脚本上一次 136 个 blob
全成、下一次第一个请求就 `Connect Timeout`。所以脚本里**每个请求都有重试**
（最多 5~6 次、退避 3s 起）；手写 curl 时请自带重试。

---

## 四、建 Release 与上传资产

Obsidian 的插件安装**要的是三个独立文件**，不是 zip：

| 资产 | 必需 | 说明 |
| --- | --- | --- |
| `main.js` | ✅ | 构建产物 |
| `manifest.json` | ✅ | 版本元信息 |
| `styles.css` | 建议 | 没有样式也能跑，但会很难看 |

先建 release：

```bash
cat > /tmp/release.json <<'JSON'
{
  "tag_name": "X.Y.Z",
  "name": "X.Y.Z",
  "body": "（见下方发版说明草稿）",
  "draft": false,
  "prerelease": false
}
JSON

gh api repos/Dyse-Sofqi/OBSync/releases --method POST --input /tmp/release.json
```

⚠ **release body 用 `--input <文件>` 传，不要用 `-f body=...`** ——
中文和引号会被 shell 拆坏。

⚠ **不要试图「只建 tag 让 Action 发版」**。用 Git Data API（`POST /git/refs`）建的 tag
**不会触发** `on: push: tags` 工作流：`actions/workflows` 显示工作流 active，
但 `actions/runs` 的 `total_count` 恒为 0。要么用 `git push` 推 tag，要么自己建 release。

再传资产：

```bash
gh release upload X.Y.Z main.js manifest.json styles.css
```

⚠ **必须用 `gh release upload`，不要用 `gh api --hostname uploads.github.com`** ——
`gh api` 会在 hostname 前再拼一个 `api.`，请求打到 `api.uploads.github.com`，
全部返回 `Bad Gateway`。重传同名资产加 `--clobber`。

**`github.com` 被阻断时也能传**（`uploads.github.com` 与 `api.github.com` 是另外的
主机名，实测仍然通）—— 直接 REST 上传，`curl` 自带重试更省事：

```bash
export GH_TOKEN="$(gh auth token)"
REL=$(gh api repos/Dyse-Sofqi/OBSync/releases/tags/X.Y.Z --jq .id)
for f in main.js manifest.json styles.css; do
  curl --retry 5 --retry-all-errors -X POST \
    -H "Authorization: Bearer $GH_TOKEN" \
    -H "Content-Type: application/octet-stream" \
    --data-binary "@$f" \
    "https://uploads.github.com/repos/Dyse-Sofqi/OBSync/releases/$REL/assets?name=$f"
done
```

### Gitee 镜像（`sofqi/OBSync`）：代码与标签会自动同步，**release 不会**

Gitee 那边开了 GitHub 同步镜像，所以**提交与标签会自己过来**
（实测：`git ls-remote --tags gitee` 里已经有 `0.1.1`，而本地其实从没建过这个 tag），
但 **release 与附件不会同步** —— 每次发版要手动建一次。

```bash
# 仓库已经加好了（URL 里不带凭据，凭据只在下面那一次命令里现给）
git remote -v | grep gitee      # → https://gitee.com/sofqi/OBSync.git
```

⚠ **Gitee 的「创建发行版」接口没有 `files` 参数**：传 `-F files=@main.js` 会被**静默忽略**
（返回 201、release 建出来了，附件一个都没有）。附件是**独立接口，且一次只能传一个**。

```bash
export GITEE_TOKEN="<私人令牌>"      # ⚠ 账号密码走不通：API 基本认证一律 401，必须是 PAT
Q="access_token=$GITEE_TOKEN"
API=https://gitee.com/api/v5/repos/sofqi/OBSync

curl -s -X POST "$API/releases" \
  -F "$Q" -F "tag_name=X.Y.Z" -F "name=X.Y.Z" -F "target_commitish=main" \
  -F "prerelease=false" -F "body=<发布说明.md"

REL=$(curl -s "$API/releases/tags/X.Y.Z?$Q" | jq .id)
for f in main.js manifest.json styles.css; do
  curl -s -X POST "$API/releases/$REL/attach_files" -F "$Q" -F "file=@$f"
done

# 核对（Gitee 的下载地址**能直连**，不像 github.com 那样被时段性阻断）
curl -s "$API/releases/$REL/attach_files?$Q" | jq -r '.[] | .browser_download_url'
```

⚠ **令牌不落盘**：别写进 remote URL（会进 `.git/config`，而 `git remote -v` 一眼就能看到 ——
这个项目自己论证过这条），也别设成全局 `credential.helper`。推代码用一次性的：

```bash
git -c credential.helper= \
    -c 'credential.helper=!f() { echo username=sofqi; echo password="$GITEE_TOKEN"; }; f' \
    push gitee main
```

---

## 五、校验上传结果

⚠ **不要靠下载来校验** —— `github.com:443` 会被时段性阻断，
走 `releases/download/...` 只会 curl 超时，看不出资产到底对不对。

用 API 读回元信息（含服务端算的 sha256），与本地比对：

```bash
gh api repos/Dyse-Sofqi/OBSync/releases/tags/X.Y.Z \
    --jq '.assets[] | "\(.name)  \(.size)  \(.digest)"'

# 本地
sha256sum main.js manifest.json styles.css
```

`digest` 形如 `sha256:...`，直接和本地输出对得上就没问题。
三个资产的 size 也应该和本地一致（非 0）。

---

## 六、发版说明草稿

首版可以照这个改：

```markdown
OBSync 把两件事合在一起：**用 git 同步笔记仓库** + **安装社区插件**，
并且把两者从「仅 GitHub」扩展到「GitHub / Gitee 双平台」，界面中文优先。

## 主要能力
- 笔记仓库同步：提交 → 拉取 → 推送一条链走完，冲突不自动解决而是生成处理指南
- 插件安装：从 GitHub 或 Gitee 安装、更新社区插件，并可回退到指定的旧版本
- 双平台：GitHub 与 Gitee 的差异只实现一次（统一的平台适配层）
- 中文优先，英文对等

## 安装
下载 `main.js` / `manifest.json` / `styles.css`，放进
`<你的库>/.obsidian/plugins/obsync/`，然后在 Obsidian 里启用。

## 要求
- Obsidian ≥ 1.8.7
- 笔记同步需要系统 git，**仅桌面端**；插件安装在移动端也可用

## 已知限制
- 同步只支持桌面端（移动端没有系统 git）
- 主题：支持**绑定库里已装的主题并更新**，不支持从仓库新装；不做版本钉选与主题 beta 通道
- 逐文件暂存、diff 查看、行作者等 obsidian-git 的增强功能不在首版范围内
```

---

## 七、发版后

- [ ] 在浏览器里打开 release 页面，确认三个资产都在、能点开
- [ ] 在一个**干净**的库里手动装一次（不要用开发库）——
      验证「下载资产 → 放进插件目录 → 启用」这条用户路径
- [ ] 把 `manifest.json` 的版本留在新版本上，别回退

---

## 附：本机环境相关的坑（发版时会撞上）

| 现象 | 原因 | 应对 |
| --- | --- | --- |
| `git push` 卡 97 秒 | 系统级 `credential.helper=helper-selector` 干等 | 见第三节的绕过姿势 |
| `gh auth status` 报未登录 | 已知不一致 | 以 `gh auth token` 为准 |
| `github.com:443` 连不上 | **时段性**阻断（沙箱内外表现一致） | 等窗口，或用 `api.github.com` 走 API |
| 代理返回 502 | `127.0.0.1:54305` 间歇性故障 | 重试，或 `env -u http_proxy -u https_proxy ...` 直连 |
| `gh api --hostname uploads.github.com` 返回 Bad Gateway | `gh api` 会多拼一个 `api.` | 改用 `gh release upload` |
