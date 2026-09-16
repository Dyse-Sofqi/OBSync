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

### 代码风格
- 注释用中文，写**为什么**而不是**做了什么**。
- 不复刻参考项目的兼容包袱（如 BRAT 的设置页新旧双渲染、obsidian-git 的树形视图）。
- 敏感项（令牌）**绝不进 `data.json`**，走 `core/secretStore`。
