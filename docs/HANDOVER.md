# OBSync 交接文档

> **这是接手本项目的第一份必读文件。** 配套阅读：`docs/PLAN.md`（总体规划与阶段划分）、
> `docs/reference-analysis.md`（两个参考项目的源码分析）、`.workbuddy-ai/memory/`（历次工作日志）。
>
> 最后更新：2026-09-16（阶段二完成并提交 `46170ef`）

---

## 一、项目是什么

单个 Obsidian 插件（id `obsync`），把两个参考项目的能力合并并扩展：

| 能力 | 复刻自 | 扩展点 |
| --- | --- | --- |
| 笔记仓库 Git 同步 | obsidian-git（~16.9k 行） | GitHub / **Gitee** 双平台 |
| 社区插件安装 | obsidian42-brat（~5k 行） | Gitee 源安装 + 中文优先 |

参考源码在 `F:\_Workspace\GitHub-Project\` 下，**只读，不要改动**。

已确认的四项决策（不要重新讨论）：

1. **仅桌面**。Git 同步只用系统 git（simple-git），不做 isomorphic-git。
2. **分阶段交付，逐段验收**。
3. 插件标识 `obsync` / OBSync。
4. Gitee 插件发现 = 手动输入 + GitHub→Gitee 镜像自动发现。

## 二、当前进度

| 阶段 | 状态 | 提交 |
| --- | --- | --- |
| 一：脚手架 + core + host 抽象层 | ✅ 完成 | `002056d` |
| 二：插件安装器（BRAT 复刻） | ✅ 完成 | `46170ef` |
| 三：Git 同步（obsidian-git 复刻） | ⬜ **下一步** | — |
| 四：打磨与发布 | ⬜ 未开始 | — |

**验收标准速查**（详见 PLAN.md 第三节）：

- 阶段二 ✅：能从 GitHub 装真插件并启用；能从 Gitee 装只有源码没有 release 的插件；更新检查能识别新版本。
- 阶段三 ⬜：对真实 Gitee 私有仓库完成「改文件 → 自动提交 → 推送 → 另一处拉取」闭环。

## 三、命令与环境

```
pnpm dev        # esbuild watch + 自动部署到测试库
pnpm build      # typecheck + 生产构建 + 部署
pnpm typecheck  # tsc --noEmit
pnpm test       # 单元测试（无网络，~1.5s）
pnpm test:live  # 真实 API 测试（OBSYNC_LIVE=1，需网络）
```

- 部署目标 `F:/_Workspace/Plugin-Test/.obsidian/plugins/obsync`，
  环境变量 `OBSYNC_DEPLOY_DIR` 可覆盖，设空串跳过；部署失败只警告不中断构建。
- 测试库路径下可直接手测插件（Obsidian 打开该库）。
- 本机 shell 是 Git Bash（Windows），git 二进制可用（阶段三会用到）。

## 四、代码地图

```
src/
├─ main.ts                 # 主类：只做装配。安装器已挂载；阶段三的 sync 模块也在这里挂
├─ settingsTab.ts          # 设置页：语言/host令牌/安装器列表/sync（阶段三加）
├─ core/                   # i18n（zh-cn 是规范源）、settings、secretStore、logger、notice
├─ host/                   # ★ 双平台抽象层（脊柱）
│  ├─ IRepoHost.ts         # 统一接口；applyAuth 是接口方法（GitHub 用 header，Gitee 用 query）
│  ├─ githubHost.ts / giteeHost.ts
│  ├─ repoRef.ts           # owner/repo 解析（URL / 简写 / scp 形式）
│  ├─ http.ts              # requestUrl 封装：throw:false、重试退避（400ms*3^n）、20s 超时
│  └─ statusMapper.ts      # 状态码 → RateLimitError/AuthError/NotFoundError
├─ features/installer/     # 阶段二产出，见第五节
└─ features/sync/          # ⬜ 阶段三要建的模块
```

## 五、安装器（阶段二）实现要点

文件都在 `src/features/installer/`，测试在 `tests/features/`。

**安装主链路**（`installerService.ts`）：
解析仓库 →（可选）镜像发现 → 解析安装目标 → 取文件 → 兼容性检查 →
备份 → 写盘 → 启用/重载 → 记录。兼容性检查**必须在写盘之前**。

**关键设计**：

- **三级回退**（`resolveSource`）：指定 tag → 最新正式版 → 最新预发布 → 源码 HEAD。
  API 限流/不可用时降级源码通道并提示用户 —— Gitee 匿名配额实测极低，
  没有这条降级路径就完全装不了。
- **逐文件回退**（`pluginFiles.ts`）：release 资产里缺哪个文件，就回该 tag 源码里读。
  `styles.css` 是可选文件，任何失败静默跳过（包括网络错误）。
- **写入前备份 + 回滚**（`pluginFolder.ts`）：先快照进内存，写失败整体还原。
  回滚也失败时报错让用户手动检查。BRAT 没有这套机制。
- **单一跟踪列表**（`types.ts` 的 `TrackedPlugin`）：不复刻 BRAT 的双平行列表。
  settings 加载时会做结构校验（`sanitizeTrackedPlugins`），坏条目直接丢弃。
- **更新检查与执行分离**（`updateChecker.ts`）：只提示不自动装。
  冻结项（`frozen`）跳过检查与批量更新，但可以手动重装。
- **镜像发现**（`mirrorFinder.ts`）：用两边 manifest 的 `id` 二次校验，
  同名不同项目直接放弃 —— 装错比找不到严重。默认关闭
  （实测抽样 40 个社区插件命中 0 个），且全程走 raw 通道零 API 配额。
- **社区插件索引**（`communityPlugins.ts`）：GitHub 独有资源，Gitee 无等价物。
  6 小时缓存；统计文件可选；7685 条实测。

## 六、实测发现（读文档看不出来，改代码前先看这里）

### 平台差异

1. **Gitee releases 默认升序**。必须传 `direction=desc`，否则会静默装六年前的版本。
2. **Gitee API raw 端点对匿名请求一律 401**（即使公开仓库）。
   匿名读文件走网页通道 `https://gitee.com/{o}/{r}/raw/{ref}/{path}`。
3. **Gitee 网页 raw 通道接受 `HEAD` 作为默认分支写法**（实测 200）——
   省一次 `getRepoMeta` 调用，对匿名配额极低的 Gitee 很关键。
4. Gitee 鉴权走 `access_token` **查询参数**，GitHub 走 `Authorization` 请求头。
   所以 `applyAuth` 是接口方法。
5. Gitee 的 `html_url` 带 `.git` 后缀，要剥掉。
6. Gitee `/v5/search/repositories` 匿名返回空数组，搜索不可用。
7. Obsidian `requestUrl` 的 `throw` 默认 true，要显式传 `throw: false`。

### 测试约定（踩过的坑）

8. **stub 的 `requestUrl` 必须从 text 派生 arrayBuffer**（`tests/stubs/obsidian.ts`）。
   真实 Obsidian 的两个属性都反映响应体；如果处理器只给 text 而 arrayBuffer 返回空,
   release 资产下载（走 arrayBuffer）会静默变成空内容，测试以
   「manifest 不是合法 JSON」的方式误报 —— 曾导致 4 个安装测试假失败。
9. 测试里调 stub 辅助函数必须用**相对路径** import（`"obsidian"` 只有运行时才走 alias）。
10. stub 的 `json` 必须是惰性 getter。
11. `tests/live/**` 默认排除，`OBSYNC_LIVE=1` 开启。
12. 单测里路由式 HTTP mock：**可选文件（styles.css）也要给 404 路由**，
    否则「无路由抛错 → 重试退避」白耗 1.6 秒。

### 环境约束

13. **Gitee 匿名 API 配额极低**：连续请求直接 403，实测约一分钟内不恢复。
    live 测试里 Gitee 的 API 用例可能因限流失败 —— 这是环境现象不是回归，等窗口重置再跑。
14. **本机网络访问 objects.githubusercontent.com（GitHub 资产 CDN）超时**（2026-09-16 实测
    21s 0 字节），但 api.github.com / raw.githubusercontent.com 正常。
    live 测试里「下载 release 资产」用例在该网络下会超时，属环境问题。
15. 测试库里已装的第三方插件 `gitee-sync-plus` 不是真 git 实现（只做文件级收发），
    所以 OBSync 走真 git 是差异化，不是重复劳动。

## 七、阶段三开工指引（Git 同步）

按 PLAN.md 第三节的清单做。落地顺序建议（每步保持 `pnpm test` 全绿）：

1. **依赖**：`pnpm add simple-git`。注意 esbuild 需要把 simple-git 打进产物
   （阶段一构建配置已验证无 node 内置模块直连，simple-git 依赖 node 内置，
   esbuild `platform=node` + `external: obsidian` 应该能处理，先跑通再提交）。
2. **`sync/gitManager.ts`**：抽象接口（status / stage / commit / pull / push / fetch /
   branch / log / diff），obsidian-git 的同名分层可以参考但接口按需收窄。
3. **`sync/simpleGitManager.ts`**：桌面实现。**gitPath 设置**要有（Windows git 不在 PATH 时用）。
4. **`sync/auth.ts`**：远端鉴权用 `-c http.extraheader="Authorization: Basic <b64(user:token)>"`。
   **这是阶段三第一件要实测的事**（PLAN.md 风险表第一条）：
   对真实 Gitee 私有仓库 push 一次确认；失败就回退 askpass 方案。
   令牌从 `core/secretStore` 拿，绝不进 data.json。
5. **`sync/syncService.ts`**：pull/commit/push 编排 + 三态同步策略（merge/rebase/reset）
   + 冲突检测与引导文件。
6. **`sync/automatics.ts`**：自动提交/同步定时器，"上次执行时间"要持久化（进 settings）。
7. **状态栏 + 源码控制视图 + 命令**：命令清单见 PLAN.md 阶段三。
8. **i18n**：`zh-cn.ts` 加 `sync` 段（规范源），`en.ts` 同步补齐，typecheck 会强制。
9. **设置**：`core/settings.ts` 的 `SyncSettings` 已有骨架（enabled/autoCommitSeconds 等），
   归一化逻辑照 installer 的样子写。

测试策略：simple-git 在单测里直接对**真实临时 git 仓库**操作（`mkdtemp` + `git init`），
比 mock 更可信；live 测试走真实远端（可用 Gitee/GitHub 各建一个测试仓库）。

## 八、交接习惯（沿用 WorkBuddy 的做法）

- **边做边写文档**：本文件随代码一起更新；当日工作日志追加到
  `.workbuddy-ai/memory/YYYY-MM-DD.md`；新的"实测发现/踩坑"一定记入第六节。
- 提交信息用中文，说明"为什么"；阶段完成一次大提交。
- 参考 `MEMORY.md` 里的长期约定（i18n 规范源、host 层设计原则、代码风格）。
