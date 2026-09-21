# SyncHub 复刻规划

> 目标：独立复刻 obsidian-git 的笔记仓库同步能力 + obsidian42-brat 的社区插件安装能力，
> 合并为单一 Obsidian 插件，并把两者从「仅 GitHub + 英文」扩展为「GitHub / Gitee 双平台 + 中文优先」。

已确认的四项决策：

| 决策项 | 结论 |
| --- | --- |
| 移动端支持 | **不支持**。v1 仅桌面，Git 同步只用系统 git（`simple-git`） |
| 交付节奏 | **分阶段，逐段验收** |
| 插件标识 | `synchub` / **SyncHub** |
| Gitee 插件发现 | 手动输入 **+ 加做 GitHub→Gitee 镜像自动发现** |

---

## 一、为什么不照抄，而要独立规划

三个项目直接拼起来会出问题：

1. **两套平台适配会重复。** obsidian-git 的 `formatRemoteUrl()` 和 `openInGitHub.ts` 硬编码 `github.com`；BRAT 的 `githubUtils.ts` 也硬编码 GitHub API。如果各改各的，Gitee 适配逻辑要写两遍。
   → 抽出 **`host` 抽象层**，两个功能共用。

2. **BRAT 的安装链路在 Gitee 上跑不通。** 它假设 release 一定存在，而 Gitee 上多数插件仓库没有 release。
   → 增加 **raw 文件回退通道**。

3. **BRAT 没有回滚，obsidian-git 的凭据方案平台耦合重。**
   → 安装器加写入前备份；同步改用 `http.extraheader` 注入鉴权。

4. **两个项目都是英文优先。** BRAT 的 i18n 方案很好（编译期强制全覆盖），但它把中文当二等公民（后补的 locale）。SyncHub 以中文为第一语言，英文作为对等 locale。

---

## 二、模块划分

```
src/
├─ main.ts                       # 插件主类：模块装配、生命周期
├─ core/                         # 基础设施（两个功能共用）
│  ├─ i18n/
│  │  ├─ index.ts                # getT() / resolveLocale()
│  │  └─ locales/{zh-cn,en}.ts   # 类型安全，编译期强制全覆盖
│  ├─ settings.ts                # DEFAULT_SETTINGS + 加载/保存/迁移
│  ├─ secretStore.ts             # token 存储（SecretStorage 优先，localStorage 回退）
│  ├─ logger.ts                  # 分级日志
│  └─ notice.ts                  # 统一通知（受"显示错误提示"设置控制）
├─ host/                         # ★ 双平台抽象层（脊柱）
│  ├─ types.ts                   # RepoRef / Release / ReleaseAsset / HostKind
│  ├─ IRepoHost.ts               # 统一接口
│  ├─ repoRef.ts                 # owner/repo 解析（URL / 简写 / 双平台）
│  ├─ githubHost.ts              # api.github.com
│  ├─ giteeHost.ts               # gitee.com/api/v5
│  ├─ hostRegistry.ts            # 按 host 选择 provider
│  ├─ http.ts                    # requestUrl 封装：重试、限流、超时
│  └─ errors.ts                  # RateLimitError / AuthError / NotFoundError
├─ features/
│  ├─ installer/                 # 功能一：插件安装器（BRAT 复刻）
│  │  ├─ installerService.ts     # 安装 / 更新 / 重装主链路
│  │  ├─ repoRegistry.ts         # 已跟踪仓库 + 冻结版本
│  │  ├─ updateChecker.ts        # 启动检查 + 手动检查
│  │  ├─ mirrorFinder.ts         # GitHub→Gitee 镜像发现
│  │  └─ ui/{AddRepoModal,VersionSuggestModal,InstallerSettingsTab}.ts
│  └─ sync/                      # 功能二：Git 同步（obsidian-git 复刻）
│     ├─ gitManager.ts           # 抽象基类
│     ├─ simpleGitManager.ts     # 桌面实现（simple-git）
│     ├─ syncService.ts          # pull/push/commit 编排 + 冲突处理
│     ├─ automatics.ts           # 自动提交/同步定时器
│     ├─ auth.ts                 # 远端鉴权（extraheader / askpass）
│     ├─ remoteProvider.ts       # 远端 URL 规范化 + "在浏览器打开"
│     ├─ statusBar.ts            # 状态栏
│     └─ ui/{SourceControlView,modals}.ts
└─ commands/index.ts             # 统一命令注册
```

### 2.1 `host` 抽象层接口设计

```ts
export interface IRepoHost {
  readonly kind: HostKind;              // "github" | "gitee"
  readonly displayName: string;
  readonly webBaseUrl: string;          // https://github.com | https://gitee.com

  // 仓库
  getRepoMeta(ref: RepoRef): Promise<RepoMeta>;
  // release
  listReleases(ref: RepoRef, opts?: { limit?: number }): Promise<Release[]>;
  getReleaseByTag(ref: RepoRef, tag: string): Promise<Release | undefined>;
  getLatestRelease(ref: RepoRef): Promise<Release | undefined>;
  // 文件获取（两条通道）
  downloadAsset(ref: RepoRef, asset: ReleaseAsset, token?: string): Promise<ArrayBuffer>;
  readRawFile(ref: RepoRef, path: string, ref_?: string, token?: string): Promise<string | undefined>;
  // 平台特有：鉴权注入方式不同（GitHub 用 header，Gitee 用 query）
  applyAuth(url: string, token: string): { url: string; headers: Record<string, string> };
  // 展示
  fileWebUrl(ref: RepoRef, branch: string, path: string): string;
  commitWebUrl(ref: RepoRef, hash: string): string;
}
```

**关键设计点**：`applyAuth()` 是接口方法而不是共用工具函数 —— 因为 Gitee 用 query 参数、GitHub 用请求头，这个差异无法用统一装饰器消除（见分析文档 3.2 差异 2）。

### 2.2 鉴权策略

| 场景 | GitHub | Gitee |
| --- | --- | --- |
| 安装器读公开仓库 | 无需 token（有 60 次/小时限流） | 无需 token |
| 安装器读私有仓库 | `Authorization: token <PAT>` | `?access_token=<token>` |
| git 同步 HTTPS | `-c http.extraheader="Authorization: Basic <b64(user:token)>"` | 同左 |
| git 同步 SSH | 系统 ssh-agent | 系统 ssh-agent |

token 存储：优先 `app.secretStorage`（Obsidian 1.13+），旧版本回退到 `localStorage`（与 obsidian-git 一致，不进 `data.json`）。

> `http.extraheader` 方案需在阶段三用真实 Gitee 私有仓库实测确认。

---

## 三、阶段划分

### 阶段一：地基（本次交付）

- 项目脚手架：TypeScript + esbuild + vitest，构建即部署到测试库。
- `core/i18n`：中文优先 + 英文对等，编译期强制全覆盖。
- `core/settings` + `core/secretStore` + `logger` + `notice`。
- `host` 抽象层全套：`repoRef` 解析、`GitHubHost`、`GiteeHost`、限流重试、错误类型。
- 验证：单元测试（repo 解析、鉴权注入）+ 真实 API 探测脚本（两个平台各跑通 release 列表与 raw 读取）。

**验收标准**：测试库能加载空插件；`pnpm test` 全绿；探测脚本能真实列出 GitHub 与 Gitee 的 release 并读到 raw 文件。

### 阶段二：插件安装器（BRAT 复刻 + Gitee）

- 安装链路：解析 → 校验 manifest（beta → stable 回退）→ 取资产（release → raw 回退）→ 写入前备份 → 写盘 → 启用。
- 双列表模型（普通 + 冻结版本）、更新检查、重装。
- GitHub 侧支持浏览/搜索官方社区插件列表。
- GitHub→Gitee 镜像自动发现。
- UI：添加仓库弹窗、版本选择、设置页（已跟踪列表 + token 管理）。
- 命令：添加仓库、检查更新、更新全部、重装、启用/禁用、打开仓库页、移除。

**验收标准**：能从 GitHub 装一个真插件并启用；能从 Gitee 装一个只有源码没有 release 的插件；更新检查能正确识别新版本。

### 阶段三：Git 同步（obsidian-git 复刻 + Gitee）

- `GitManager` 抽象 + `SimpleGitManager` 实现。
- 核心操作：status / commit / stage / pull / push / fetch / branch / diff / log。
- 同步策略三态（merge / rebase / reset）+ 冲突检测与引导文件。
- 自动提交/同步定时器（含"上次执行时间"持久化）。
- 状态栏 + 源码控制视图 + 提交消息模板变量。
- Gitee 远端适配：`formatRemoteUrl` 加 gitee、`openInGitHub` 抽象为 provider。
- 命令：同步、提交全部、推送、拉取、分支管理、暂存/取消暂存、编辑远端。

**验收标准**：在测试库里对一个真实 Gitee 私有仓库完成一次完整的「改文件 → 自动提交 → 推送 → 在另一处拉取」闭环。

### 阶段四：打磨与发布

- 设置页完整化、错误提示文案统一、边界情况（git 未安装、无仓库、网络失败）。
- 文档（中文 README + 使用说明）。
- 发版流程（GitHub Release + 资产）。

---

## 四、明确不做的（v1 范围外）

| 不做 | 原因 |
| --- | --- |
| 移动端 Git 同步（isomorphic-git） | 已决策。省约 1.4k 行与约 1MB 包体；原生 git 才有完整冲突检测与 SSH |
| 主题的**从仓库新装**（BRAT 的 `AddNewTheme`） | 后续单项已做「绑定 + 更新」（见第六节），但**不从仓库新装**：主题的手工获取渠道（官网下载、别人分享的目录）比插件顺畅得多，而新装需要多一套版本选择与落盘路径。抽象层与模型都已就位，要加只需补一条入口 |
| 行作者 / blame / hunk 签名 | obsidian-git 中约 3k 行的可选增强，与"同步"目标无关 |
| 树形文件视图、squash、raw-command | 边缘功能 |
| 设置页新旧双渲染兼容 | BRAT 的历史包袱，直接只用新版 API |
| GitLab / Bitbucket | 抽象层留了扩展位，但 v1 只实现 GitHub + Gitee |

---

## 五、主要风险

| 风险 | 应对 |
| --- | --- |
| Gitee `http.extraheader` 鉴权未经验证 | 阶段三第一件事就是实测；失败则回退到 askpass 弹窗方案（复刻 obsidian-git 做法） |
| Gitee 限流比 GitHub 严格且无明确响应头 | `host/http.ts` 统一退避重试；把限流阈值做成设置项 |
| GitHub 镜像发现误判（同名不同项目） | 用 manifest 的 `id` 字段做二次校验，不只比仓库名 |
| Windows 下 git 不在 PATH | 复刻 obsidian-git 的 `gitPath` 设置项 |
| 两功能共用 `main.ts` 导致耦合 | 每个 feature 暴露统一的 `register(plugin)` 入口，主类只做装配 |

---

## 六、主题支持（后续增补，2026-09-17）

原计划把「主题安装」列为 v1 范围外。后续按使用反馈补上了**绑定与更新**。
下面四条是当时确认过的取舍，不要重新讨论。

### 6.1 范围

| 做 | 不做 |
| --- | --- |
| 绑定库里已装的主题（官方社区主题索引自动识别来源；未识别的可手填仓库） | 从仓库**新装**主题 |
| 与插件共用同一条检查更新 / 执行更新的链路 | 主题版本钉选（语义就是「跟随仓库」） |
| 取消绑定（只出跟踪列表，**不删文件**、不切主题） | 从跟踪列表里删文件（那归 Obsidian 自己管）、主题 beta 通道（`theme-beta.css`）、预览图、light/dark 筛选 |

因为不做「新装」，原本想做的「新装后自动切换到该主题」也就没有触发点 ——
本次只落地「**更新绝不切换主题**」，切换能力作为受守卫的封装留给将来的新装入口。

### 6.2 更新判据：版本号（与插件一致）

实测三份流行主题的 manifest **都带 `version` 与 `minAppVersion`**
（kepano/obsidian-minimal `9.1.0`、colineckert/obsidian-things `2.2.4`、
AnubisNekhet/AnuPpuccin `1.5.0`），Minimal 还有 21 个与版本号同名的 release。
所以判据沿用插件的「远端版本 vs 本地已装版本」，**不用** BRAT 那套 CSS 字符和校验。

> 一度误以为「主题普遍不写版本号」——那个印象来自官方社区主题索引
> `community-css-themes.json`（它的条目确实只有 `name/author/repo`）。
> 索引没有版本号，不代表主题自身的 manifest 没有。

**多一级回退**：没有 release 的主题去读默认分支的 `manifest.json` 取 `version`。
插件那边停在「没有 release 就无从比较」（配额考虑），主题这边必须往下走一级 ——
主题的生态就是「只推仓库、不发 release」，不读它那些主题永远收不到更新提示。

### 6.3 身份与磁盘位置

- 主题**没有 id 字段**，身份就是 `{configDir}/themes/` 下的**目录名**
  （`app.customCss.setTheme()` 收的也是它）。这与插件「身份一律以 manifest id 为准」
  刚好相反 —— 理由写在 `core/themeName.ts` 与 `itemFolder.ts` 的注释里。
- 更新永远写回**记录的那个目录**，绝不按远端 manifest 的 `name` 改名。
- 路径安全仍是同一条不变量：`isValidThemeName` 只拦路径风险（`.`、`..`、分隔符、
  首尾空白、结尾的点），**允许**空格 / 大写 / 非 ASCII —— 真实主题名就是这些形态。

### 6.4 非公开 API 与兜底

「当前用的是哪一个主题」只存在于非公开 API（公开 `obsidian.d.ts` 里 `customCss`
出现 **0 次**）：读 `getTheme()` / `customCss.theme` / `vault.getConfig("cssTheme")`，
切 `setTheme(name)`，重载 `requestLoadTheme()`。全部走窄接口 + 可用性兜底，
与 `pluginFolder.ts` 的 `InternalPluginManager` 是同一套做法：

- 读不到当前主题时返回 `undefined`，**与表示默认主题的空串区分开**；
  读不到当前主题时不猜（返回 `undefined`），也就不会触发那次重载；
- 重载失败只记 debug 日志 —— 文件已经写好，刷新观感是锦上添花，不该报成更新失败。

---

## 七、SyncHub 自身的更新（后续增补，2026-09-17）

设置页「安装器」页里的一节：当前版本 + 检查更新 + 更新到最新 + 一行状态。
**更新只写入新版本的文件，不重载自己** —— 对普通插件是 disable → enable，
对自己则是先卸载正在执行这段代码的实例（剩下半段靠闭包才活着），
失败就停在「已禁用」。所以由用户重启完成剩下的事，并用一个持久化的
「待重启」标记在那段时间里如实提示（重启后自动清除）。

两道守卫：远端 manifest 的 id 必须是 `synchub`（仓库坐标写死在
`selfUpdate.ts` 的 `SELF_REPO`，指错地方会覆盖别的插件）；不允许降级，
但允许同版本重装（修复一个坏掉的安装）。

已知边界：`main.js` 是构建产物（不入库），所以自我更新**只能吃 release 资产**，
源码回退通道对它无效；发布到社区市场后，Obsidian 自带的更新入口是更稳的一条路。
