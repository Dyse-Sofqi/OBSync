# SyncHub 项目长期约定

> 2026-09-23 二次精简。只留「下次还会踩」的规则 —— 细节、排查过程、代码位置看
> `.workbuddy-ai/memory/YYYY-MM-DD.md` 与 `docs/`。
> **这个文件有注入长度上限（约 14KB，超了会被截断成半截），别往里堆。**

## 项目定位

单个 Obsidian 插件，共用一层平台抽象：`features/installer`（复刻 BRAT）、
`features/sync`（复刻 obsidian-git）、`features/images`（图片同步到 Cloudflare R2）、
`host/`（GitHub / Gitee 适配层）。参考源码在 `F:\_Workspace\GitHub-Project\`，
**只读，不要改**。

**名字三层**：显示名 `SyncHub`（可改，**不得含 Obsidian 缩写片段**，`OBS` 就会被拒）；
插件 id `ob-sync`（**别动** —— 由审核系统的提交记录决定，本地唯一事实来源是
`selfUpdate.ts` 的 `SELF_PLUGIN_ID`；「没进目录」≠「没有既有身份」，商标规则只管显示名）；
内部前缀 `obsync-`（**一律不动**，改了作废用户令牌与面板状态）。

## 命令与部署

`pnpm dev / check / build / typecheck / test / test:live / verify:mobile / verify:head`。
部署目标 `F:/_Workspace/Plugin-Test/.obsidian/plugins/ob-sync`；`OBSYNC_DEPLOY_DIR`
覆盖（`;` 分隔，空串跳过）；部署失败不中断构建。

**核实部署产物**：esbuild 把中文转义成 `\uXXXX`，`grep "仓库同步"` 匹配不到（看着像没部署），
要查 `\u4ED3\u5E93\u540C\u6B65`（grep 模式用单引号，反斜杠才不会被 shell 吃掉）。

## 约定

### i18n

`src/core/i18n/locales/zh-cn.ts` 是**规范源**，`LocaleStrings` 从它推导；其他语言
`satisfies LocaleStrings`，漏译在 typecheck 报错。**不要加 `as const`**。新增语言：
建 `locales/xx.ts` → `i18n/index.ts` 的 `LOCALES` → `LANGUAGE_OPTIONS`。

### 错误与文案的归属

**逻辑层抛「类型码 + 参数」，展示层拼「用户能看懂的话」。** 逻辑层（`host/`、
`features/*/xxxService.ts`）拿不到 `t`，`message` 只放英文技术描述进日志；
`createXxxModule()` 里 `notifier.registerErrorTranslator(...)` 注册，
`Notifier.describeError()` 按类型码取 locale 文案。

- 可辨识联合 + `switch` 穷尽检查（`const exhaustive: never = detail`）。`Notifier` 用
  **注册制**，不 import 各功能错误类型（`core/` 不该知道 `features/`）。
- **断言错误类型码，不要断言消息文本**。
- **错误类型用错比没有类型更糟**：曾把「没有上游分支」「游离 HEAD」都抛成
  `GitNotRepoError`，提示变成「请先初始化仓库」，把用户指错方向。

### 图片同步（`features/images`）

1. **`run()` 只复制，从不删除。** 双向删除 2026-09-23 去掉：「一边少了 = 用户删的」
   本质上做不准。**不要再把删除加回 `decide()`。**
2. **用户选「保留云端」必须记墓碑**（`SyncedEntry.remoteOnly`），否则删掉的图下一轮
   自己回来。**「没点按钮直接关窗」也按保留处理**；墓碑在 `noteDeleted` 里**早于询问**
   就记（攒批那几百毫秒里可能有同步在跑）。
3. **`folders` 与 `prefix` 各管一件事**：`folders` = 管哪些（唯一边界），
   `prefix` = 放桶的哪儿。`prefix` 存原文，归一只在 `buildR2Config` 里。
   - **`folders` 默认 `["."]`（仓库根目录 = 整个库）**；`""` 是它归一后的规范形状，
     **`normalizeFolders` 必须保留 `""`** —— 丢它等于把「同步整个库」悄悄改回
     「什么都没管」（落盘→读回、服务层每次重跑都会踩）。空行（`"   "`）只在**文本
     解析侧**丢（`parseFolders`）：拆行产生的 `""` 与规范形状长得一样，两者处置相反。
     界面显示空串用 `formatFolderPath`。
   - **坏形状的 `folders` 退空数组，不拿默认值兜底** —— 默认值现在是整个库，兜底等于
     把一次手滑变成「同步全部」；只有「缺失」才拿默认值。判据在 `normalizeSettings`
     读**磁盘原文**（`mergeWithDefaults` 的类型回退会先把坏值换成默认值）。
4. **删除有两条路，别混**：`noteDeleted`（文件管理器里删图 → 攒批 → 问「云端也删吗」）
   vs `deleteImages`（面板上勾选点按钮 → 处置已选定 → 删完绝不能再问，
   `panelDeleted` 每批 `clear()`，否则后来手动删同名文件会**悄悄跳过询问**）。
   顺序**先云端后本地**；边界检查放在**列举云端之前**；面板从云端列举出发，
   清单里本来没有的条目也要能建墓碑（`markRemoteOnlyForced`）。

`delete` 事件挂在 `main.ts` 的 `vault.on("delete")` 上（图片模块不依赖 `Plugin`，
要能在移动端加载）。`syncState.ts` 只做三件事：判断某边变了没、`hasEntry`、记墓碑
—— **不再是删除的安全边界**。

**图片管理面板**：本地 / 云端 / 已链接是**三条独立的轴，不是三个桶**，筛选用三档下拉
（任意/有/无）。批量压缩**保持原格式**且只在变小时写回；重命名改了扩展名 → 跳过。

**Excalidraw 的引用必须解压场景才扫得到**（否则图会被当失联删掉）。⚠ **载荷是折行的**
（每 256 字符），解压前必须剥空白，否则位流错位返回 `null` **且不报错**。校准用测试库
真实载荷 + `lz-string` 官方实现当基准。

R2 走 S3 + SigV4，`sha256.ts` / `sigv4.ts` 手写，**不用 `crypto.subtle`**（移动端可能
非安全上下文，且会把签名链污染成 async）；正确性靠 **AWS 官方向量**校准 —— 自造期望值
两边一起错也照样绿，而 R2 只回一个没解释的 403。

### 自查脚本（`scripts/checks.mjs`，随 `pnpm check`）

六项全只读：minAppVersion 一致性（按**类作用域**限定，否则同名成员大量误报）、硬编码中文、
未使用的 i18n 键、CSS 类覆盖、移动端安全、设置项无人读取。加豁免条目**必须写清为什么安全**。
删掉一处 `t.x.y` 用法时顺手删键；CSS 检查扫**所有** `obsync-*` 字符串（含存储键），
存储键要进 `NOT_A_CLASS`。

### 测试

- `tests/live/**` 默认排除，`OBSYNC_LIVE=1` 开启。`privateRepoAuth.live.test.ts` 是
  **对照组 + 接受**结构，对照组**不能删**。
- **`testTimeout` 30 秒**。`simpleGitManager.test.ts` 单跑约 150 秒，**慢不代表挂了**。
- `obsidian` 在测试里 alias 到 `tests/stubs/obsidian.ts`；**stub 辅助函数必须用相对路径
  import**（TS 会解析到真实类型包）。stub 的 `openedModals` 记录弹窗实例 —— 验「点这个
  按钮弹出什么」用它。
- stub 的 `TFile` / `TFolder` 缺 `vault` 字段：测试里 `as unknown as` 断言一次即可，
  **别给替身加行为不对的 `vault`**。
- **模拟「用户删了文件」必须真的从库里拿掉**（`fakeImageVault.remove()`）：
  `vault.on("delete")` 在文件消失之后才触发。
- stub 的 `requestUrl`：`json` 必须是**惰性 getter**；只给 `text` 时必须**从 text 派生
  `arrayBuffer`**（否则下载静默变空，以「manifest 不是合法 JSON」假失败）。
- 单测 HTTP mock 里**可选文件也要给 404 路由**，否则每用例白耗 1.6 秒重试退避。
- **不要给 simple-git 传 `.env({...process.env})`**：3.36 起守卫 `GIT_PAGER`，直接抛错，
  表现为「本地服务器收到 0 个请求」。

### 网络可达性（决定两处必须保留的降级）

- **GitHub 三条通道可达性互不相关**：`api.github.com` 稳、`raw.githubusercontent.com` 稳、
  `releases/download/` → `objects.githubusercontent.com` **3 次里 2 次 21 秒超时 0 字节**。
  所以 `loadReleaseFile` 在资产下载失败时回退源码、`GitHubHost.readFile` 在 raw 不可达时
  回退 contents API。**别删。**
- **Gitee 匿名 API 配额极低**：连续请求直接 403，一分钟内不恢复。live 测试里 Gitee API
  用例**跳过**（不是失败）。

### git 错误文案

**靠 git 错误文案做分支判断时，正则必须用真实输出校准。** `git restore --staged` 在
HEAD 未出生时报 `fatal: could not resolve 'HEAD'` —— **HEAD 带单引号**（见 `HEAD_UNBORN_RE`）。

### git diff 输出

`diffFile` 的三个选项各防一种真实环境：`-c core.quotePath=false`（否则中文路径被转义
成八进制 `"a/\344\270\255.md"`）、`--no-color`（用户可能配了 `color.ui=always`）、
`--no-ext-diff`（外部 diff 工具输出的**不是** unified diff）。`commitPatch` 的
`-m --first-parent` 是为合并提交（git 默认对它输出空）。**都别删。**

### host 层设计原则

- **`formatRepoId(ref)` 只给 `owner/repo`，不带 host**。跨 host 传递必须把 host 单独带上
  （`fetchItem(spec, formatRepoId(ref), version, { defaultHost: ref.host })`），否则 gitee
  坐标被按默认 `"github"` 重新解析，**悄悄指向另一个仓库**而界面毫无异常。
- 平台差异**只允许出现在 `host/` 内部**；上层不得出现 `if (host === "gitee")`。能用属性
  说清的（`tokenInQuery`、`gitAuthUsername`）就做属性，需要行为差异的做方法（`applyAuth`）。
- **`IRepoHost.gitAuthUsername`**：Gitee → `oauth2`、GitHub → `x-access-token`。
  **不要退回硬编码 `git`** —— Gitee 填 `git` 被直接拒绝，而**公开仓库照常能读**，
  只有私有仓库 push/pull 失败，极易误判成令牌问题；`ls-remote` 这类「连接测试」发现不了。
- 其余平台差异见 `docs/reference-analysis.md`。**涉及「对端校验规则」的假设要么实测，
  要么标注未验证。**

### 凭据不能从消息 / 日志漏出去

- **任何写进错误消息或日志的 URL 都要过 `host/redact.ts` 的 `redactUrl()`** ——
  `Notifier` 会把 `NetworkError.message` 原样弹在屏幕上、`logger` 又写进控制台。
  **回显用户输入的错误也要脱敏**。漏脱与**过脱**两种失败方式都要测，还要有
  「**脱敏不能影响实际请求**」的守卫。
- **别用 `new URL()` → `toString()` 脱敏**：会规范化 URL（日志里的地址与实际发出去的不是
  同一个），畸形输入上还会抛错。定点正则替换即可。SSH 的 `git@` 是登录名不是令牌，但
  `https://TOKEN@github.com` 是**真实用法**，仍要脱。
- git 自己的报错会剥掉 userinfo；但 **`git remote -v` 会显示明文** —— 这正是 `auth.ts`
  选择 `http.extraheader` 的理由，**别改回把令牌写进 remote URL**。

### 配置项的互斥与限制（「假防护」）

- **UI 上灰掉一个开关 ≠ 拦住行为**：库里**已经**存着「开关开着 + 危险组合」的用户不会
  去动设置页。**限制要在「读设置的那一层」也实现一份**（先例：`Automatics.start()`）。
- **灰开关时不要改写它的值**（`setDisabled` 而非 `setValue(false)`）。**改「决定其它
  控件可用性」的设置项后，`commit()` 要传 `redraw=true`**。
- **注意事项放在被违反的那一页的标题正下方**（它针对的是**组合条件**），样式用
  `.obsync-sync-notes` / `.obsync-image-notes`（正文**别**用 `--text-muted`）。

### 代码风格

注释用中文，写**为什么**而不是「做了什么」；不复刻参考项目的兼容包袱；
敏感项（令牌、R2 secret）**绝不进 `data.json`**，走 `core/secretStore`。

### 工具坑

- **`pnpm test` 全绿 ≠ 工作区能编译**：vitest 不做类型检查。2026-09-23 实测工作区里
  躺着 12 处 `tsc` 错误（方法改名后调用方没跟上）而测试只红了 9 条。改完代码
  **一定要单独跑一次 `tsc --noEmit`**。
- **`pnpm <script>` 会在跑脚本前查依赖状态**，不一致就想清空 `node_modules` 重装，
  非 TTY 直接中止（`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`）。绕法：
  `pnpm --config.verify-deps-before-run=false run <script>`，或展开成等价命令直跑。
- **`locales/*.ts` 是 CRLF**：用 node 脚本做多行字符串替换时，搜索串必须先
  `.replace(/\r?\n/g, "\r\n")`，否则 `includes` 恒假 —— 而**单行替换却会成功**，
  症状像「脚本跑了一半」。`Edit` 工具自己会处理换行。
- **`/tmp/xxx.mjs` 在 Windows 上被解析成 `F:\tmp\xxx.mjs`**：临时脚本写到工作区内
  再用相对路径调用。

### 提交与发版

- **提交后要验的是 HEAD，不是工作区**（`pnpm test` 读工作区）。用 **`pnpm verify:head`**，
  已挂 `pre-push`（**push 才是「别人能看到」的时刻**）。别手写
  `git stash && pnpm test && git stash pop`（测试红了 `&&` 链断，改动留在 stash 里）。
- **一次改动横跨多文件（代码 + 测试 + i18n + CSS）时最容易漏 `git add`**，症状恰好是
  「本地一切正常」。提交前对着 `git status` 核一遍。
- commit message：**中文、带用户原话、写清「为什么」与「代价」**，一条只讲一件事。
- 发版流程见 `docs/RELEASE.md`。两条最容易错的：**顺序必须是「先推分支、再建 release」**；
  **校验资产不要下载**（`github.com:443` 时段性阻断），用
  `gh api repos/.../releases/tags/X --jq '.assets[] | "\(.name) \(.size) \(.digest)"'`
  与本地 `sha256sum` 比对。Gitee 镜像**只同步代码与标签，不同步 release**。
