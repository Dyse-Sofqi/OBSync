<div align="center">

# OBSync

用 git 同步你的笔记仓库，同时安装社区插件与主题 —— GitHub / Gitee 双平台。

[![GitHub Release](https://img.shields.io/github/v/release/Dyse-Sofqi/OBSync?style=flat-square&logo=github&color=%2342b883)](https://github.com/Dyse-Sofqi/OBSync/releases) [![License](https://img.shields.io/github/license/Dyse-Sofqi/OBSync?style=flat-square&color=%2342b883)](LICENSE) [![Obsidian Min App](https://img.shields.io/badge/Obsidian-%5E1.8.7-%234a7ec1?style=flat-square&logo=obsidian&logoColor=%234a7ec1)](https://obsidian.md) [![GitHub Stars](https://img.shields.io/github/stars/Dyse-Sofqi/OBSync?style=flat-square&logo=github&color=%23e4b341)](https://github.com/Dyse-Sofqi/OBSync)

</div>

---

> 🇬🇧 **English**: scroll down to the [English section](#-english).

📜 完整更新记录见 [CHANGELOG](CHANGELOG.md)。

### 简介

OBSync 把两件事合在一起，并且让它们都**不只认 GitHub**：

- **笔记仓库同步** —— 用 git 把整个库同步到 GitHub 或 Gitee：提交、拉取、推送一条链走完，
  冲突不替你决定而是留下一份处理指南
- **社区插件与主题** —— 从 GitHub 或 Gitee 安装、更新、冻结、取消绑定；
  库里已经装好的插件与主题可以一次性绑定进来跟着一起更新
- **OBSync 自身也能更新** —— 设置页里检查并更新它自己

两个功能共用同一层平台适配，所以 **GitHub 与 Gitee 的差别只实现一次**。界面中文优先、英文对等。

OBSync bundles two things and refuses to be GitHub-only:

- **Vault sync over git** — commit, pull and push your whole vault to GitHub *or* Gitee in one chain.
  Conflicts are never resolved for you: OBSync stops the chain and writes a resolution guide instead.
- **Community plugins and themes** — install, update, freeze and unbind from either platform,
  and adopt the plugins/themes you already have so they update alongside.
- **OBSync updates itself** — check and apply new versions of the plugin from its own settings page.

Both features share a single platform layer, so **every GitHub/Gitee difference is implemented once**.
Chinese-first UI with an equal English one.

### 关键词 / Keywords

**中文**

- **笔记同步** — 提交 → 拉取 → 推送一条链 · 冲突指南（不自动解决）· 自动提交/推送/拉取定时器 ·
  源码控制视图（侧边栏，可点状态栏打开）· 状态栏条目 · 初始化仓库时建 `.gitignore` ·
  在远端打开文件/历史/提交 · 编辑远端 · 连接测试
- **插件与主题** — 地址识别（GitHub / Gitee）· release 资产与仓库源码双通道 · 版本选择（含预发布回退）·
  写入前备份 + 失败回滚 · 更新检查（单个/全部/启动/进入设置页）· 常驻更新徽标 · 冻结 ·
  **版本回退** · 取消绑定（不删文件）· 绑定已装插件与主题 · Gitee 镜像发现 · 自我更新
- **平台与体验** — 双平台适配层 · 令牌进系统密钥库并从日志脱敏 · 中文优先英文对等 ·
  错误文案走类型码 + locale · 移动端可加载（同步仅桌面）

**English**

- **Vault sync** — commit → pull → push in one chain · conflict guide (no auto-resolution) ·
  auto commit/push/pull timers · source-control view (sidebar, openable from the status bar) ·
  status-bar item · `.gitignore` created on init ·
  open file/history/commit on the remote · edit remote · connection test
- **Plugins & themes** — address recognition (GitHub / Gitee) · release assets **and** repository source fallback ·
  version picker (with prerelease fallback) · backup before write + rollback on failure · update checks
  (single / all / on startup / on opening settings) · persistent update badges · freeze ·
  **version rollback** · unbind (keeps files) · adopt already-installed plugins and themes ·
  Gitee mirror discovery · self-update
- **Platform & UX** — one platform layer for both hosts · tokens in the OS keychain, redacted from logs ·
  Chinese-first with an equal English UI · error text via type codes + locales ·
  loadable on mobile (sync is desktop-only)

### 功能

#### 🔄 笔记仓库同步（仅桌面端）

依赖系统 git，因此**仅桌面端可用**（Windows / macOS / Linux）。

- **立即同步** —— 提交 → 拉取 → 推送，一条链走完；也可以单独执行「提交全部更改」「从远端拉取」「推送到远端」
- **初始化仓库** —— 顺便建一份 `.gitignore`（默认排除 `.obsidian/workspace.json` 这类
  **每台设备各自维护**的文件，同步它们只会制造冲突）。**已存在的 `.gitignore` 绝不覆盖**，
  另有「编辑 .gitignore」命令可以随时改它
- **冲突处理** —— 检测到冲突时在库根目录写一份《OBSync 冲突指南.md》列出冲突文件，
  然后**立即停止同步链**；手动解决后重新同步，或用「放弃当前合并」回到拉取之前
- **自动同步**（默认关闭）—— 自动提交 / 自动推送 / 自动拉取三个间隔（分钟，0 = 关闭）。
  计时基于**上次执行时间**，重启 Obsidian 不重置周期；存储按库隔离，多个库互不干扰
- **源码控制视图**（侧边栏）—— 打开方式：侧栏的 **git 图标**、点一下**状态栏条目**，
  或命令 **OBSync：打开源码控制面板**。里面有：分支下拉切换、远端地址（脱敏后回显）+ 编辑入口、
  `领先 / 落后远端`、冲突区（列出冲突文件 + 放弃合并）、**按「已暂存 / 更改」分组的文件列表**
  （逐个文件暂存 / 取消暂存、点文件名打开笔记、在远端打开此文件）、最近 10 条提交
  （点 hash 在远端查看这条提交）。不是 git 仓库时这里直接给「初始化仓库」按钮。
  面板是**活的**：自动提交、库外改动、命令面板里的动作都会让它自己刷新
- **状态栏条目** —— 分支 / `↑ahead ↓behind` / `~脏文件数` / `⚠冲突数`，以及进行中的动作；
  贴在状态栏**最左侧**（这是刻意的：它回答「现在同步到哪了」，不该藏在右下角），
  并且**可以点开**（打开源码控制视图）
- **在浏览器中打开** —— 当前文件、当前文件的修改历史，以及文件右键菜单里的同样两项；
  GitHub 与 Gitee 各按平台拼链接（中文文件名会自动转义）
- **连接测试** —— 一条递进的检查链：git 可执行文件 → 是否 git 仓库 → 有没有远端 →
  平台能否识别 → **真的 `ls-remote` 连一次**。任何一步失败就停，并说明「只验证了读取」
- **编辑远端地址** —— 地址里带凭据（`https://user:token@…`）时会给出警告，提示信息本身也脱敏

#### 🧩 社区插件与主题

- **从地址安装** —— 填 `owner/repo` 简写，或直接粘贴 GitHub / Gitee 的完整链接；识别结果会显示平台，
  命中镜像时另有说明
- **两条下载通道** —— 优先 release 资产，仓库没有发 release 时回退到**仓库源码文件**
  （Gitee 上大多数插件仓库没有 release，所以这条通道是必需的，不是补充）
- **版本选择** —— 默认最新，也可以从 release 列表里挑具体版本；只有预发布版的仓库会回退到预发布版
- **版本回退** —— 跟踪列表里每个插件都能切换版本：列出已发布的版本（**当前装的那一版会被标出来**），
  选旧版本即回退。选「最新版本」则恢复跟随最新；选定的版本会被记住（下次打开默认选中它）。
  **要修一个坏掉的安装**：打开它、直接点切换即可 —— 那正是原来那个「重装」按钮做的事
  （默认选中的就是你记录里的那一版），所以那个按钮已经并进来了
- **写入前备份、失败整体回滚** —— 安装失败不会在库里留下半个插件
- **更新检查** —— 单个检查 / 全部检查 / 启动后延迟检查 / 进入设置页时检查（可关）；
  有更新的行常驻徽标（Notice 一闪就错过）。**只检查并提示，安装永远手动**
- **跟踪列表的每一项操作** —— 检查、更新、**版本管理（切到另一个发布版本，选旧版本就是回退）**、
  冻结（不参与更新检查）、打开仓库页、
  取消绑定（**只移出列表，不删任何文件**）
- **绑定库里已装的插件与主题** —— 扫描插件目录与主题目录，按 manifest id / 主题目录名反查官方社区索引，
  一次性纳入跟踪；来源识别不出来的主题可以手填仓库地址
- **Gitee 镜像发现**（默认关闭，且**必须由你确认才会采用**）—— 探测 Gitee 上的镜像，
  用两边 manifest 的 `id` 二次校验（同名不同项目会装错，宁可不用）。候选仓库有两个：
  **同名仓库**，以及**你 Gitee 账号下的同名仓库**（镜像常挂在作者自己的 Gitee 账号下、
  名字与 GitHub 不同；这一条需要先填 Gitee 令牌）。命中只算**提议**：列表里把两个地址
  列出来，点确认、看过那段警示（判据只有 `id` 相同，证明不了是同一份代码）之后才改用镜像，
  之后每次下载完成的提示也会报来源。**两个地址都可以直接点开**去浏览器里核对
  （确认页让你做的事就是「打开镜像仓库看作者/主页/README」）。**探测不到时可以手填地址**：在「版本管理」弹窗里
  输入镜像仓库（例如 `sofqi/Trefoil`），同样按 `id` 校验 —— 探测只猜那两个候选，
  镜像挂在第三个账号下时永远猜不到（实测 Trefoil：GitHub 是 `Dyse-Sofqi`、镜像是 `sofqi`）
- **长耗时动作看得见** —— 点下的那个图标按钮会变成转圈，同时一条带圆环的提示写明
  **在取哪个文件**（「Trefoil：正在获取 main.js…」）。国内网络下第一次访问 GitHub 的
  release 资产常常要等十几秒，没有这个反馈就分不清是在下载还是卡住了
- **OBSync 自身更新** —— 设置页「OBSync 自身」一节：检查更新、更新（写新版本文件，重启 Obsidian 生效）

#### 🔐 平台与体验

- **双平台适配层** —— GitHub 与 Gitee 的差异（鉴权方式、release 排序、raw 通道、限流特性）只实现一次
- **访问令牌存进系统密钥库** —— 不写进 `data.json`、不随库同步到其他设备；
  错误提示与调试日志里的令牌一律脱敏
- **中文优先、英文对等** —— 所有界面文案与错误信息都走 i18n；错误只携带「类型码 + 参数」，
  人话集中在 locale 里，所以英文界面不会冒出中文
- **移动端可加载** —— 插件安装与主题绑定是纯网络操作，移动端可用；同步模块在移动端不加载

### 用法

#### 安装社区插件

1. 命令面板 → **OBSync：添加插件仓库**（或点设置页的「添加插件仓库」）
2. 填 `owner/repo` 简写，或直接粘贴完整链接（GitHub / Gitee 都行）
3. 点「识别」→ 选版本 → 安装

也可以点「**浏览社区插件**」从官方市场检索 —— 注意这是 Obsidian 官方维护的索引，
**只有 GitHub 源**，Gitee 上没有等价物，所以 Gitee 的插件需要手输地址。

库里已经装好的插件不用一个个手输：命令 **OBSync：绑定库里已安装的插件与主题**
（或设置页的「绑定已有插件」）会扫描插件与主题目录，按 manifest id 反查来源仓库，一次性纳入跟踪。

装完之后想换版本（比如新版有问题要退回旧版）：在设置页「已跟踪插件与主题」里点那一行右侧的
**版本管理**按钮，选一个版本即可 —— 旧版本就是回退，选「最新版本」则恢复跟随最新。

> 所有命令在命令面板里都以 `OBSync：` 开头，直接搜插件名就能找到。

#### 同步笔记仓库

先在设置页的「仓库同步」里填远端地址（命令 **OBSync：编辑远端地址**），然后：

- 还不是 git 仓库的话，先执行 **OBSync：初始化仓库**（源码控制视图里也有这个按钮）
- **OBSync：立即同步** —— 提交 → 拉取 → 推送，一条链走完
- 也可以在源码控制视图里逐个文件操作（暂存 / 取消暂存、点开文件、看历史），
  或点侧边栏的状态栏条目把它打开
- 想在浏览器里看某个文件：命令 **OBSync：在浏览器中打开当前文件**，或右键文件选「**在远端打开**」

自动同步默认关闭。需要的话在设置页设「自动提交并同步 / 自动推送 / 自动拉取」的间隔（分钟）。

**遇到冲突**：OBSync 不替你决定保留哪一边 —— 它写一份冲突指南并停下，等你处理。

### 设置页

| 标签 | 内容 |
| --- | --- |
| 已跟踪插件与主题 | 已安装/添加的插件与主题列表，含更新徽标、检查、更新、版本管理（回退）、冻结、打开仓库、取消绑定（不删文件） |
| 插件安装器 | 启用开关、更新检查时机、Gitee 镜像发现、**访问令牌**（GitHub / Gitee）、OBSync 自身更新 |
| 仓库同步 | 同步开关、自动提交/推送/拉取间隔、提交信息模板、整合策略、git 路径、**连接测试** |
| 通用 | 界面语言、提示开关、调试日志 |

**令牌只保存在本机**（Obsidian 的密钥存储，老版本回退到 localStorage），
不会写进 `data.json`，也不会随库同步到其他设备。

### 安装

插件尚未上架官方市场。手动安装：

1. 下载 `main.js`、`manifest.json`、`styles.css`
2. 放进 `<你的库>/.obsidian/plugins/obsync/`
3. 在 Obsidian 的「第三方插件」里启用 OBSync

两个发布地址（内容一致，选连得上的那个）：

- GitHub：[Dyse-Sofqi/OBSync/releases](https://github.com/Dyse-Sofqi/OBSync/releases)
- Gitee 镜像：[sofqi/OBSync/releases](https://gitee.com/sofqi/OBSync/releases)（国内直连更快）

**平台要求**：笔记同步依赖系统 git，**仅桌面端可用**；插件安装是纯网络操作，移动端也能用。

### 为什么又做一个

**笔记同步**：`obsidian-git` 很成熟，但它只认 GitHub 与 GitLab。
**插件安装**：`obsidian42-brat` 同样只认 GitHub，而且要求插件必须发过 release。

OBSync 针对这两点做了扩展：

| | obsidian-git / BRAT | OBSync |
| --- | --- | --- |
| 平台 | GitHub / GitLab | **GitHub + Gitee** |
| 界面语言 | 英文 | **中文优先**，英文对等 |
| 插件来源 | 必须有 release | release 资产 **或** 仓库源码文件 |
| 安装失败 | 不备份不还原 | **写入前备份，失败整体回滚** |
| 更新 | 启动时自动安装 | **只检查并提示，安装永远手动** |

### 关于 Gitee 的几点说明

**强烈建议在设置页填 Gitee 访问令牌。** Gitee 的匿名 API 配额实测极低 ——
连续十几次请求就会返回 `403 Rate Limit Exceeded`，且一分钟内不恢复。
没有令牌时，OBSync 会降级到「直接读仓库源码文件」来安装插件，仍然能用，
但查不到版本列表、也无法判断更新。

几个已经处理掉的平台差异（如果你自己改代码，这些别改回去）：

- Gitee 的 releases 列表**默认升序**（GitHub 默认降序），必须显式传 `direction=desc`，
  否则会静默装上一个很旧的版本
- Gitee 的 API raw 端点**对匿名请求一律 401**（即使公开仓库），
  所以匿名读文件走的是网页 raw 通道
- Gitee 的令牌走 `access_token` **查询参数**，GitHub 走 `Authorization` 请求头
- Gitee 的 git Basic 认证只接受 账号名 / `oauth2` / `gitee.com` 三种用户名，
  填 `git`（GitHub 的习惯写法）会被服务端直接拒绝
- 大多数 Gitee 插件仓库**没有发布 release**，所以源码文件通道是必需的
- Gitee 的 release 资产对象**没有 `id`**（只有 `name` 与 `browser_download_url`），
  所以私有仓库的 API 附件端点只在真的拿到 id 时才用；否则回落到公开下载地址（带同一个令牌）

### 开发

```bash
pnpm install
pnpm dev         # esbuild watch，构建后自动部署到测试库
pnpm build       # 自查 + 类型检查 + 生产构建 + 部署
pnpm build:both  # 同上，但**部署到两个库**（测试库 + 真实库）
pnpm check       # 项目自查（只读，约 0.2 秒）
pnpm typecheck
pnpm test        # 单元测试（不碰网络）
pnpm test:live   # 真实 API 测试，需要网络
```

- 部署目标默认是 `F:/_Workspace/Plugin-Test/.obsidian/plugins/obsync`。
  环境变量 `OBSYNC_DEPLOY_DIR` 可以覆盖，而且**接受多个目录**（用 `;` 分隔）——
  一次构建同时更新几个库；设为空串则跳过部署。

  ```bash
  # 一次部署到两个库（pnpm build:both 就是这条）
  OBSYNC_DEPLOY_DIR="F:/_Workspace/Plugin-Test/.obsidian/plugins/obsync;D:/_Workspace/learning-records/.obsidian/plugins/obsync" pnpm build
  ```

  只复制 `main.js` / `manifest.json` / `styles.css` 三个文件，**不碰 `data.json`**
  （那是你的设置与跟踪列表）；某个目标写不进去只警告，不中断构建、也不影响另一个目标。
- **`pnpm check` 查六件编译器管不着的事**：manifest 的 `minAppVersion` 是否覆盖了
  代码用到的 Obsidian API、有没有硬编码的中文（会漏给英文用户）、有没有定义了却没
  接上的 i18n 键、CSS 类有没有漏定义、移动端静态导入图是否碰到 Node 依赖、
  有没有「设置项声明了却没有任何代码读它」。
- 改了 git 相关代码后注意：`simpleGitManager.test.ts` 会起真实 git 进程，
  在这台机器上单独跑约 150 秒 —— 它没挂，只是慢。
- `pnpm test:live` 里 Gitee 的 API 用例在没有令牌且被限流时会**跳过**而不是失败。
  想跑绿就设 `OBSYNC_GITEE_TOKEN=<令牌>`。

架构与踩坑记录见 [`docs/HANDOVER.md`](docs/HANDOVER.md)，
两个参考项目的分析见 [`docs/reference-analysis.md`](docs/reference-analysis.md)，
发版流程见 [`docs/RELEASE.md`](docs/RELEASE.md)。

---

## 🇬🇧 English

### Introduction

OBSync bundles two things and refuses to be GitHub-only:

- **Vault sync over git** — commit, pull and push your whole vault to GitHub *or* Gitee in one chain.
  Conflicts are never resolved for you: OBSync stops the chain and writes a resolution guide instead.
- **Community plugins and themes** — install, update, freeze and unbind from either platform,
  and adopt the plugins/themes you already have so they update alongside.
- **OBSync updates itself** — check and apply new versions of the plugin from its own settings page.

Both features share a single platform layer, so **every GitHub/Gitee difference is implemented once**.
Chinese-first UI with an equal English one.

### Features

#### 🔄 Vault sync (desktop only)

Needs the system `git` binary, so it is **desktop-only** (Windows / macOS / Linux).

- **Sync now** — commit → pull → push in one chain; commit, pull and push are also available separately
- **Initialize repository** — also creates a `.gitignore` (excluding per-device files such as
  `.obsidian/workspace.json`, which only ever produce conflicts). An existing `.gitignore` is
  **never overwritten**, and there is an "Edit .gitignore" command
- **Conflicts** — on conflict OBSync writes a resolution guide listing the conflicted files and
  **stops the chain** (continuing would commit conflict markers or push them upstream).
  Resolve by hand and sync again, or use "Abort current merge"
- **Auto sync** (off by default) — separate intervals for auto commit / push / pull in minutes (0 = off).
  Timing is based on the **last run** and persists per vault, so restarting Obsidian does not reset
  the cycle and multiple vaults do not interfere
- **Source-control view** — branch, ahead/behind, changed and conflicted files, with per-file stage/unstage
- **Status-bar item** — branch / `↑ahead ↓behind` / `~dirty` / `⚠conflicts` plus the action in progress;
  pinned to the **far left** of the status bar on purpose
- **Open on the remote** — current file and its history, also in the file context menu,
  with per-platform URLs (Gitee included)
- **Connection test** — a step-by-step chain: git binary → git repo → remote configured →
  platform recognised → **an actual `ls-remote`**. It states that it only proves read access
- **Edit remote** — warns when the URL embeds credentials, and redacts them in messages

#### 🧩 Community plugins and themes

- **Install from an address** — `owner/repo` shorthand or a full GitHub / Gitee URL;
  the resolved platform is shown, and a detected mirror is called out
- **Two download channels** — release assets first, falling back to **repository source files**;
  most Gitee plugin repos publish no releases, so this fallback is required, not optional
- **Version picker** — latest by default, or a specific release; repositories that only publish
  prereleases fall back to those
- **Version rollback** — every tracked plugin can be switched to another published release from the
  tracked list (the installed one is marked), so rolling back after a bad update is two clicks.
  Picking "Latest release" follows the newest again, and the choice is remembered (it is selected by
  default next time). **To repair a broken install**, open it and click switch — that is exactly what
  the old "reinstall" button did (the recorded version is preselected), so it was folded in here.
  Themes are never pinned, so they have no such button
- **Backup before write, rollback on failure** — a failed install never leaves half a plugin behind
- **Update checks** — single item, all items, after startup, and when opening settings (toggleable);
  rows with updates keep a persistent badge. **OBSync only reports; installing is always manual**
- **Per-item actions** — check, update, **version manager (roll back to an older release)**,
  freeze (excluded from update checks),
  open repo page, unbind (**removes the entry only, deletes no files**)
- **Adopt installed plugins and themes** — scans the plugin and theme folders and resolves their source
  repositories through the official community index; themes that cannot be resolved can be bound by URL
- **Gitee mirror discovery** (off by default, and **never adopted without your confirmation**) — probes for
  a Gitee mirror when installing from GitHub and verifies it by comparing manifest `id`s. Two candidates are
  probed: a **same-named repository**, and a **same-named repository under your own Gitee account** (mirrors
  often live on the author's Gitee account under a different name — this one needs a Gitee token). A hit is
  only a **proposal**: the tracked list lists both addresses, and the switch happens after you confirm it and
  read the warning (the `id` match proves the same plugin, not the same code). Downloads then report their source.
  **No mirror found? Type the address yourself** in the version dialog (e.g. `sofqi/Trefoil`) — it is verified
  the same way. Discovery only guesses those two candidates, so a mirror under some third account is invisible
  to it (as measured with Trefoil: GitHub `Dyse-Sofqi`, mirror `sofqi`)
- **Long operations are visible** — the icon button you clicked turns into a spinner, and a notice with a
  spinner states **which file is being fetched** ("Trefoil: fetching main.js…"). The first request to GitHub's
  release asset CDN often takes 10+ seconds from mainland China; without this you cannot tell download from stall
- **Self-update** — check and apply new versions of OBSync itself (restart required)

#### 🔐 Platform and UX

- **One platform layer** — every GitHub/Gitee difference (auth style, release ordering, raw channel,
  rate limits) is implemented once
- **Tokens live in the OS keychain** — never written to `data.json`, never synced with the vault,
  and redacted from error messages and debug logs
- **Chinese-first, English equal** — all UI text and errors go through i18n; errors carry type codes
  and parameters so no Chinese leaks into the English UI
- **Loads on mobile** — plugin installation and theme binding are pure network operations;
  the sync module is not loaded there

### Settings

| Tab | Contents |
| --- | --- |
| Tracked plugins & themes | The list, with update badges, check, update, version manager (rollback), freeze, open repo, unbind |
| Plugin installer | Enable switch, update-check timing, Gitee mirror discovery, **access tokens**, self-update |
| Vault sync | Enable switch, auto commit/push/pull intervals, commit message template, strategy, git path, connection test |
| General | UI language, notices, debug logging |

Tokens are stored **locally only** (Obsidian's secret storage, falling back to localStorage for older
versions), never in `data.json`, and never synced to other devices.

### Installation

Not in the community plugin list yet. Manual install:

1. Download `main.js`, `manifest.json` and `styles.css`
2. Put them in `<your vault>/.obsidian/plugins/obsync/`
3. Enable OBSync under Community plugins

Two release locations (same artifacts — use whichever is reachable):

- GitHub: [Dyse-Sofqi/OBSync/releases](https://github.com/Dyse-Sofqi/OBSync/releases)
- Gitee mirror: [sofqi/OBSync/releases](https://gitee.com/sofqi/OBSync/releases)

Vault sync needs the system `git` binary and is **desktop-only**; plugin installation works on mobile.

### Development

```bash
pnpm install
pnpm dev         # esbuild watch, deploys to the test vault after each build
pnpm build       # self-check + typecheck + production build + deploy
pnpm build:both  # same, but deploys to both vaults (test + real)
pnpm check       # read-only project self-check (~0.2 s)
pnpm typecheck
pnpm test        # unit tests (no network)
pnpm test:live   # live API tests (needs network)
```

The default deploy target is `F:/_Workspace/Plugin-Test/.obsidian/plugins/obsync`. The
`OBSYNC_DEPLOY_DIR` environment variable overrides it and accepts **several** directories
separated by `;`, so one build can update multiple vaults; set it to an empty string to
skip deploying. Only `main.js`, `manifest.json` and `styles.css` are copied — never
`data.json` (your settings and tracked list). A target that cannot be written is warned
about without failing the build or the other targets.

Architecture notes and a long list of field-tested pitfalls live in
[`docs/HANDOVER.md`](docs/HANDOVER.md); the release checklist is in [`docs/RELEASE.md`](docs/RELEASE.md).

---

## 赞助 / Sponsor

如果这个插件对你有帮助，欢迎扫码赞助 ❤️

![赞助](zanshang.jpg)

也可通过 [PayPal](https://paypal.me/Sofqi) 赞助。

You can also sponsor via [PayPal](https://paypal.me/Sofqi).

## License

[MIT](LICENSE)
