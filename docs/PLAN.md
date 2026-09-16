# OBSync 复刻规划

> 目标：独立复刻 obsidian-git 的笔记仓库同步能力 + obsidian42-brat 的社区插件安装能力，
> 合并为单一 Obsidian 插件，并把两者从「仅 GitHub + 英文」扩展为「GitHub / Gitee 双平台 + 中文优先」。

已确认的四项决策：

| 决策项 | 结论 |
| --- | --- |
| 移动端支持 | **不支持**。v1 仅桌面，Git 同步只用系统 git（`simple-git`） |
| 交付节奏 | **分阶段，逐段验收** |
| 插件标识 | `obsync` / **OBSync** |
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

4. **两个项目都是英文优先。** BRAT 的 i18n 方案很好（编译期强制全覆盖），但它把中文当二等公民（后补的 locale）。OBSync 以中文为第一语言，英文作为对等 locale。

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
| 主题安装（BRAT 的 themes 功能） | 与核心目标（笔记同步 + 插件获取）无关，可后续单独加 |
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
