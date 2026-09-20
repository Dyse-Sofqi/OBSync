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
  仓库同步视图（侧边栏，可点状态栏打开）· 状态栏条目 · 初始化仓库时建 `.gitignore` ·
  在远端打开文件/历史/提交 · 编辑远端 · 连接测试
- **插件与主题** — 地址识别（GitHub / Gitee）· release 资产与仓库源码双通道 · 版本选择（含预发布回退）·
  写入前备份 + 失败回滚 · 更新检查（单个/全部/启动/进入设置页）· 常驻更新徽标 · 冻结 ·
  **版本回退** · 取消绑定（不删文件）· 绑定已装插件与主题 · Gitee 镜像发现 · 自我更新
- **平台与体验** — 双平台适配层 · 令牌进系统密钥库并从日志脱敏 · 中文优先英文对等 ·
  错误文案走类型码 + locale · 移动端可加载（同步仅桌面）

**English**

- **Vault sync** — commit → pull → push in one chain · conflict guide (no auto-resolution) ·
  auto commit/push/pull timers · repository sync view (sidebar, openable from the status bar) ·
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

- **立即同步** —— 提交 → 拉取 → 推送，一条链走完。仓库同步视图的**顶部工具条一行**：
  `提交` / `拉取` / `推送`、分支下拉、**靠右的** `立即同步`、**最右的** `刷新`。
  **「提交」只写本地仓库，「推送」只发送已提交的内容** —— 它不会顺手提交，
  带着未提交的改动点它，改动一个字节都不会上去（这时它会明确告诉你还有几个更改没提交）。
  「自动提交并同步」定时器走的也是「立即同步」那条完整链路
- **提交信息不用你填** —— 由设置里的**提交信息模板**自动生成（默认 `vault backup: {{date}}`，
  支持 `{{date}}` / `{{hostname}}` / `{{numFiles}}` / `{{files}}`）。全程没有输入框，
  点「提交」/「立即同步」都不会弹窗问你要备注
- **仓库大小与待提交改动** —— 仓库同步视图里**并排两栏**：**仓库大小**（`.git` 对象库占用 +
  对象数，`git count-objects`，只读本地）与**待提交改动**（有改动的文件大小之和）。
  两者回答的是两个问题：「这个库有多大 / 推送要传多少」和「这次要传上去多少」。
  读不到就写「读不到」，**不会编一个 0 B**（那会被当成空仓库）
- **「与远端一致」是看得见的** —— 提交/同步结束且本地与远端完全一致（没有未提交改动、
  不领先也不落后、无冲突）时，会有一条**醒目的提示**（✓ + 停留更久，并带上仓库大小）；
  同时状态栏出现 `✓`，面板里那一行转成绿色。三处用的是**同一个判据**。
  关掉「显示操作结果提示」的人看不到提示，但状态栏与面板仍然显示这个状态
- **为什么「立即同步」里要有拉取** —— 因为 git 的 `push` 只能**快进**：远端存在你没有的提交时，
  推送会被**直接拒绝**（接受它就等于丢掉那些提交）。而这个插件的用途就是多设备同步，
  所以「提交 → 推送」在两台设备上会**稳定失败**，不是偶发失败。拉取排在提交**之后**，
  是因为提交先把你的改动收进一个可恢复的提交里，之后整合远端出问题还能「放弃本次合并」
  回到拉取之前；先拉取的话，工作区的未提交改动会和冲突标记混在一起，谁也分不清。
  拉取也是你唯一能**收到**别的设备改动的方式 —— 只推不拉是单向的。
  整合方式见设置页的「拉取整合策略」（默认合并；**「重置」会丢弃本地提交，所以选它时
  自动同步会被暂停** —— 否则每一轮都会静默丢掉刚提交的东西）。
  如果你确实不想让拉取动工作区，就分两步走：`提交` → `推送`
- **初始化仓库** —— 顺便建一份 `.gitignore`（默认排除 `.obsidian/workspace.json`、
  `.obsidian/plugins/ob-sync/data.json` 这类**每台设备各自维护**的文件，同步它们只会
  制造冲突）。**已存在的 `.gitignore` 绝不覆盖**，
  另有「编辑 .gitignore」命令可以随时改它
- **冲突处理** —— 检测到冲突时在库根目录写一份《OBSync 冲突指南.md》列出冲突文件，
  然后**立即停止同步链**；手动解决后重新同步，或用「放弃当前合并」回到拉取之前
- **自动同步**（默认关闭）—— 自动提交 / 自动推送 / 自动拉取三个间隔（分钟，0 = 关闭）。
  计时基于**上次执行时间**，重启 Obsidian 不重置周期；存储按库隔离，多个库互不干扰。
  设置页「仓库同步」标题下有两段**注意事项**（选「重置」时自动同步会被暂停、
  多设备同时编辑同一个文件的风险），配之前值得先看一眼
- **仓库同步视图**（侧边栏）—— 打开方式：侧栏的 **git 图标**、点一下**状态栏条目**，
  或命令 **OBSync：打开仓库同步面板**。顶部是**一行**工具条（提交 / 拉取 / 推送 /
  分支下拉 / **靠右的**立即同步 / **最右的**刷新），下面是：远端地址（脱敏后回显）+ 编辑入口、
  `领先 / 落后远端`、**并排两栏**的仓库大小与待提交改动、冲突区（列出冲突文件 + 放弃合并）、
  **按「已暂存 / 更改」分组的文件列表**
  （逐个文件暂存 / 取消暂存、点文件名打开笔记、在远端打开此文件）、最近 10 条提交
  （点 hash 在远端查看这条提交）。不是 git 仓库时这里直接给「初始化仓库」按钮。
  面板是**活的**：自动提交、库外改动、命令面板里的动作都会让它自己刷新
- **状态栏条目** —— 分支 / `↑ahead ↓behind` / `~脏文件数` / `⚠冲突数`，以及进行中的动作；
  贴在状态栏**最左侧**（这是刻意的：它回答「现在同步到哪了」，不该藏在右下角），
  并且**可以点开**（打开仓库同步视图）。贴最左需要把状态栏拉成全屏宽，而**那会改变
  状态栏的整体观感**，所以设置页「通用」里给了开关（**状态栏占满整屏宽**，默认开）：
  关掉后状态栏恢复 Obsidian 原样（右下角一簇），同步条目仍在那一簇的最前面
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
- **OBSync 自身更新** —— 设置页「OBSync 自身」一节：检查更新、更新（写新版本文件，重启 Obsidian 生效）。
  **可以指定更新来源**：留空走官方仓库；国内访问 GitHub 慢或被阻断时，填 Gitee 镜像的地址
  （例如 `https://gitee.com/sofqi/OBSync`），填一次就一直用它，不再自动探测

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

- 还不是 git 仓库的话，先执行 **OBSync：初始化仓库**（仓库同步视图里也有这个按钮）
- **OBSync：立即同步** —— 提交 → 拉取 → 推送，一条链走完（仓库同步视图的顶部工具条里也有）
- 「提交」「推送」是**两个动作**，不是一个：提交只写本地仓库，推送只发送**已提交**的
  内容。想一步到位就用「立即同步」
- 提交信息不用填：它在设置里配模板，每次自动生成
- 也可以在仓库同步视图里逐个文件操作（暂存 / 取消暂存、点开文件、看历史），
  或点侧边栏的状态栏条目把它打开
- 想在浏览器里看某个文件：命令 **OBSync：在浏览器中打开当前文件**，或右键文件选「**在远端打开**」

自动同步默认关闭。需要的话在设置页设「自动提交并同步 / 自动推送 / 自动拉取」的间隔（分钟）。

**遇到冲突**：OBSync 不替你决定保留哪一边 —— 它写一份冲突指南并停下，等你处理。

### 设置页

| 标签 | 内容 |
| --- | --- |
| 已跟踪插件与主题 | 已安装/添加的插件与主题列表，含更新徽标、检查、更新、版本管理（回退）、冻结、打开仓库、取消绑定（不删文件） |
| 插件安装器 | 启用开关、更新检查时机、Gitee 镜像发现、**访问令牌**（GitHub / Gitee）、OBSync 自身更新（含**更新来源**） |
| 仓库同步 | 同步开关、自动提交/推送/拉取间隔、提交信息模板、整合策略、git 路径、**连接测试** |
| 通用 | 界面语言、提示开关、调试日志、**状态栏占满整屏宽** |

**令牌只保存在本机**（Obsidian 的密钥存储，老版本回退到 localStorage），
不会写进 `data.json`，也不会随库同步到其他设备。

### 安装

插件尚未上架官方市场。手动安装：

1. 下载 `main.js`、`manifest.json`、`styles.css`
2. 放进 `<你的库>/.obsidian/plugins/ob-sync/`
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
pnpm verify:head # 在 **HEAD** 上跑测试（提交后跑一次，见下）
```

- 部署目标默认是 `F:/_Workspace/Plugin-Test/.obsidian/plugins/ob-sync`。
  环境变量 `OBSYNC_DEPLOY_DIR` 可以覆盖，而且**接受多个目录**（用 `;` 分隔）——
  一次构建同时更新几个库；设为空串则跳过部署。

  ```bash
  # 一次部署到两个库（pnpm build:both 就是这条）
  OBSYNC_DEPLOY_DIR="F:/_Workspace/Plugin-Test/.obsidian/plugins/ob-sync;D:/_Workspace/learning-records/.obsidian/plugins/ob-sync" pnpm build
  ```

  只复制 `main.js` / `manifest.json` / `styles.css` 三个文件，**不碰 `data.json`**
  （那是你的设置与跟踪列表）；某个目标写不进去只警告，不中断构建、也不影响另一个目标。
- **`pnpm check` 查六件编译器管不着的事**：manifest 的 `minAppVersion` 是否覆盖了
  代码用到的 Obsidian API、有没有硬编码的中文（会漏给英文用户）、有没有定义了却没
  接上的 i18n 键、CSS 类有没有漏定义、移动端静态导入图是否碰到 Node 依赖、
  有没有「设置项声明了却没有任何代码读它」。
- 改了 git 相关代码后注意：`simpleGitManager.test.ts` 会起真实 git 进程，
  在这台机器上单独跑约 150 秒 —— 它没挂，只是慢。
- **提交后跑一次 `pnpm verify:head`**：`pnpm test` 读的是**工作区**，而工作区里还压着
  未提交改动时，「本地全绿」说明不了 HEAD 是绿的 —— 可 HEAD 才是别人克隆时看到的东西。
  这条命令把工作区 stash 起来、在 HEAD 上跑测试、再原样还给你。
  （实测踩过：一次提交漏了 `src/settingsTab.ts`，HEAD 上三条用例红了，本地却一直是绿的。）
- **它已经挂在 `pre-push` 上**（`.githooks/pre-push`，`pnpm hooks:install` 启用）：
  push 前自动跑一遍，HEAD 红了就拦住 —— 所以「忘了跑」这种情况也被覆盖了。
  选 push 而不是 commit，是因为 **push 才是「别人能看到」的时刻**，也正是这个错真正
  有害的时刻；而 push 频率远低于 commit，3 分钟等得起。要跳过一次：`git push --no-verify`。
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

- **Sync now** — commit → pull → push in one chain. The repository sync view's **toolbar is a single
  row**: `Commit` / `Pull` / `Push`, the branch dropdown, **`Sync now` pushed to the right**, and
  **`Refresh` at the far right**. **"Commit" writes to the local repository only, and "Push" sends
  committed content only** — it never commits for you, so with uncommitted changes nothing of yours
  goes up (and it says so, including how many changes are still uncommitted). The "auto commit and
  sync" timer runs that same full chain
- **You never have to type a commit message** — it is generated from the **commit message template**
  in the settings (default `vault backup: {{date}}`, supporting `{{date}}`, `{{hostname}}`,
  `{{numFiles}}` and `{{files}}`). No dialog ever asks you for a message
- **Repository size and pending changes** — shown **side by side in two columns**: **repository
  size** (the `.git` object store plus object count, via `git count-objects`, local-only) and
  **pending changes** (the summed size of changed files). They answer different questions: "how big
  is this vault / how much will a push transfer" and "how much goes up this time". When it cannot be
  read it says so and **never invents a 0 B** (that would look like an empty repository)
- **"In sync" is visible** — when a commit/sync finishes with the local branch fully matching the
  remote (nothing uncommitted, neither ahead nor behind, no conflicts) you get a **prominent notice**
  (✓, longer dwell, repository size included), the status bar shows `✓`, and that line in the panel
  turns green. All three use the **same predicate**. With "show operation notices" turned off you
  lose the notice, but the status bar and panel still show the state
- **Why "Sync now" pulls** — because `git push` only fast-forwards: when the remote has commits you
  do not have, the push is **rejected outright** (accepting it would drop them). This plugin exists
  to sync a vault across devices, so "commit → push" **fails reliably** with two machines, not
  occasionally. The pull comes **after** the commit because committing first puts your changes into
  a recoverable commit, so if integrating the remote goes wrong you can still "Abort current merge"
  and be back where you started — pulling first would leave your uncommitted edits mixed with
  conflict markers. Pulling is also the only way you ever **receive** another device's changes.
  Integration is configurable ("Pull integration strategy"; the default is merge, and **picking
  "reset" suspends automatic sync** — every automatic run would otherwise discard what was just
  committed). If you really do not want the pull to touch your working tree, do it in two steps:
  `Commit` → `Push`
- **Initialize repository** — also creates a `.gitignore` (excluding per-device files such as
  `.obsidian/workspace.json` and `.obsidian/plugins/ob-sync/data.json`, which only ever produce
  conflicts). An existing `.gitignore` is **never overwritten**, and there is an "Edit .gitignore"
  command
- **Conflicts** — on conflict OBSync writes a resolution guide listing the conflicted files and
  **stops the chain** (continuing would commit conflict markers or push them upstream).
  Resolve by hand and sync again, or use "Abort current merge"
- **Auto sync** (off by default) — separate intervals for auto commit / push / pull in minutes (0 = off).
  Timing is based on the **last run** and persists per vault, so restarting Obsidian does not reset
  the cycle and multiple vaults do not interfere. The settings page carries **two notes** under the
  "Vault sync" heading (reset suspends automatic sync; the risk of editing the same file on several
  devices) — worth reading before you configure it
- **Repository sync view** (sidebar) — open it from the **git ribbon icon**, by **clicking the
  status-bar item**, or via the command **OBSync: Open repository sync panel**. Its **single-row
  toolbar** holds `Commit` / `Pull` / `Push`, the branch dropdown, **`Sync now` pushed right** and
  **`Refresh` at the far right**; below that are the remote URL (redacted) with an edit entry,
  `ahead / behind`, repository size and pending changes **side by side**, a conflict section
  (conflicted files + abort merge), the changed files **grouped into staged / changes**
  (per-file stage / unstage, click a file name to open the note, open the file on the remote) and
  the last 10 commits (click a hash to view that commit on the remote). When the vault is not a git
  repository it offers an "Initialise repository" button. The panel is **live**: auto commits,
  outside edits and command-palette actions refresh it
- **Status-bar item** — branch / `↑ahead ↓behind` / `~dirty` / `⚠conflicts` plus the action in progress;
  pinned to the **far left** of the status bar on purpose, and **clickable** (opens the repository
  sync view).
  Pinning it there requires stretching the status bar to the full window width, and **that changes how
  the status bar looks**, so the General tab has a switch for it (**"Status bar spans the full width"**,
  on by default): turning it off restores Obsidian's own layout (a bottom-right cluster) with the sync
  item still first in that cluster
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
- **Self-update** — check and apply new versions of OBSync itself (restart required). The
  **source is configurable**: leave it empty for the official repository, or enter a mirror
  (e.g. `https://gitee.com/sofqi/OBSync`) when GitHub is slow or blocked — it is then used
  every time, with no automatic probing

#### 🔐 Platform and UX

- **One platform layer** — every GitHub/Gitee difference (auth style, release ordering, raw channel,
  rate limits) is implemented once
- **Tokens live in the OS keychain** — never written to `data.json`, never synced with the vault,
  and redacted from error messages and debug logs
- **Chinese-first, English equal** — all UI text and errors go through i18n; errors carry type codes
  and parameters so no Chinese leaks into the English UI
- **Loads on mobile** — plugin installation and theme binding are pure network operations;
  the sync module is not loaded there

### Usage

#### Installing community plugins

1. Command palette → **OBSync: Add plugin repository** (or the button in the settings page)
2. Enter an `owner/repo` shorthand or paste a full URL (GitHub or Gitee)
3. Click "Resolve" → pick a version → install

You can also click **Browse community plugins** to search the official directory — note that it is
Obsidian's own index and **covers GitHub only** (there is no Gitee equivalent), so Gitee plugins
have to be entered by address.

Already-installed plugins do not have to be typed in one by one: the command
**OBSync: Bind plugins and themes already installed in this vault** (or "Bind existing" in the
settings) scans the plugin and theme folders, resolves their source repositories from the manifest
`id`, and tracks them all at once.

To switch a version later (for example rolling back after a bad update), click **Version manager**
on that row under "Tracked plugins and themes" and pick a release — an older one is a rollback,
while "Latest release" resumes following the newest.

> Every command starts with `OBSync:` in the palette, so searching the plugin name finds them all.

#### Syncing the vault

First set the remote in the settings page under "Vault sync" (command
**OBSync: Edit remote address**), then:

- If the vault is not a git repository yet, run **OBSync: Initialize repository** first (the
  repository sync view has the same button)
- **OBSync: Sync now** — commit → pull → push in one chain (the view's toolbar has it too)
- "Commit" and "Push" are **two separate actions**: commit writes to the local repository only,
  push sends **committed** content only. Use "Sync now" to do both
- No commit message to type: it comes from the template in the settings
- You can also work per file in the repository sync view (stage / unstage, open a file, view
  history), or click the status-bar item to open it
- To view a file in the browser: command **OBSync: Open current file in browser**, or right-click
  the file and pick **Open on the remote**

Automatic sync is off by default. Turn it on by setting the "auto commit-and-sync / auto push /
auto pull" intervals (minutes) in the settings.

**On conflict**, OBSync does not decide which side wins — it writes a resolution guide and stops,
waiting for you.

### Settings

| Tab | Contents |
| --- | --- |
| Tracked plugins & themes | The list, with update badges, check, update, version manager (rollback), freeze, open repo, unbind |
| Plugin installer | Enable switch, update-check timing, Gitee mirror discovery, **access tokens**, self-update |
| Vault sync | Enable switch, auto commit/push/pull intervals, commit message template, strategy, git path, connection test |
| General | UI language, notices, debug logging, **status bar spans the full width** |

Tokens are stored **locally only** (Obsidian's secret storage, falling back to localStorage for older
versions), never in `data.json`, and never synced to other devices.

### Installation

Not in the community plugin list yet. Manual install:

1. Download `main.js`, `manifest.json` and `styles.css`
2. Put them in `<your vault>/.obsidian/plugins/ob-sync/`
3. Enable OBSync under Community plugins

Two release locations (same artifacts — use whichever is reachable):

- GitHub: [Dyse-Sofqi/OBSync/releases](https://github.com/Dyse-Sofqi/OBSync/releases)
- Gitee mirror: [sofqi/OBSync/releases](https://gitee.com/sofqi/OBSync/releases)

Vault sync needs the system `git` binary and is **desktop-only**; plugin installation works on mobile.

### Why another one

**Vault sync**: `obsidian-git` is mature, but it only knows GitHub and GitLab.
**Plugin install**: `obsidian42-brat` is also GitHub-only, and requires the plugin to have published
a release.

OBSync extends both:

| | obsidian-git / BRAT | OBSync |
| --- | --- | --- |
| Platforms | GitHub / GitLab | **GitHub + Gitee** |
| UI language | English | **Chinese-first**, English equal |
| Plugin source | Requires a release | Release assets **or** repository source files |
| Failed install | No backup, no rollback | **Backup before write, rollback on failure** |
| Updates | Auto-installed at startup | **Reports only; installing is always manual** |

### Notes on Gitee

**Setting a Gitee access token is strongly recommended.** Gitee's anonymous API quota is measured to
be very low — a dozen or so consecutive requests return `403 Rate Limit Exceeded`, and it does not
recover within a minute. Without a token OBSync degrades to reading repository source files
directly, which still works, but it cannot list versions or detect updates.

A few platform differences that are already handled (do not undo them if you touch the code):

- Gitee's release list is **ascending by default** (GitHub is descending); `direction=desc` must be
  passed explicitly, otherwise a very old version is installed silently
- Gitee's API raw endpoint returns **401 for anonymous requests** even on public repositories, so
  anonymous file reads go through the web raw channel
- Gitee takes its token as an `access_token` **query parameter**; GitHub uses an `Authorization` header
- Gitee's git Basic auth only accepts the account name / `oauth2` / `gitee.com` as the username;
  `git` (the GitHub habit) is rejected outright by the server
- Most Gitee plugin repositories **publish no releases**, so the source-file channel is required
- Gitee's release asset objects carry **no `id`** (only `name` and `browser_download_url`), so the
  private-repo API attachment endpoint is only used when an id is really present; otherwise it falls
  back to the public download URL (with the same token)

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
pnpm verify:head # runs the tests on **HEAD**, not the working tree (see below)
```

The default deploy target is `F:/_Workspace/Plugin-Test/.obsidian/plugins/ob-sync`. The
`OBSYNC_DEPLOY_DIR` environment variable overrides it and accepts **several** directories
separated by `;`, so one build can update multiple vaults; set it to an empty string to
skip deploying. Only `main.js`, `manifest.json` and `styles.css` are copied — never
`data.json` (your settings and tracked list). A target that cannot be written is warned
about without failing the build or the other targets.

**Run `pnpm verify:head` after each commit.** `pnpm test` reads the *working tree*, so
while uncommitted changes are lying around, "green locally" says nothing about HEAD —
and HEAD is what everyone else clones. The command stashes the working tree (untracked
files included), runs the suite on HEAD, then restores everything. It exists because of a
real one: a commit shipped the tests and i18n keys but forgot `src/settingsTab.ts`, leaving
three committed tests red on HEAD while everything stayed green locally.

**It is also wired to `pre-push`** (`.githooks/pre-push`, enabled by `pnpm hooks:install`),
so it runs before every push and blocks a red HEAD — which means "I forgot to run it" is
covered too. Push rather than commit, because pushing is the moment others can see it and
therefore when a red HEAD starts to hurt; and pushes are rare enough that the ~3 minutes
are affordable. Skip it once with `git push --no-verify`.

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
