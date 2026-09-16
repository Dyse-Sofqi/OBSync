# OBSync 项目长期约定

## 项目定位
单个 Obsidian 插件（id `obsync`），两个功能模块共用一层平台抽象：
- `features/installer` —— 复刻 BRAT 的社区插件安装能力
- `features/sync` —— 复刻 obsidian-git 的笔记仓库同步能力
- `host/` —— GitHub / Gitee 双平台适配层，两个模块共用

参考源码在 `F:\_Workspace\GitHub-Project\` 下，**只读参考，不要改动**。

## 命令
```
pnpm dev            # esbuild watch + 自动部署到测试库
pnpm check          # 项目自查（scripts/checks.mjs，5 项）
pnpm build          # check + typecheck + 生产构建 + 部署
pnpm typecheck      # tsc --noEmit
pnpm test           # 单元测试（不含网络）
pnpm test:live      # 真实 API 测试（需要网络）
pnpm verify:mobile  # 构建 + 用真实产物验证「移动端能加载」
```

部署目标：`F:/_Workspace/Plugin-Test/.obsidian/plugins/obsync`，
可用环境变量 `OBSYNC_DEPLOY_DIR` 覆盖，设为空串则跳过部署。
部署失败（比如测试库不在）**不会中断构建**，只打警告。

## 约定

### i18n
- **`src/core/i18n/locales/zh-cn.ts` 是规范源**，`LocaleStrings` 从它推导。
- 其他语言文件必须 `satisfies LocaleStrings`，漏翻译在 `pnpm typecheck` 阶段就报错。
- 不要给 locale 对象加 `as const` —— 会把字符串收窄成字面量类型，其他语言无法满足。
- 新增语言的步骤：建 `locales/xx.ts` → 在 `i18n/index.ts` 的 `LOCALES` 注册 → 加进 `LANGUAGE_OPTIONS`。

### 错误与文案的归属（改错误路径前必读）
**规则：逻辑层抛「类型码 + 参数」，展示层拼「用户能看懂的话」。**

编译期保证只管「locale 之间的结构一致」，**管不住「代码里直接写了一句中文」**。
而错误路径最容易这么写 —— 因为抛出点（`manifest.ts` / `pluginFiles.ts` /
`pluginFolder.ts` / `simpleGitManager.ts`）是纯逻辑，拿不到 `t`。

| 层 | 职责 |
| --- | --- |
| 逻辑层 | 抛 `InstallerError({ kind, ...params })` 或领域错误类型；`message` 只放**技术性描述**（英文，进日志） |
| 注册 | `createXxxModule()` 里 `notifier.registerErrorTranslator(...)` |
| 展示层 | `Notifier.describeError()` 按类型码取 locale 文案 |

- 用**可辨识联合 + `switch` 穷尽检查**（`const exhaustive: never = detail`）：
  新增类型码却忘了加文案会**编译报错**，不会留到运行时。
- `Notifier` 用**注册制**而非 `import` 各功能的错误类型 —— `core/` 不该知道 `features/`。
- **断言错误的类型码，不要断言消息文本**（助手 `tests/helpers/expectInstallerError.ts`）。
- **错误类型用错比没有类型更糟**：曾把「没有上游分支」「游离 HEAD」都抛成
  `GitNotRepoError`，提示语变成「请先初始化仓库」，把用户指错方向。

### 自查脚本（`scripts/checks.mjs`，随 `pnpm check` 跑）
早先是 `.probe/` 里的 Python 草稿，已移植成 Node 并入仓库。五项：
- **minAppVersion 一致性**：用 `node_modules/obsidian/obsidian.d.ts` 的 `@since`
  比对 manifest。按**类作用域**限定，否则 `.name` / `.status` 这类同名成员会大量误报。
- **硬编码中文**：扫 locale 之外的代码。**新增的中文都该是可疑的**。
- **未使用的 i18n 键**：死键是信号，背后通常是漏接的本地化。
- **CSS 类覆盖**：比对代码用到的 `obsync-*` 类与 `styles.css` 定义的类。
- **移动端安全**：从 `main.ts` 走静态导入图，看有没有触及依赖 Node 的裸模块。

两张**带理由**的豁免表在脚本里（`KNOWN_SAFE` / `ALLOWED` / `NOT_CLASS_PREFIXES`）——
加条目必须写清为什么安全，否则它们会变成掩盖问题的地方。
扫描器要**剥注释**再扫，否则注释里提到的类名/中文会被算成「用到了」。

⚠ **不要靠 `.probe/` 存放「被文档引用的依据」**：它已 gitignore，
别人克隆仓库后找不到。有引用价值的脚本/探针要么进 `scripts/`，要么做成测试。
（2026-09-17 修：移动端探针 → `scripts/verify-mobile-load.mjs`，
鉴权上网探针 → `tests/features/authHeader.test.ts`。）

### 测试
- `tests/live/**` 默认被 `vitest.config.ts` 排除，靠 `OBSYNC_LIVE=1` 开启。
- **`tests/live/privateRepoAuth.live.test.ts` 是可选启用的端到端鉴权验证**：
  设 `OBSYNC_LIVE_PRIVATE_REPO`（GitHub 上令牌可省略，会回退 `gh auth token`；
  Gitee 要加 `OBSYNC_LIVE_TOKEN`），未配置时整组跳过。
  结构是**「对照组 + 接受」**——对照组（不带凭据必须失败）**不能删**，
  否则「成功」什么也证明不了。再开 `OBSYNC_LIVE_ALLOW_PUSH_DRY_RUN=1`
  会多跑一条 push 预检（`--dry-run`，不发送对象也不更新引用）。
- **「连接测试」这类 `ls-remote` 诊断发现不了用户名问题**：Gitee 的用户名白名单
  只在 **push 路径的服务端钩子**里执行（报错带 `remote:` 前缀）。实测用伪造令牌打
  fetch 端点时，`git` / `oauth2` / 随机串返回的是**完全相同**的通用 401。
  所以「对端接不接受这个值」必须靠真实 push 才能验。
- **本机 `gh` 的令牌可用**（`login=Dyse-Sofqi`），存在
  `%APPDATA%\GitHub CLI\hosts.yml` —— **不是** `~/.config/gh/hosts.yml`（Windows 路径）。
  `gh auth status` 会误报「未登录」，但 `gh auth token` 有值（`gho_` 开头）且能调通 API。
  判断有无凭据一律以 `gh auth token` + 一次真实 API 调用为准。
- **`testTimeout` 是 30 秒不是默认的 5 秒**。本机进程创建约 340ms，
  `simpleGitManager.test.ts` 一个用例起十几次 git 就要 4~5 秒 —— 默认超时会
  以「用例超时 + 清理 EBUSY」的形式误报，看着像被测代码有 bug。
  该文件单独跑约 150 秒，**不要因为慢就以为它挂了**。
- `obsidian` 模块在测试里被 alias 到 `tests/stubs/obsidian.ts`。
  **测试里要调 stub 的辅助函数（如 `__setRequestUrlHandler`）必须用相对路径 import** ——
  TS 会把 `"obsidian"` 解析到真实的类型包，只有 vitest 运行时才走 alias。
- stub 的 `requestUrl` 返回的 `json` 必须是**惰性 getter**（真实 Obsidian 就是如此），
  写成立即求值会让非 JSON 响应误抛异常。
- stub 的 `requestUrl` 在处理器只给 `text` 时必须**从 text 派生 `arrayBuffer`**
  （真实 Obsidian 两者都反映响应体）。返回空 buffer 会让 release 资产下载静默变空，
  测试以「manifest 不是合法 JSON」的方式假失败（2026-09-16 踩过）。
- 单测的 HTTP mock 里，**可选文件也要给 404 路由** —— 否则「无路由抛错 → 重试退避」
  每个用例白耗 1.6 秒。
- **不要给 simple-git 传 `.env({ ...process.env })`**：3.36 起会守卫
  `GIT_PAGER` / `GIT_EDITOR` 这类会注入配置的环境变量，直接抛
  `Use of "GIT_PAGER" is not permitted without enabling allowUnsafePager`。
  表现为「本地服务器收到 0 个请求」，看着像网络问题。生产代码不调 `.env()`，不受影响。
- `git config --get <key>` 键不存在时 simple-git 返回**空串**而非抛错，
  断言"未设置"要写 `toBe("")`。

### 网络可达性（决定了两处必须保留的降级）
- **GitHub 三条通道可达性互不相关**（本机实测）：`api.github.com` 稳定、
  `raw.githubusercontent.com` 稳定、但 `github.com/.../releases/download/` →
  `objects.githubusercontent.com` **3 次里 2 次 21 秒超时 0 字节**。
  所以：`pluginFiles.loadReleaseFile` 在**资产下载失败**时也回退该 tag 的源码；
  `GitHubHost.readFile` 在 raw 域名不可达时回退 contents API。这两条不是洁癖，别删。
- **Gitee 匿名 API 配额极低**：连续请求直接 403 且一分钟内不恢复。
  live 测试里 Gitee 的 API 用例会**跳过**（不是失败）—— 想跑绿就配
  `OBSYNC_GITEE_TOKEN`。走网页 raw 通道的用例不吃配额，不包装。
- 本机网络对 `objects.githubusercontent.com`（GitHub 资产 CDN）超时，API 域名正常；
  Gitee 匿名 API 配额极低（403 后约一分钟不恢复）。live 测试相关用例失败先怀疑环境。

### git 错误文案
- **靠 git 的错误文案做分支判断时，正则必须用真实输出校准**。
  `git restore --staged` 在 HEAD 未出生时报的是 `fatal: could not resolve 'HEAD'`
  —— **HEAD 带单引号**。凭记忆写 `/could not resolve HEAD/` 会永远匹配不上，
  回退分支形同虚设（2026-09-16 踩过，见 `HEAD_UNBORN_RE`）。

### host 层设计原则
- 平台差异**只允许出现在 `host/` 内部**。上层（安装器 / 同步）不得出现 `if (host === "gitee")`。
- 鉴权注入是**接口方法**（`applyAuth`），不是共用工具函数 —— Gitee 用查询参数、GitHub 用请求头。
- 状态码 → 错误类型的映射共用（`statusMapper.ts`），但**判定条件由各 host 提供**。
- 两个平台的已知差异（都有实测依据，改动前先看 `docs/reference-analysis.md`）：
  - Gitee releases **默认升序**，必须传 `direction=desc`
  - Gitee 的 API raw 端点对匿名请求返回 **401**，匿名读文件必须走网页 raw 通道
  - Gitee 的 `html_url` 带 `.git` 后缀
  - Gitee 的 `access_token` 走查询参数
  - **git 的 HTTP Basic 用户名是平台差异**：Gitee 只接受 账号名 / `oauth2` /
    `gitee.com`，填 `git` 会被**直接拒绝**（公开仓库照常能读，只有私有仓库
    push/pull 失败 —— 极易误判成令牌问题）。落在 `IRepoHost.gitAuthUsername`：
    Gitee → `oauth2`、GitHub → `x-access-token`。**不要退回硬编码 `git`。**
- **平台差异的表达形式**：能用一个属性说清的（`tokenInQuery`、`gitAuthUsername`）
  就做成接口属性；需要行为差异的做成接口方法（`applyAuth`）。不要用
  `if (host === "gitee")` 散在上层。
- **涉及「对端校验规则」的假设不要写成「文档如此」**：要么实测，要么明确标注未验证。
  用户名那条就是照「两个平台都只校令牌不校用户名」的假设写的，结果是错的 ——
  而单测永远发现不了（我们构造出的 Basic 头本身合法，不合法的是对端接不接受）。

### 凭据不能从消息/日志漏出去（新增网络代码前必读）
- **任何写进错误消息或日志的 URL 都要过 `host/redact.ts` 的 `redactUrl()`**。
  Gitee 的令牌只能放查询串（`?access_token=`），而 `Notifier` 会把
  `NetworkError.message` **原样弹在屏幕上**、`logger` 又写进控制台 ——
  后者正是用户报 issue 时贴的东西。`secretStore` 绕开 `data.json` 的功夫
  会被这条路全部抵消（2026-09-16 修）。
- **回显用户输入的错误也要脱敏**：`parseFailed` / `unsupportedHost` 两条 i18n
  文案直接内插 `input`，而用户会粘 `https://oauth2:TOKEN@gitee.com/…`
  甚至整条 `git clone …`。
- **「给人看的字符串」的每个收口点都要做一次**，不要逐条去记哪些变量敏感。
  已有三处：`httpRequest` 的所有 URL 出口、`repoRef` 的错误回显、
  `SyncService.diagnose` 的 `add()`（报告的 `detail` 会渲染在设置页上）。
- 脱敏的失败方式有两种，**两种都要测**：漏脱（令牌泄漏）与**过脱**
  （把非凭据参数、或消息里地址后面的说明文字一起吃掉 → 日志看不出超时还是失败）。
  只测「敏感内容不出现」的话，最省事的实现（整段删掉）也能让测试变绿；
  同时要有一条「**脱敏不能影响实际请求**」的守卫。
- **别用 `new URL()` → `toString()` 做脱敏**：会规范化 URL（补斜杠、重排参数），
  日志里的地址就和实际发出去的不是同一个；畸形输入上还会抛错。定点正则替换即可。
- **SSH 地址的 `git@` 是登录名，不是令牌**。无冒号的 userinfo 判成凭据是错的
  （会让每个正常 SSH 远端都收到「你的令牌会被明文写入」的警告），
  所以 `redactUserInfo` 按 scheme 区分，白名单见 `USERNAME_ONLY_SCHEMES`。
  但 `https://TOKEN@github.com` 是**真实用法**（平台接受令牌当用户名），仍要脱。
- `containsCredentials()` **由 `redactUrl` 的结果导出**（`redactUrl(x) !== x`），
  刻意只留一个事实来源 —— 否则会出现「警告了却脱不干净」的自相矛盾状态。
- **git 自己的报错会剥掉 userinfo**（实测：`fatal: Authentication failed for
  'https://gitee.com/o/r.git/'`，令牌不在里面），所以 git stderr 这条路是干净的；
  但 **`git remote -v` 会显示明文**，`.git/config` 里也是明文 ——
  这正是 `auth.ts` 选择 `http.extraheader` 的理由，别改回把令牌写进 remote URL。
- git 层的令牌走 `http.extraheader`（`-c` 参数），不落盘也不进错误消息 ——
  这条路径是对的（simple-git 的报错取 stderr 而不是命令行），别改成写进 remote URL。

### 代码风格
- 注释用中文，写**为什么**而不是**做了什么**。
- 不复刻参考项目的兼容包袱（如 BRAT 的设置页新旧双渲染、obsidian-git 的树形视图）。
- 敏感项（令牌）**绝不进 `data.json`**，走 `core/secretStore`。
