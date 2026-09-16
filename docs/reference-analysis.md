# 参考项目分析总结

本文是对两个参考项目的独立分析结论，用于指导 OBSync 的架构设计。
结论来源：直接阅读源码（非文档转述），关键机制均标注了文件位置。

---

## 一、obsidian-git（Git 同步参考）

规模：`src/` + `tests/` 约 16,900 行 TypeScript。版本 2.39.0。

### 1.1 三层结构

整个插件可以拆成三层，只有第一层是"必须复刻的骨架"：

| 层 | 内容 | 文件 |
| --- | --- | --- |
| **Git 抽象层** | `GitManager` 抽象基类，约 40 个抽象方法 | `src/gitManager/gitManager.ts` |
| **后端实现层** | `SimpleGit`（桌面）/ `IsomorphicGit`（移动） | `src/gitManager/simpleGit.ts`(59KB)、`isomorphicGit.ts`(48KB) |
| **应用层** | 主类装配、定时器、状态栏、四个视图、设置页 | `main.ts`(60KB)、`automaticsManager.ts`、`statusBar.ts`、`ui/`、`setting/` |

### 1.2 关键设计（值得复刻的）

**双后端 + 运行时选择。** `main.ts` 的 `init()` 用 `Platform.isDesktopApp` 决定实例化哪个后端。两套实现的取舍很清楚：

- `SimpleGit`：需要系统 git 二进制，但功能完整 —— SSH、askpass、冲突预检、submodule、blame、进度输出。
- `IsomorphicGit`：纯 JS 可跑移动端，但**只支持 HTTPS**，无 SSH，无冲突预检（要等 commit 才报错），无 submodule/blame，大仓库明显更慢。

OBSync 决策：**v1 只做 `SimpleGit`**。理由见规划文档。

**isomorphic-git 的 fs 适配器。** `myAdapter.ts` 把 Obsidian 的 `DataAdapter` 适配成 node-fs 风格接口（10 个 `promises` 方法）。两个关键处理：
1. `.git/index` 在内存中缓存（`index`/`indexctime`/`indexmtime`），`writeFile` 时拦截、`saveAndClear()` 时回写 —— 因为 index 读写极其频繁。
2. 区分「vault 可见文件」与「隐藏 .git 文件」，走不同的 API（`isHiddenPath()`）。

**凭据与配置分离。** 敏感项（password / username / gitPath / envVars）走 `app.saveLocalStorage`（`src/setting/localStorageSettings.ts`），**明文存储但刻意不进 `data.json`** —— 目的是让 `data.json` 可以安全同步到多设备而凭据不跟着走。普通配置才进 `data.json`。

**认证完全交给原生 git（桌面端）。** 没有 `http.extraheader`、没有 URL 内嵌 token。做法是生成一个 `obsidian_askpass.sh`（路径在 `constants.ts`），设置 `SSH_ASKPASS` + `SSH_ASKPASS_REQUIRE=force`，然后监听 `.git_credentials_input` 文件弹 `GeneralModal` 回填（`simpleGit.ts:249`）。HTTPS 则直接依赖系统 credential helper（osxkeychain / manager / libsecret）。

> OBSync 的取舍：这套 askpass 方案对 Gitee 也能用，但交互重、平台相关性强。OBSync 改用 `-c http.extraheader` 注入 Basic 鉴权（GitHub 与 Gitee 的 HTTPS 都接受 token 作密码），更可控且不落盘。

**自动同步用独立定时器 + 持久化的"上次执行时间"。** `automaticsManager.ts` 维护三个 `setTimeout`（commit / pull / push），`diff()` 用持久化在 localStorage 的"上次执行时间"计算剩余分钟数，所以重启 Obsidian 后定时节奏不会重置。文件变更触发时改用 `debounce`。

**`withGitOperation()` 包装器。** 所有 git 操作都包在这个方法里，负责设置/清除 `GitOperation` 状态，状态栏据此切换图标。这是一个很干净的横切关注点处理方式。

**pull 的同步策略是三态。** `syncMethod` 可选 `merge` / `rebase` / `reset`，rebase 时还能附加 `--strategy-option=<mergeStrategy>`。reset 通过 `update-ref` + `reset` 实现。

**冲突处理是"写文件 + 引导"，不是自动解决。** 检测到 `status.conflicted` 后，写一个 `conflict-files-obsidian-git.md` 列出冲突文件与处理指引，交给用户手动处理。

**路径双向往返。** `getRelativeVaultPath()` / `getRelativeRepoPath()` 处理 `basePath` 设置（仓库不在 vault 根时）。这是"仓库可以放在子目录"这一需求的全部实现。

### 1.3 配置项分组（`constants.ts: DEFAULT_SETTINGS`）

- **同步行为**：`autoSaveInterval` / `autoPushInterval` / `autoPullInterval`（均默认 0 = 关闭）、`autoPullOnBoot`、`pullBeforePush`、`syncMethod`(merge)、`mergeStrategy`(none)、`differentIntervalCommitAndPush`、`setLastSaveToLastCommit`、`autoBackupAfterFileChange`、`autoCommitOnlyStaged`、`updateSubmodules`。
- **提交行为**：`autoCommitMessage`(`"vault backup: {{date}}"`)、`commitMessageScript`、`commitDateFormat`(`YYYY-MM-DD HH:mm:ss`)、`customMessageOnAutoBackup`、`listChangedFilesInMessageBody`。
- **UI 显示**：`showStatusBar`、`showBranchStatusBar`、`changedFilesInStatusBar`、`showFileMenu`、`disablePopups`、`showErrorNotices`、`treeStructure`。
- **行作者**：`lineAuthor.*`（show / followMovement / authorDisplay / coloringMaxAge 等 10 项）。

提交消息模板支持 `{{date}}` `{{hostname}}` `{{numFiles}}` `{{files}}` 四个变量（`gitManager.ts: formatCommitMessage`）。超过 100 个文件时不逐个列出。

### 1.4 命令清单（`src/commands.ts`）

约 40 条，可归为：视图打开（git-view / history / diff）、同步（pull / fetch / push / commit-and-sync）、提交（commit all / staged / smart / specified-message / amend）、分支（switch / create / delete / set-upstream）、暂存（stage/unstage current file）、远端（edit-remotes / remove-remote / set-upstream）、仓库（init / clone / delete）、其他（edit-gitignore / raw-command / pause-automatic-routines / toggle-line-author-info / hunk 系列）。

### 1.5 与 Gitee 相关的硬编码（必须改造的点）

- `utils.ts: formatRemoteUrl()` —— 只对 `github.com` 和 `gitlab.com` 补 `.git` 后缀。**需要加 `gitee.com`**。
- `openInGitHub.ts` —— 正则与 URL 模板全部硬编码 `github.com`。Gitee 的对应格式是 `gitee.com/{user}/{repo}/blob/{branch}/{path}`。**需要抽象成 provider**。
- `docs/Authentication.md` 提到的 credential helper 方案（osxkeychain / manager / libsecret）在 Gitee 上同样适用，无需改造。

### 1.6 可砍清单

`treeStructure` 树形视图、`squashCommitsBeforePush`、`raw-command`、`delete-repo`、split-diff 的 CM 内联编辑、`openInGitHub` 的行级定位、行作者（`lineAuthor` 约 1.5k 行）、hunk signs（`editor/signs` 约 1.5k 行）、blame、submodule 递归。

---

## 二、obsidian42-brat（插件安装器参考）

规模：`src/` 约 5,000 行 TypeScript。

### 2.1 安装链路（核心，必须复刻）

从"用户输入 repo"到"插件被加载"的完整步骤：

1. `AddNewPluginModal.submitForm()` → `scrubRepositoryUrl()` 清洗输入（去掉 `https://github.com/`、尾部 `/`、`.git`）。
2. `validateRepository(repo, true)` —— 先取 **beta manifest**，失败再退到 **stable manifest**。内部流程是 `isPrivateRepo` → `grabReleaseFromRepository` → `grabReleaseFileFromRepository("manifest.json")`，校验 `id` 与 `version` 存在，并用 semver 比对 tag 与 manifest 内版本号（不一致则以 tag 覆盖）。
3. `minAppVersion` 用 `requireApiVersion()` 校验；移动端遇 `isDesktopOnly` 用 `confirm()` 二次确认。
4. `getAllReleaseFiles()` —— 分别拉 `main.js` / `manifest.json` / `styles.css`。
5. `writeReleaseFilesToPluginFolder(id, files)` —— `vault.adapter.mkdir` + `write` 到 **`{configDir}/plugins/{id}/`**。
6. `addBetaPluginToList()` 记录到设置。
7. 若勾选 `enableAfterInstall`：`app.plugins.loadManifest(path)` + `enablePluginAndSave(id)`，然后 `loadManifests()`。

**repo 解析的实现比预期简单**：没有 `parseRepoString` 这样的通用解析器，只有 `scrubRepositoryUrl()`（字符串清洗）+ `AddNewPluginModal.isGitHubRepositoryMatch()` 里的正则 `^(?:https?:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+)$`。

> OBSync 的改进：把这两处合并成一个真正的 `parseRepoRef()`，能识别 `github.com` / `gitee.com` 的完整 URL、`owner/repo` 简写，并返回结构化 `{ host, owner, repo }`。

### 2.2 插件 vs 主题

完全分文件处理。主题走 `themes.ts`：拉 `raw.githubusercontent.com/.../HEAD/theme[-beta].css` + `manifest.json`，写到 `{configDir}/themes/{name}/`，更新判断用 **checksum（字符和）而非版本号**。

### 2.3 更新检查机制

**没有独立定时器。** 只在 `onLayoutReady` 后延迟 60 秒跑一次（主题是 120 秒），以及命令手动触发。遍历 `pluginList`，跳过冻结项（`version !== "latest"`），逐个 `addPlugin(update=true)`：读本地 `manifest.json` → `semver.coerce + compare` 判断是否有新版 → 有则只写文件 + `reloadPlugin()`（`disablePlugin` + `enablePlugin`）。

### 2.4 网络层

**全部走 Obsidian 的 `requestUrl`**，不用 fetch、不用 octokit。`githubUtils.ts` 的 `gitHubRequest()` 统一处理：加 `User-Agent`、捕获错误、解析 `x-ratelimit-*` 响应头，403 且 remaining=0 时抛 `GHRateLimitError`。

封装的方法：`isPrivateRepo`、`fetchReleaseVersions`（`?per_page=100`，**无翻页循环**）、`grabReleaseFromRepository`（releases 列表或 `releases/tags/{v}`，按 semver → 日期排序取首个，过滤 prerelease）、`grabReleaseFileFromRepository`（按 asset 名匹配，私有用 `asset.url`，公开用 `browser_download_url`）、`grabCommmunityPluginList`、`validateGitHubToken`（故意请求 404 端点，从响应头读 scope 与过期时间）。

**无回滚机制。** 只有前置校验（manifest 缺 version、main.js 为 null 则中止），`try/catch` 返回 `false`，不备份不还原。

> OBSync 的改进：写入前备份现有 `main.js`/`manifest.json`/`styles.css`，失败时还原。插件目录是用户的插件，覆盖坏了很麻烦。

### 2.5 设置模型

双列表：`pluginList: string[]`（repo 标识）+ `pluginSubListFrozenVersion: PluginVersion[]`（`{ repo, version, tokenName, isIncompatible }`）+ `themesList`。`addBetaPluginToList()` 负责去重写入。

### 2.6 i18n 方案（值得直接照搬）

`i18n/index.ts: getTranslations(language)` → `resolveLocale()` 做归一化与别名（`zh` / `zh-hans` / `zh-sg` → `zh-cn`），未命中回退 `en`。

关键设计：`locales/en.ts` 导出对象并定义 `type LocaleStrings = typeof en`；其他 locale 用 `satisfies LocaleStrings` —— **编译期强制全覆盖**，漏翻译直接报错。翻译键是嵌套业务对象（`settings.general.xxx.name` / `.desc`），插值用函数（`trackedVersion: (v, f) => ...`）。

零依赖、类型安全、加语言只需新增文件 + 注册。现有 locale：en / de / ja / zh-cn（zh-cn 覆盖 100%）。

### 2.7 命令与 UI

17 条命令（`ui/PluginCommands.ts`）：`AddBetaPlugin`、`checkForUpdatesAndUpdate`、`checkForUpdatesAndDontUpdate`、`updateOnePlugin`、`reinstallOnePlugin`、`restartPlugin`、`disablePlugin`、`enablePlugin`、`openGitHubZRepository`、`openCommunityPagePlugin`、`openGitHubRepoTheme`、`opentPluginSettings`、`GrabBetaTheme`、`updateBetaThemes`、`removeGraduatedFromBrat`、`updateGraduatedToStableAndRemove`、`allCommands`。

`GenericFuzzySuggester.ts` 是可复用的 `FuzzySuggestModal<SuggesterItem>`（支持 Shift/Ctrl+Enter 修饰）。

`SettingsTab.ts` 存在**新旧双渲染并存**（新的 `getSettingDefinitions()` 声明式 API 需 `requireApiVersion("1.13.1")`，旧的 `display()` 手写）。这是兼容包袱，OBSync 不复刻。

### 2.8 依赖与构建

运行时依赖**只有 `semver`**。devDeps 用 esbuild + biome（仅格式化）+ eslint + semantic-release。发版靠 `.releaserc.yaml` + `semantic-release-obsidian-plugin` 自动改 manifest 版本并发布资产。

### 2.9 可砍清单

`SettingsTab` 新旧双渲染、`Promotional`、verbose logging、per-repo token、`BratAPI` 调试接口、graduated 检测、主题支持（OBSync v1 暂不做主题）。

---

## 三、Gitee 平台差异（实测结论）

数据来源：`https://gitee.com/api/v5/swagger_doc.json`（官方 OpenAPI 规格，336KB，175 个接口）+ 真实接口调用验证。

### 3.1 与 GitHub 同构的部分（好消息）

Gitee 的 `Release` 对象**内联 `assets[]`**，每个 `AttachFile` 含 `id` / `name` / `size` / `browser_download_url`。

```
GET /v5/repos/{owner}/{repo}/releases?per_page=100&page=1&direction=desc
→ [ { id, tag_name, name, prerelease, created_at, assets: [ { name, size, browser_download_url } ] } ]
```

这与 GitHub 的 `assets[]`（`name` + `browser_download_url`）**结构一致**，解析逻辑可以共用，不需要为 Gitee 单独写一套 release 解析。

实测样例（`mindspore/mindspore`）：
```
{ 'tag_name': 'v0.1.0-alpha', 'name': 'v0.1.0-alpha', 'prerelease': False, 'assets': [...] }
assets count: 2
  { 'browser_download_url': '.../archive/refs/tags/v0.1.0-alpha.zip', 'name': 'v0.1.0-alpha.zip' }
```

### 3.2 必须处理的四个差异

**差异 1：releases 列表默认升序。**
规格中 `direction` 参数说明为"可选。升序/降序。不填为升序"，`page` 默认 1，`per_page` 默认 20（最大 100）。
GitHub 的 `/releases` 默认返回**最新在前**，Gitee 默认**最旧在前**。不显式传 `direction=desc` 会拿到最旧的版本 —— 这是一个会导致"装了 3 年前的版本"的静默 bug。

**差异 2：鉴权走查询参数。**
Gitee v5 的 `access_token` 是 **query 参数**（规格中 `in: query`），不是 `Authorization` 请求头。GitHub 用 `Authorization: token <t>` 或 `Bearer`。
影响：`IRepoHost` 不能把"注入鉴权"做成一个统一的请求装饰器，必须暴露为 provider 的方法（`authenticate(request)`）。

**差异 3：没有社区插件索引。**
Obsidian 官方的 `community-plugins.json` / `community-plugins-stats.json` 只有 GitHub 一份，Gitee 没有任何等价物。
影响：「浏览/搜索社区插件」功能只能覆盖 GitHub；Gitee 侧必须靠手动输入仓库地址，或依赖镜像发现。

**差异 4：多数插件在 Gitee 没有 release，且匿名读文件必须走网页通道。**

Gitee 上的 Obsidian 插件仓库绝大多数不发 release（Gitee 的 release 生态比 GitHub 弱得多）。所以安装器**必须有源码文件回退通道**。但这里有个反直觉的坑，实测才发现：

```
GET /v5/repos/{owner}/{repo}/raw/{path}?ref=...
→ 401  {"message":"登录失效，无权限访问该资源"}
```

**即使对公开仓库也返回 401** —— 这个 API 端点不接受匿名请求。所以匿名读文件只能走网页 raw 通道：

```
GET https://gitee.com/{owner}/{repo}/raw/{ref}/{path}
→ 302 → https://raw.giteeusercontent.com/{owner}/{repo}/raw/{ref}/{path}?metadata=...&signature=...
→ 200 + 文件内容
```

代价是网页通道**必须在 URL 里写出 ref**，不能像 API 那样省略并让服务端解析默认分支。因此不知道默认分支时，得先调一次 `GET /v5/repos/{o}/{r}` 取 `default_branch`（这个接口匿名可用）。

原版 BRAT 完全没有这条路径 —— 它假设 release 一定存在。

**差异 5：`html_url` 带 `.git` 后缀。**
`GET /v5/repos/{o}/{r}` 返回的 `html_url` 是 `https://gitee.com/mindspore/mindspore.git`，
而 GitHub 返回的 `html_url` 不带后缀。直接拿去展示会显示成带 `.git` 的怪链接，需要 strip。

### 3.3 其他可用接口

| 用途 | Gitee 接口 | 匿名可用 |
| --- | --- | --- |
| 仓库元信息（判断是否私有 / 默认分支） | `GET /v5/repos/{owner}/{repo}` | ✅ |
| release 列表 | `GET /v5/repos/{owner}/{repo}/releases?per_page=&page=&direction=desc` | ✅ |
| 最新 release | `GET /v5/repos/{owner}/{repo}/releases/latest` | ✅ |
| 按 tag 取 release | `GET /v5/repos/{owner}/{repo}/releases/tags/{tag}` | ✅ |
| release 附件列表 | `GET /v5/repos/{owner}/{repo}/releases/{id}/attach_files` | ✅ |
| 附件下载 | `GET /v5/repos/{owner}/{repo}/releases/{id}/attach_files/{file_id}/download` | 私有需令牌 |
| 文件内容（Base64 或 raw） | `GET /v5/repos/{owner}/{repo}/contents/{path}?ref=` | ✅ |
| raw 文件（API 通道） | `GET /v5/repos/{owner}/{repo}/raw/{path}?ref=` | ❌ **401** |
| raw 文件（网页通道） | `GET https://gitee.com/{owner}/{repo}/raw/{ref}/{path}` | ✅ |

Git 远端地址格式：HTTPS `https://gitee.com/{owner}/{repo}.git`，SSH `git@gitee.com:{owner}/{repo}.git`。
