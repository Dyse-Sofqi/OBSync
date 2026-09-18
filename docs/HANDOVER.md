# OBSync 交接文档

> **这是接手本项目的第一份必读文件。** 配套阅读：`docs/PLAN.md`（总体规划与阶段划分）、
> `docs/reference-analysis.md`（两个参考项目的源码分析）、`.workbuddy-ai/memory/`（历次工作日志）、
> **`docs/RELEASE.md`（发版清单 —— 要发版时照着走，别重新推导步骤）**。
>
> 最后更新：2026-09-17（新增主题支持：绑定 + 更新，含设置结构 v3 迁移；
> 顺带修掉一个「默认值被就地改写」的真 bug，见五点五节末尾。
> 同日追加：OBSync 自身的检查更新与更新 —— **只写文件、不重载自己**，见五点六节）
>
> 上一轮：2026-09-16（验收复查：修掉 2 个真 bug + 补 3 处降级 + 补回一个漏做的功能，
> 详见下方「验收复查记录」）

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
| 三：Git 同步（obsidian-git 复刻） | 🟩 代码与单测完成 | `bdd2861` |

> 阶段二之后按使用反馈持续增补（均已提交）：绑定库里已有的插件（`1a73339`）、
> 可用更新常驻徽标（`e9a0729`）、插件身份改用 manifest id（`3c4e660`）、
> 检查时机调整（`c5bc825`）。设置结构版本现在是 `SETTINGS_VERSION = 2`。
| 主题支持（绑定 + 更新） | ✅ 完成 | 见五点五节 |
| 四：打磨与发布 | ⬜ 未开始 | — |

### 验收复查记录（2026-09-16）

阶段二/三完成后做了一轮独立复查（不看实现者结论，只跑验证 + 读代码）。结论：
架构与文档质量都好，但**测试套件实际是红的**（10 个失败），且有几处"文档说做了、
实际没生效"的地方。已全部修复：

| 问题 | 性质 | 修复 |
| --- | --- | --- |
| `unstage` 的 HEAD 未出生回退**从未触发** | 真 bug：正则写的是 `could not resolve HEAD`，而 git 实际输出带引号 `could not resolve 'HEAD'` | `HEAD_UNBORN_RE` 容忍引号 |
| 9 个 git 用例超时 + 清理 EBUSY | 测试配置：本机进程创建 340ms，默认 5 秒超时不够 | `testTimeout: 30_000` + 清理带 `maxRetries` |
| release 资产下载失败直接判安装失败 | 真缺口：同一文件在源码通道可取，却因资产 CDN 抖动而整体失败 | `loadReleaseFile` 失败也回退源码 |
| GitHub raw 域名不可达时无退路 | 真缺口：国内 raw 常被阻断而 api 可达，两者可达性无关 | `readFile` 回退 contents API |
| live 测试长期飘红（Gitee 限流） | 测试质量：会训练人忽略失败 | 限流时**跳过**并提示配 `OBSYNC_GITEE_TOKEN` |
| `fileWebUrl` / `commitWebUrl` 是死代码 | 漏做的功能：PLAN 里规划的「在浏览器打开」没接上 | 新增 `remoteLinks.ts` + 2 条命令 + 文件右键菜单 |
| `registerView` 用了 `this.sync!` 且无平台守卫 | 潜在崩溃：移动端会解引用 undefined | 加守卫，仅桌面注册 |
| 文档写"整个套件 ~1.5s" | 文档失真 | 改为实测值（该文件单独 ~150s） |
| `auth.ts` 的验证边界模糊 | 文档没说清"验证到哪一步" | 明确区分已验证（config 传递 + git 发头）与未验证（Gitee 服务端接受度） |
| **22 处错误文案硬编码中文** | 真缺口：i18n 只保证 locale 之间结构一致，**管不住代码里直接写中文**。英文界面下会冒出中文错误 | 改成「类型码 + 参数」，文案集中在 locale；`Notifier` 支持功能模块注册翻译器 |
| **7 个 i18n 键写了却没接上** | 同上：`gitNotFound` / `missingManifest` / `missingMainJs` / `noReleaseFallback` / `sourceRelease` / `sourceRaw` / `installing` 全是死键 —— 正是"打算本地化但没接上"的证据 | 前 2 个接上；被取代的删掉；余下的保留待用 |
| **两处错误类型用错** | 真 bug：「没有上游分支」「游离 HEAD」都抛了 `GitNotRepoError`，提示语是「请先初始化仓库」—— 让用户去初始化一个已存在的仓库，**指错方向** | 新增 `NoUpstreamError` / `DetachedHeadError` |
| **鉴权失败被一律归为「令牌问题」** | 真缺口（与上一行同一类）：平台因**凭据用户名**不符而拒绝时，用户看到的是「请检查访问令牌是否有效」—— 去反复检查一个没问题的令牌。实测：Gitee 只接受 账号名 / `oauth2` / `gitee.com` 三种用户名，其余直接拒绝（见 `reference-analysis.md` 差异 6） | 新增 `GitCredentialUsernameRejectedError`，文案说清「令牌本身是有效的、这是插件配置错误」；`mapError` 加这条分类并排在鉴权判断**之前**（用例锁着顺序） |
| **「测试连接」报「同步配置可用」** | 过度承诺：该检查走 `ls-remote`，验不了推送路径，而 Gitee 的凭据用户名规则只在 push 路径执行。说成「配置可用」会让人以为推送也验过了 | 文案限定为「远端可读取」，并在通过时追加一句说明本次只验证了读取 |
| **资产 404 被当成「资产通道整体不可用」** | 真 bug：`pluginFiles` 里任何资产下载失败都置 `assetUnreachable = true`，于是后续文件被跳过资产通道。而 `main.js` 通常被 gitignore、源码通道取不到它 —— **一次本可成功的安装变成失败**（变异验证时失败信息正是 `missingRequiredFiles: "main.js"`）。代码注释本来就写着「传输层原因（不是文件不存在）」，是实现没做到 | 只有 `NotFoundError` 之外才算通道不可用；新增 `tests/features/pluginFiles.test.ts`（此前该文件**没有任何单测**） |
| **网络错误里的尝试次数不实** | 真 bug：`http` 的失败消息写死 `retries + 1`，而传输层失败会立刻 `break`（不重试）—— 于是日志里写着「failed after 3 attempt(s)」而实际只发了 1 次。排查网络问题时这会把人带去**找那两次不存在的重试**（实测在 live 测试输出里见过这句） | 改成数实际发出去的次数（`attemptsMade`）；新增 `tests/host/http.test.ts`（此前 `http.ts` 也**没有专门单测**） |
| **安装器的命令没有插件名前缀** | UX 缺口：同步命令叫「OBSync：立即同步」，安装器命令却直接用了弹窗标题（「添加插件仓库」）。Obsidian 用户按插件名搜命令，没前缀就搜不到 | 新增 `cmdAddRepo` / `cmdBindExisting` / `cmdCheckUpdates` / `cmdUpdateAll` / `cmdOpenSettings`；弹窗标题保持不带前缀 |
| **Gitee 的令牌会随错误消息漏出去** | 真问题（安全）：Gitee 的鉴权只能把令牌放查询串（`?access_token=`），而 `http` 把 URL 写进了错误消息与调试日志。那条消息有两个出口 —— `Notifier` 把它**弹在屏幕上**（用户截个图就带出去），`logger.error` 把它写进控制台（而用户报 issue 时贴的正是这个）。令牌存在系统密钥库里刻意绕开 `data.json`，却从这条侧路原样漏了；`repoRef` 的报错还会把用户粘进来的 `https://oauth2:TOKEN@…` 克隆地址原样回显 | 新增 `host/redact.ts`（`redactUrl`），在 `httpRequest` 的**每个** URL 出口上脱敏（含超时、重试日志、最终错误、底层错误详情），`repoRef` 回显输入前也过一遍；新增 `tests/host/redact.test.ts`，并给 `http` / `repoRef` 补上「不泄漏」用例（含一条「脱敏不能影响实际请求」的反向守卫） |
| **既是「令牌上屏」的另两条路，也是自相矛盾的 UI** | 真问题（安全）：① `SyncService.diagnose` 的 `detail` 会**渲染在设置页上**，而它带的正是远端地址原文 —— 库的远端本来就写着带令牌的地址时（用户从前配的），令牌直接显示出来；② 「远端已设置 …」的成功提示也回显整条地址；③ 更要紧的是**设计自相矛盾**：`auth.ts` 明确论证过不能把令牌写进 remote URL（会落进 `.git/config`、`git remote -v` 一眼可见、随配置文件泄漏，实测确认），而「编辑远端地址」弹窗对这样的地址**一句提示都没有**，默默照写 | 脱敏收口到 `diagnose` 的 `add()`（报告的唯一写入点）+ `main.ts` 的回显；弹窗新增凭据警告（`classifyRemoteUrl` 抽成纯函数，判定与渲染分离，第一次有测试）；新增 `tests/features/editRemoteModal.test.ts`、扩充 `syncService.test.ts` 与 `redact.test.ts` |
| **`data.json` 里的 `pluginId` 没查内容 → 卸载会删出插件目录** | 真 bug（路径逃逸）：`tracked[].pluginId` 最终会变成**路径的一截** —— 卸载时 `resolvePluginFolder()` 找不到同名目录就回落到 `{configDir}/plugins/{pluginId}`，紧接 `rmdir(folder, true)` **递归**删（路径算术与「真的发出这个调用」见 `tests/features/itemFolder.test.ts`）。而 `sanitizeTrackedPlugins` 只检查「是不是非空字符串」：`"../../evil"` 会拼出 `.obsidian/plugins/../../evil`。`data.json` 恰恰是这个字段**唯一**不经过 `parseManifest` 的来源（可手改，也会随笔记仓库同步到别的设备） | 抽出 `core/pluginId.ts`（`PLUGIN_ID_RE` / `isValidPluginId`）作为**单一事实来源**，`manifest.ts` 与 `settings.ts` 共用；新增 `tests/core/pluginId.test.ts`，其中两条是**防漂移**——「`parseManifest` 放行的，`normalizeSettings` 一个都不能丢」及反向 |
| **更新检查比安装路径「少做了两件事」→ 永远报「已是最新」** | 真 bug：`checkOne`（检查）本应是 `resolveSource`（安装）的镜像，却有两处退化。① **不带令牌** —— 私有仓库在未鉴权时两个平台都返回 **404**（刻意不泄漏「仓库是否存在」），检查把它读成「这个仓库没有 release」；② **不回退** —— `/releases/latest` 只给正式版，「只发预发布版」的仓库返回 404，而安装路径在这一级会往下看预发布版。两处症状相同：**装得上、却永远收不到更新提示**。附带代价：不带令牌走的是**匿名配额**（Gitee 极低，项目为此专门做过节流），等于自己制造那些 403 | `checkOne` 带上 `service.tokenForHost(plugin.host)`（新增带文档的公开出口），并在 404 后对齐 `resolveSource` 的第二级（`listReleases` 取首个）；`updateChecker.test.ts` +6，含两条反向守卫（令牌不串平台、没配令牌不造鉴权头）与一条「回退只在 404 后发生」 |
| **「有哪些平台」有 4 份副本，其中 1 份决定用户数据的生死** | 真缺口（漂移风险）：`SUPPORTED_HOSTS` 声明自己是平台列表，却**没有任何调用方**；同一个事实另写了三份 —— `settings` 的 `VALID_HOSTS`（持久化校验）、`secretStore.snapshot` 的循环、设置页的两个 `renderTokenField("github"/"gitee")`。第一份的后果不是「不好看」：**漏掉某个平台时，用户在那个平台上装的插件会在下次加载 `data.json` 时被当成非法条目无声丢弃**（不报错，列表里就没了）。而 `hostRegistry` 自己的注释写着「将来加 GitLab / Bitbucket 只需要在这里注册一项」—— 那句话不成立 | 平台列表移入 `host/types.ts` 并让 `HostKind` 由它**推导**（加平台 = 改那一行），三个使用点全部改为派生；`hostRegistry` 的注释改成「加平台要动哪些地方」的完整清单；新增 `tests/host/hostRegistry.test.ts`（5 条，让四个使用点互相印证而非各列一份平台名） |
| **重复实现里躺着的那一份是错的** | 真缺口：`InstallerService.checkForUpdate` 是「有没有更新」的**第二份实现**，无任何调用方，且判据用的是 `requestedVersion` —— 跟踪最新版的插件那个值是字符串 `"latest"`，于是它几乎恒返回 release。谁把它当成现成的工具接上，谁就得到一个**恒报「有更新」**的功能。同类还有 `isManifestCompatible`（兼容性判断的第二份），它声明的存在理由「注入 `requireApiVersion` 便于测试」已被 obsidian stub 的 `__setApiVersion` 取代 | 两处删除（其余死导出清点见第七节「死代码清点」） |
| **「启用笔记同步」是个死开关** | 真 bug（UX）：`sync.enabled` 有开关、`data.json` 里存着值、README 也列着它，而 `src` 里**没有一处读它**。于是用户关掉同步之后，自动提交照样每 N 分钟把笔记**推上远端** —— 他做了 UI 提供给他的那个动作，却没有任何效果。类型和测试都抓不到：类型上 `true` 也是 `boolean`；测试里 `Automatics` 直接注入设置对象、看不见装配层那一行（实测把 `enabled: deps.getSettings().sync.enabled` 改成 `enabled: true`，全量测试**全绿**） | `sync.enabled` 注入 `Automatics`，关掉时一个定时器都不起（边界照 `installer.enabled`：只管后台自动动作，不拦命令面板里的显式命令）；新增 `scripts/checks.mjs` 第 6 项「设置项无人读取」补上这个盲区 |
| **「自动提交间隔」少写了「并同步」** | 文案与实现不符：那一项到点执行的是**完整链路**「提交 → 拉取 → 推送」（与「立即同步」同一条），而界面只写「自动提交间隔」+「设为 0 表示关闭」。用户读到的意思于是变成「只提交」，会以为把「自动推送 / 自动拉取」设为 0 就能拦住网络动作 —— 拦不住。参考项目的原名是 `Auto commit-and-sync interval`，正是这三个字 + 解释 | 改成「自动提交**并同步**间隔」，说明文案写明整条链路与「即使推送/拉取间隔为 0 也会随它发生」；`Automatics` 里那条 `commit` 分支补注释，并用测试钉住「调的是 `sync()` 而不是 `commitAll()`」 |
| 设置页术语混用 | 「已追**踪**插件」（标签）vs「已跟**踪**的插件」（同页标题） | 统一为「跟踪」 |
| `autoCheckDelay` 的置灰状态不更新 | 小 bug：切换上面的开关后，下面的输入框还是灰的（`commit()` 不重绘） | 持有 `TextComponent` 引用，在开关回调里即时 `setDisabled` |
| **缺 README** | 发布件缺失（阶段四） | 新增中文优先的 `README.md` |
| **自动定时器的时间戳没按库隔离** | 真 bug：用原生 `globalThis.localStorage`（所有库共用一个存储区），于是 A 库的自动提交会影响 B 库的计时。参考项目 obsidian-git 专门写过迁移来修这个 | 改走 `app.saveLocalStorage` / `app.loadLocalStorage` |
| **`stop()` 挡不住 in-flight 的 `fire()` 重新起表** | 真 bug：`fire()` 跑完会重新起表，若期间 `stop()`/`restart()` 过，新起的会**覆盖 Map 里的记录**，先前那个再也 clear 不掉 → 同一动作每周期跑两次 | 引入世代计数器，`fire()` 回来时若世代已变则不再起表 |
| `main.ts` 的 `onload()` 无测试覆盖 | 风险：这正是「`addStatusBarItem` 挂错对象」那次真机才暴露的地方 | 新增 `pluginBoot.test.ts`（含变异验证） |
| 自动定时器无测试 | 计时类代码靠读代码很难确认对错 | 新增 `automatics.test.ts`（8 项，含两次变异验证） |
| **冲突未解决时「提交全部」会把冲突标记提交进历史** | **真 bug（数据完整性）**：冲突文件在 `git status` 里是 `UU`，**同时**算 staged 与 unstaged，所以 `dirty === 0 && conflicted.length === 0` 这个判断在有冲突时必然放行。触发路径很现实：上次冲突没处理 → 自动提交定时器到点 → `sync()` 第一步就提交了 `<<<<<<<` | `doCommitAll` 开头显式拦冲突并抛 `ConflictError` |
| **`isBusy` 的语义错了** | 真 bug：用布尔量实现，第一个任务 settle 时就置 false，而此时队列里第二个任务还在跑 —— 「忙」在真正有活干时报"空闲"。automatics 靠它决定跳过本轮，状态栏也靠它 | 改用计数器（排队中 + 执行中） |
| `sync()` 整条链路都显示「正在提交」 | 小 bug：只在开头 `setActivity` 一次，拉取与推送阶段显示的是错的状态 | 按阶段更新 |
| **视图里点按钮失败时界面毫无反应** | 真 bug：`SourceControlView.run()` 的 catch 注释写着"通知已由 service 完成"，但那只对「冲突」「没有远端」成立 —— 推送被拒、鉴权失败、git 缺失、网络问题全被**静默吞掉** | catch 里调 `notifier.reportError` |
| **冲突文件在变更列表里显示三次** | 真 bug（同一个 `UU` 根因）：同时进 staged 与 unstaged，再加单独渲染的 conflicted 行 | 抽出 `visibleChanges()` 过滤，并加测试 |
| **「编辑远端」只接受 GitHub / Gitee 地址** | 真缺口：同步是**纯 git 操作**，自建 GitLab / 内网 git / 本地裸仓库都能同步，却被"无法识别该仓库地址"拒之门外 | 改为宽松校验（只拦明显写错的输入）+ 非 GitHub/Gitee 时给**不阻断**的提示 |
| **「放弃当前合并」后毫无反馈** | 真缺口：`sync.mergeAborted` 这个键写了却从没接上。用户点了撤销类动作，库里的冲突标记消失了但界面一片安静 —— 会让人怀疑到底成没成 | `abortMerge` 成功后发提示 |
| 绑定弹窗的空状态 / 扫描中没有底部按钮 | 小缺口：只能按 Esc 或点弹窗外，与其他状态不一致 | 两个状态都渲染 footer |
| `AddRepoModal` 用笼统的「加载中…」 | 小缺口：`installer.resolving` / `installing` 两个键写了没接上，用户不知道卡在哪一步 | `busy` 改为阶段枚举，显示具体文案 |
| **跟踪列表不显示安装来源** | 小缺口：`installer.sourceRaw` 写了没接上。从源码装的插件更新检查查不到版本，用户会以为功能坏了 | 仅在 `channel === "raw"` 时显示来源（常见情况不加噪音） |
| **自动发现镜像后源地址从记录里消失了** | 真缺口：`host/owner/repo` 只有三个位置，镜像命中后就被镜像占了（下载与更新检查都走它，那是镜像的意义），而**用户填的源地址没有任何地方可放** —— 装完之后列表只显示 Gitee，用户看不出插件的家在 GitHub，也看不出 OBSync 在跟谁说话。修的时候还带出一条不显眼的规则：更新路径手里**没有**源地址（传进去的 `repo` 已经是镜像，而镜像发现要求 `ref.host === "github"` 不会再跑），不继承的话用户更新一次插件，GitHub 那一行就凭空消失 | `TrackedItem.origin` 记源地址（只在走了镜像时才有）；列表「源仓库一行 + 镜像另起一行」，第二行必须点明**下载走镜像**；`recordItem` 只在**来源没变时**继承 `origin`（与上一次的 ref 做 `isSameRepo` 比对 —— 无条件继承会让「同一个插件换个仓库装」显示上一个仓库的地址）；`sanitizeOrigin` 在读取侧兜住手改的 `data.json`（坏值只丢它自己，与主来源相同的值视为没写）。见 `tests/features/mirrorProvenance.test.ts` |
| **意外 HTTP 状态码漏出英文技术文案** | 真缺口：`host.requestFailed` 写了没接上。500/502/422 这类状态码会落到 `ObsyncError → err.message`，中文用户看到的是 `Unexpected HTTP 500 from ...` | 新增 `HttpStatusError`（带 status + 服务端说明），`describeError` 里加翻译分支 |
| **`statusMapper` 没有任何测试** | 测试盲区：一次变异验证打偏才发现的 —— 我把 `HttpStatusError` 换回 `ObsyncError` 后用例照样全绿，因为用例直接构造错误对象，没走映射路径 | 新增 `statusMapper.test.ts`（10 项，覆盖两个平台各自的限流表达方式） |
| 死键清理 | 25 个未被引用的 i18n 键：4 个背后是真缺口（见上），其余是通用词汇（保留）或设计上不该存在（`plugin.commandCategory` —— Obsidian 命令 API 没有分类字段；`settings.title` —— 被 `cmdOpenSettings` 取代） | 逐个分诊处理 |
| **资产 CDN 不可达时要白等三倍超时** | 真缺口（性能，且正好打在目标用户身上）：安装器逐文件回退，三个文件各试一次资产、各等一次超时；而 http 层还会重试 2 次 × 20 秒。合计 **约 3 分钟**才装完 —— 国内网络下这就是常态 | ① http 层**不再重试传输层失败**（确定性错误，重试只是把 20 秒变 62 秒）；② 安装器**记住资产通道失败**，后续文件直接走源码。合计降到 20 秒 |
| **`minAppVersion` 写低了（1.5.0，实际需要 1.8.7）** | 真 bug（发布阻断级）：`SecretStore` 调 `app.loadLocalStorage` / `saveLocalStorage` **没有兜底**，而这两个 API 是 `@since 1.8.7`。1.5~1.8.6 的用户装上后一用就 `TypeError` | `minAppVersion` → `1.8.7`；新增 `pnpm check` 自动校验 |
| 自查脚本散落在 gitignore 的 `.probe/` | 工程问题：写的时候有用，但不进仓库等于没有 | 移植成 `scripts/checks.mjs`，`pnpm check` 可跑，且 `pnpm build` 会先跑它 |
| **「从 Gitee 装只有源码的插件」这条验收标准从没被真正走通** | 测试盲区：`installerService.test.ts` 用 mock 的 host（验编排）、`giteeHost.test.ts` 验 host 单独工作 —— 两者都对，但**组合起来**的缝隙没人管 | 新增 `tests/features/giteeInstall.test.ts`：用**真实的 GiteeHost** 驱动完整安装流程 |
| **初始化仓库不建 `.gitignore`** | 真缺口：`init()` 只跑 `git init`。用户会把 `.obsidian/workspace.json`（面板/标签布局，**每开关一个标签就变**）同步出去，多设备必然冲突且没法手工合并 | 初始化时建一份默认的（已有则**绝不覆盖**，建不了也不让初始化失败）；另加「编辑 .gitignore」命令 |
| **同一个文件被重复计入**（三处） | 真 bug：`mapStatus` 按 `git status` 的两位状态位分别归类，「改了又暂存」的文件（`AM`/`MM`）同时进 `staged` 与 `unstaged`。于是 `{{numFiles}}` 多算、`{{files}}` 重复、**状态栏脏文件数虚高**、视图列表同一路径出现两遍 | 三处都改成**按路径去重** |
| **主题的大小写变体被当成两个主题**（身份键漏了归一） | 真 bug：主题的身份是**目录名**，而 macOS / Windows 的文件系统不区分大小写 —— 代码里另外三处都按这个口径办（`resolveThemeFolder` 找目录、`listInstalledThemes` 去重、`getActiveTheme` 判断当前主题），只有身份键 `availableUpdateKey` 是精确比较。后果不是「多一行」这么轻：两条记录指向**同一个目录**（更新其中一个等于更新两个），而徽标的键是 `<kind>:<id>` —— `theme:Minimal` 与 `theme:minimal` 是两条不同的记录，检查完只有一条会亮，用户看着两行一模一样的主题分不出哪行是真的。触发路径：`data.json` 随笔记仓库同步到多设备、或用户手改过目录名的大小写。`addTracked` 还自己就地写了一遍同样的比较，等于同一个判据两处各写一份 | `availableUpdateKey` 里按 kind 归一（**只归一主题**，插件不归一 —— `manifest.id` 有 `/^[a-z0-9-]+$/`，本来就不可能出现大写）；`addTracked` 改用它判重。两侧各有用例（写入侧 `themeService.test.ts`、读取侧 `settings.test.ts`），并额外钉住「两边刻意不对称」这条规则 |
| **插件在移动端会加载失败** | 真 bug（发布阻断级）：manifest 是 `isDesktopOnly: false`，但 `main.ts` **静态导入**了同步模块 → `simple-git` → 它在**模块初始化阶段**就 `require("child_process")` / `require("fs")`。移动端没有 Node，整个插件一启用就崩 —— 连纯 HTTP 的安装器都用不了 | `main.ts` 改用**动态 import**，推迟到 `Platform.isDesktopApp` 之后；`pnpm check` 加「移动端安全」守住这个不变式 |

> ⚠ **一处我自己的误判，记下来免得再犯**：判断 `minAppVersion` 时我最初用
> `grep -B6 "<成员>(" | grep -o "@since …" | tail -1` 取值，得到
> `addExtraButton → 1.11.0`，据此断言「1.5~1.10 会崩」。
> **实际是 0.9.16** —— `-B6` 的范围跨进了**下一个成员**的注释块，`tail -1` 取到的是它的
> `@since`。真正的问题在别处（`loadLocalStorage` 1.8.7）。
> 教训：**`@since` 必须和成员声明配对解析，不能用「附近最后一个」近似**。
> 现在 `scripts/checks.mjs` 是按类作用域配对的，不会再犯。

**验收标准速查**（详见 PLAN.md 第三节）：

- 阶段二 ✅：能从 GitHub 装真插件并启用；能从 Gitee 装只有源码没有 release 的插件；更新检查能识别新版本。
  > 关于 Gitee 那条：**找不到公开的 Gitee Obsidian 插件仓库**（`mirrors` 组织也没有、
  > 网页搜索页对匿名请求 405、API 搜索要么空要么被限流），所以改用
  > `tests/features/giteeInstall.test.ts` —— 用**真实的 GiteeHost** 驱动完整安装流程，
  > 响应形状按 Gitee 实测构造。它验证「GiteeHost 在安装器驱动下行为正确」，
  > 不验证「Gitee 服务端此刻可达」（后者归 live 测试）。
- 阶段三 🟩：本地闭环已由真实仓库单测覆盖（init/提交/拉取/推送/冲突/恢复）；
  **剩一项待实测**：对真实 Gitee 私有仓库的 `http.extraheader` 鉴权 push/pull
  （需要用户的令牌与真实仓库，单元测试只验证了配置构造）。
  > 2026-09-17 推进：鉴权链路的四段里，前三段已全部有实测依据
  > （config 构造 / git 的 `-c` / 真实 HTTP 头），Gitee 服务端校验该头也由 live
  > 测试确认；顺带查出并修掉了「用户名填 `git` 被 Gitee 拒绝」这个真 bug
  > （详见 `docs/reference-analysis.md` 差异 6）。剩下的只有令牌本身与账号策略。

## 三、命令与环境
```
pnpm dev        # esbuild watch + 自动部署到测试库
pnpm build      # 自查 + typecheck + 生产构建 + 部署
pnpm check      # 项目自查（见下），只读，约 0.2 秒
pnpm typecheck  # tsc --noEmit
pnpm test       # 单元测试（无网络，~2.5 分钟）
pnpm test:live  # 真实 API 测试（OBSYNC_LIVE=1，需网络）
```

### `pnpm check` 查什么（`scripts/checks.mjs`）

六项都是「编译器管不着、但会真出问题」的检查，每条都对应一个实际踩过的坑：

| 检查 | 防的是什么 |
| --- | --- |
| **minAppVersion 一致性** | manifest 承诺的最低版本必须覆盖代码用到的 API。写低了低版本用户装上就崩，而 TS 不提醒（类型包永远是最新版）。实测踩过：写着 1.5.0，实际需要 1.8.7 |
| **硬编码中文** | i18n 的编译期保证只管「locale 之间结构一致」，管不住「代码里直接写了一句中文」。实测扫出 22 处用户可见的错误文案 |
| **未使用的 i18n 键** | 死键是信号：通常是漏接的本地化或没接线的功能。实测 4 个死键背后都是真缺口 |
| **CSS 类覆盖** | 用了但没定义的类会静默丢样式；定义了没用的类是残留 |
| **移动端安全** | 从 `main.ts` 走一遍**静态**导入图，看有没有触及依赖 Node 的模块（`simple-git`）。移动端没有 Node，静态导入会让整个插件加载失败 —— 而这个**在桌面上测不出来** |
| **设置项无人读取** | 声明了、持久化了、设置页也能改，而**功能代码从不读** —— 用户改了它没有任何效果。实测踩过：`sync.enabled`（「启用笔记同步」）就是死开关，关掉之后自动提交照样把笔记推上远端 |

两张**带理由**的豁免表在脚本里（`KNOWN_SAFE` / `ALLOWED` / `NOT_A_CLASS` / `EXEMPT`）——
加条目时必须写清为什么安全，否则它们会变成掩盖问题的地方。
「设置项无人读取」的判据与它扫不到的两类写法，见第七节。

### 移动端：为什么同步模块必须动态导入

`manifest.json` 是 `isDesktopOnly: false`（安装器是纯 HTTP 的，移动端可用），
但**同步模块依赖 Node**。而 `simple-git` 在**模块初始化阶段**就
`require("child_process")` / `require("fs")` —— 静态导入会让整条依赖链在插件加载时
就初始化，移动端一启用就崩，连安装器都用不了。

所以 `main.ts` 用**动态 import**（`loadSyncModule()`）推迟到 `Platform.isDesktopApp`
之后。实测依据在 `scripts/verify-mobile-load.mjs`（`pnpm verify:mobile`）：把打包产物
放进一个「require 对 node 内置模块抛错」的环境里加载 —— 静态导入时以
`require is not defined: fs` 失败，改成动态 import 后不再抛错，且 esbuild 不产生
额外分块（仍然只有 `main.js`）。

这条不变式有两道防线：`scripts/checks.mjs` 的「移动端安全」（静态导入图，快）
+ 上面那个脚本（真实产物，发布前跑）。

> ⚠ 别改回 `require("./features/sync")`：Obsidian 桌面端能用，但测试环境是 ESM，
> `require` 不存在，启动测试会全部失败。（试过，踩了。）

- 部署目标 `F:/_Workspace/Plugin-Test/.obsidian/plugins/obsync`，
  环境变量 `OBSYNC_DEPLOY_DIR` 可覆盖，设空串跳过；部署失败只警告不中断构建。
- 测试库路径下可直接手测插件（Obsidian 打开该库）。
- 本机 shell 是 Git Bash（Windows），git 二进制可用（阶段三会用到）。

## 三点五、设置页结构

设置页分四个标签页（`src/settingsTab.ts`，自绘标签栏，Obsidian 的
`PluginSettingTab` 没有内建分页）：

| 标签 | 内容 |
| --- | --- |
| 已追踪插件 | 三个主操作按钮（添加插件仓库 / 绑定已有插件 / 检查全部更新）+ 跟踪列表 |
| 插件安装器 | 启用开关、更新检查时机、Gitee 镜像发现、**访问令牌**（GitHub / Gitee） |
| 仓库同步 | 同步开关、自动提交/推送/拉取间隔、提交信息模板、整合策略、gitPath |
| 通用 | 界面语言、提示开关、调试日志 |

选中项存在内存（`activeTab`），页内重绘或切换标签后不回弹到第一页；
切标签不会重复触发「进入设置页自动检查」。标签文案在 `settings.tabs.*`。

### 样式约定（`styles.css`）

1. **只用 Obsidian 主题变量**（`var(--text-accent)` 等），并给关键颜色写兜底值，
   这样在任意主题 / 深浅色下都不会出现读不清的文字。
2. **设置页规则一律限定在 `.obsync-settings` 下** —— `.setting-item-*` 是 Obsidian
   的全局类，不加作用域会污染其他插件的设置页（容器类在 `display()` 里挂上）。
3. 状态类信息（可更新 / 已冻结 / 令牌已配置）做成名称后的徽标药丸
   （`.obsync-badge*`），描述行只放事实信息。
4. 自查方式：**统一走 `pnpm check`**（`scripts/checks.mjs`，见第三节）。
   早先文档里写的 `npx esbuild styles.css --outfile=/dev/null` **在 Windows 上别用** ——
   `/dev/null` 会被当成真实路径，在仓库里建出一个 `dev/null` 文件（已踩过）。

## 四、代码地图

```
src/
├─ main.ts                 # 主类：只做装配。安装器已挂载；阶段三的 sync 模块也在这里挂
├─ settingsTab.ts          # 设置页：语言/host令牌/安装器列表/sync（阶段三加）
├─ core/                   # i18n（zh-cn 是规范源）、settings、secretStore、logger、notice
│  ├─ pluginId.ts          # 插件 id 判据（会成为路径的一截）
│  └─ themeName.ts         # 主题目录名判据 —— **不能**与上面共用（主题名有空格/大写）
├─ host/                   # ★ 双平台抽象层（脊柱）
│  ├─ IRepoHost.ts         # 统一接口；applyAuth 是接口方法（GitHub 用 header，Gitee 用 query）
│  ├─ githubHost.ts / giteeHost.ts
│  ├─ repoRef.ts           # owner/repo 解析（URL / 简写 / scp 形式）
│  ├─ http.ts              # requestUrl 封装：throw:false、重试退避（400ms*3^n）、20s 超时
│  └─ statusMapper.ts      # 状态码 → RateLimitError/AuthError/NotFoundError
├─ features/installer/     # 阶段二产出，见第五节（含 errors.ts：类型码 + 翻译器）
│  ├─ types.ts             # 判别联合：TrackedPlugin | TrackedTheme（另有 FILE_SETS / SUBDIR）
│  ├─ installFiles.ts      # 取文件：按「文件集 + manifest 解析器」参数化（原 pluginFiles.ts）
│  ├─ itemFolder.ts        # 目录读写：备份/写盘/回滚/删除（两种 kind 共用）
│  ├─ pluginFolder.ts      # 插件：目录定位（目录名≠id）+ enable/disable/reload
│  ├─ themeFolder.ts       # 主题：目录定位 + 非公开 API 守卫（当前主题/切换/重载）
│  ├─ existingPlugins.ts   # 绑定：扫描已装插件 × 官方插件索引
│  ├─ existingThemes.ts    # 绑定：扫描已装主题 × 官方主题索引（+ 手填仓库）
│  ├─ communityIndex.ts    # 官方索引的公共骨架（缓存/并发去重）+ communityRepoRef
│  └─ communityThemes.ts   # 官方主题索引（community-css-themes.json）
└─ features/sync/          # 阶段三产出，见第六节
   ├─ types.ts / errors.ts # 领域类型 + 按应对方式分类的错误（含 describeSyncError）
   ├─ gitManager.ts        # 抽象接口（含状态字符映射 mapStatusChar）
   ├─ simpleGitManager.ts  # simple-git 实现（状态映射/错误收口/reset 策略）
   ├─ auth.ts              # http.extraheader 注入（simple-git config 是字符串数组）
   ├─ remoteLinks.ts       # 「在远端打开」：凑齐 origin + 当前分支，拼网页地址
   ├─ commitMessage.ts     # 模板变量 {{date}}/{{hostname}}/{{numFiles}}/{{files}}
   ├─ syncService.ts       # 编排：串行队列 + commit→pull→push 链 + 冲突指南
   ├─ automatics.ts        # 自动定时器（剩余时间模型，时间戳存 localStorage）
   ├─ statusBar.ts         # 状态栏（由 service 显式驱动，不跑定时轮询）
   └─ ui/{EditRemoteModal,SourceControlView}.ts
```

## 四点五、错误与文案的归属（改错误路径前必读）

**规则：逻辑层抛「类型码 + 参数」，展示层拼「用户能看懂的话」。**

原因很实际：`manifest.ts` / `pluginFiles.ts` / `pluginFolder.ts` / `simpleGitManager.ts`
都是**纯逻辑**，拿不到 `t`，也不该依赖 i18n。早期实现图省事，把中文文案直接写进
错误的 `message`，而 `Notifier` 对 `ObsyncError` 是原样返回 —— 于是**英文界面下冒出中文**。
（当时还留下 7 个写了却没接上的 i18n 键，正是"打算本地化但没接上"的证据。）

现在的做法：

| 层 | 做什么 | 在哪 |
| --- | --- | --- |
| 逻辑层 | 抛 `InstallerError({ kind, ...params })` / 领域错误类型；`message` 只放**技术性描述**（英文，进日志） | `features/installer/errors.ts`、`features/sync/errors.ts` |
| 注册 | 各模块在 `createXxxModule()` 里 `notifier.registerErrorTranslator(...)` | `features/*/index.ts` |
| 展示层 | `Notifier.describeError()` 按类型/类型码取 locale 文案 | `core/notice.ts` |

两个设计点值得保持：

1. **可辨识联合 + `switch` 穷尽检查**（`InstallerErrorDetail`）。新增一个类型码却忘了
   加文案，`describeInstallerError` 里的 `const exhaustive: never = detail` 会**编译报错**。
   这是"漏翻译留到运行时"的解药。
2. **`Notifier` 用注册制而不是 `import` 各功能的错误类型** —— `core/` 不该知道任何
   `features/` 的东西。功能模块自己把「错误 → 文案」的映射交上来。

**自查手段**：统一走 **`pnpm check`**（`scripts/checks.mjs`，见第三节）。
早先这几项检查是我在 `.probe/`（gitignore）里写的 Python 脚本 ——
写的时候有用，但**不进仓库等于没有**，所以移植成了项目内的 Node 脚本，
并由 `pnpm build` 自动执行。想加豁免条目就改脚本里的 `KNOWN_SAFE` / `ALLOWED`，
**必须写清理由**，否则那两张表会变成掩盖问题的地方。

测试约定：**断言错误的类型码，不要断言消息文本**。文案来自 locale，改文案不该让测试变红。
助手见 `tests/helpers/expectInstallerError.ts`。



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
  资产下载**失败**（不只是"不存在"）也回退 —— 资产 CDN 在国内经常不可达。
- **更新检查必须与安装同源**（`updateChecker.checkOne`）：它取「最新版本」的方式
  要与 `resolveSource` 一致，否则会出现「装得上但永远说已是最新」。两处已对齐 ——
  凭据（都带用户的令牌）与回退（正式版取不到时同样看预发布版）。
  **改这两条路时要一起改**，这是个容易漏的不变式。
  `styles.css` 是可选文件，任何失败静默跳过（包括网络错误）。
  > 注意「记住资产通道不可用」的判定边界：**只有传输层失败**（网络/超时）
  > 才跳过后续文件的资产通道；**404 不算** —— 那只是这一个资产的问题
  > （私有仓库的 `browser_download_url` 本来就会 404），把它也算上会让
  > 后面的文件被无谓跳过，而 `main.js` 通常被 gitignore、源码通道取不到它，
  > 于是一次本可成功的安装变成失败。锁这条性质的是
  > `tests/features/pluginFiles.test.ts`（双向变异都验过）。
- **写入前备份 + 回滚**（`pluginFolder.ts`）：先快照进内存，写失败整体还原。
  回滚也失败时报错让用户手动检查。BRAT 没有这套机制。
- **单一跟踪列表**（`types.ts` 的 `TrackedPlugin`）：不复刻 BRAT 的双平行列表。
  settings 加载时会做结构校验（`sanitizeTrackedPlugins`），坏条目直接丢弃。
- **更新检查与执行分离**（`updateChecker.ts`）：**没有任何自动安装**。
  两个自动**检查**时机：
  1. 启动后延迟 N 秒（`autoCheckOnStartup`，**v2 起默认关闭**）；
  2. 打开 OBSync 设置页（`autoCheckOnSettingsOpen`，默认开启，
     由 `display`/`hide` 区分「打开页签」与「页内重绘」，并有 10 分钟节流
     `SETTINGS_OPEN_CHECK_INTERVAL_MS` + 持久化的 `lastUpdateCheckAt`）。
  执行更新永远手动：命令「更新全部插件」、行上的 ⬇ / ↻ 按钮。
  冻结项（`frozen`）**不参与任何检查**，因此也不会进入「更新全部」的集合
  （文案已修正为「不参与更新检查」——产品里没有自动更新）。
  检查结果持久化在 `installer.availableUpdates`（pluginId → 新版本 + 时间），
  已跟踪列表据此渲染**常驻徽标**（整行高亮，Notice 一闪就错过）；
  安装/更新成功后由 `recordInstalled` 清除，normalizeSettings 会剪掉
  已不在跟踪列表的条目。检查失败保留旧记录（过期信息好过没有），
  但 `lastUpdateCheckAt` 照常刷新（限流期间不要反复重试）。
- **镜像发现**（`mirrorFinder.ts`）：用两边 manifest 的 `id` 二次校验，
  同名不同项目直接放弃 —— 装错比找不到严重。默认关闭
  （实测抽样 40 个社区插件命中 0 个），且全程走 raw 通道零 API 配额。
  > **命中之后两个地址都要留着**（`TrackedItem.origin`）：`host/owner/repo` 记的是
  > **实际使用**的来源（镜像），源地址另存一份，列表才会「源仓库一行 + 镜像一行」。
  > 拿到「实际来源」一律走 `types.ts` 的 `itemRepoRef()`，**不要**读 `origin` ——
  > 检查、下载、重装必须同源，读 `origin` 会让它们分叉（见缺陷表里那条）。
  > 主题**不做**镜像发现：那套校验靠插件 manifest 的 `id`，主题没有 id。
  >
  > **镜像必须由用户确认才会被采用**（`mirrorSuggestions` → `ConfirmMirrorModal` →
  > `confirmMirror`）。发现只把候选记进 `installer.mirrorSuggestions`（键 `<kind>:<id>`），
  > 列表把地址列出来 + 一个 `git-compare` 按钮，弹窗里同时给出**两个地址**与三段警告
  > （判据有多弱 / 绑错的代价 / 怎么自己核对），点了「改用镜像」才改写记录。
  > 理由：判据只有「两边 manifest 的 id 相同」，那只证明是同一个插件，**证明不了**
  > 同一份代码、同一个作者、跟得上源仓库 —— fork 或用同一个 id 重新上传都能过，
  > 而候选地址常常是**猜**出来的（同名 owner / 你 Gitee 账号名）。插件又能读写整个库。
  > 安装弹窗里同样默认**不勾**镜像开关，并会明说「检测到但没用」。
  >
  > **「有没有用镜像」现在看得见**：安装弹窗的开关与那句「检测到疑似镜像但默认不用」、
  > 列表里「疑似镜像 · 尚未使用，待确认」那一行、确认后的「已在使用」镜像行、
  > 以及每次下载/更新提示里的来源（`downloadSource.ts`，命中时为「Gitee 镜像」）。
  > 仍然存在的盲区只有一条：
  > 1. **候选 owner 有两个**（`findGiteeMirror` 收的是候选列表，按可信度排序）：
  >    ① GitHub 上的 owner（同名，最可信）；② **你 Gitee 令牌所属账号的账号名**
  >    （`GET /v5/user`，只在成功时缓存 —— 用户中途补令牌也能立刻生效）。
  >    第二个候选是必须的：镜像**常常挂在作者自己的 Gitee 账号下，而账号名与
  >    GitHub 上的 owner 不同名**。实测 2026-09-19：`github.com/Dyse-Sofqi/MDRazor`
  >    的镜像是 `gitee.com/sofqi/MDRazor` —— 旧实现只探同名，于是「明明有镜像却
  >    一直走 GitHub」，GitHub 不通时（`net::ERR_CONNECTION_RESET`）只能降级到源码通道。
  >    没填 Gitee 令牌就拿不到账号名，那就只探同名那一个（不靠猜）。
  > 2. **绑定进来的条目从不做镜像探测**（`bindExisting` 直接写记录），要等到
  >    第一次更新时才会探（更新路径会探）。所以「刚绑定就看不到镜像行」是正常的，
  >    不是显示坏了；真在意的话点一次「更新」。
- **绑定已有插件**（`existingPlugins.ts` + `ui/BindExistingModal.ts`）：
  扫描 `{configDir}/plugins/`（以磁盘为准，能发现刚手动拷入的插件），
  用官方社区索引按**manifest id** 反查来源仓库 —— manifest 规范里没有 repo 字段，
  这是唯一权威映射；注意 id 不能用目录名代替（见第七节第 9 条）。
  索引外的插件（PKMer 等非官方渠道分发的中文插件）标记「来源未识别」，
  留给手动添加。绑定只写跟踪列表不动文件。入口：设置页按钮 + 命令。
  实测测试库 32 个插件：24 个可识别，8 个确实不在官方索引
  （pkmer / trefoil / bewater / qimen / lyricflux / Enhanced-editing 等）。
- **社区插件索引**（`communityPlugins.ts`）：GitHub 独有资源，Gitee 无等价物。
  6 小时缓存；统计文件可选；7685 条实测；`byId()` 供绑定功能反查。

## 五点五、主题支持（安装器的第二类对象）实现要点

主题与插件共用**同一条安装/更新链路**（`installFiles.ts` + `itemFolder.ts` + `InstallerService`），
只在两处分叉：**身份从哪来**、**写完之后的动作**。改这块前先读下面四条。

### 身份：目录名，不是 manifest

主题**没有 id 字段**，身份就是 `{configDir}/themes/` 下的**目录名**
（`app.customCss.setTheme()` 收的也是它）。这与插件「身份一律以 manifest 为准」正好相反：

- `TrackedBase.id` 对插件是 `manifest.id`，对主题是目录名 —— 名字一样，语义由 kind 决定；
- 更新永远写回**记录的那个目录**（`resolveThemeFolder` 精确匹配 → 大小写不敏感兜底 →
  默认落点），**绝不**按远端 manifest 的 `name` 改名（改名等于换一个主题）；
- 校验用 `core/themeName.ts` 的 `isValidThemeName`，**不能**套 `PLUGIN_ID_RE`
  （那会把 `Minimal`、`Blue Topaz` 之类的真实主题名全判非法，症状是「一个都绑不上」且无提示）。

### 更新判据：版本号 + 一级回退

与插件同构（远端版本 vs 本地已装版本），但**没有 release 时读默认分支的
`manifest.json`**（`updateChecker.checkTheme`）。插件那边停在「无从比较」是配额考虑；
主题的生态就是「只推仓库、不发 release」，不读这一级就永远收不到更新提示。

> 实测三份流行主题都带 version：Minimal 9.1.0 / Things 2.2.4 / AnuPpuccin 1.5.0，
> Minimal 还有 21 个同名 release。「主题不写版本号」是误传（混淆了社区索引的字段）。

已知边界：作者不升版本号却在改 CSS 时会漏报。这是「与插件一致」的那套语义，不是缺陷。

### 非公开 API 清单（都做了兜底）

公开 `obsidian.d.ts` 里 `customCss` 出现 **0 次**，`pnpm check` 的 minAppVersion 自查
扫不到它（`CustomCss` 不在 `WATCHED` 名单里，且这些成员没有 `@since` 标注）——
**所以这一块的人为核查不能省**：

| 用途 | 调用 | 兜底 |
| --- | --- | --- |
| 读当前主题 | `customCss.getTheme()` → `customCss.theme` → `vault.getConfig("cssTheme")` | 三级都失败返回 `undefined`（**与默认主题的空串区分开**） |
| 刷新观感 | `customCss.requestLoadTheme()` | 失败只记 debug（文件已写好，不该报成更新失败） |

`setTheme` **没有**收进这个窄接口，因为没有任何地方该替用户换主题：更新时不碰当前选择，
取消绑定又不删文件（见下条）。读当前主题只为一件事 —— 判断「更新的正是它吗」，
是则请求一次重载，否则连重载都不做。

### 移除 = 取消绑定（2026-09-17 改）

列表里的那个按钮以前是 `uninstall`：禁用插件、`rmdir(folder, true)` 递归删掉整个目录，
主题还先把正在使用的那个切回默认。**这越界了** —— 跟踪列表记的是「我在跟哪个仓库」，
而插件 / 主题的安装与移除归 Obsidian 自己管（设置里的「已安装插件」与「外观」）。
对**绑定**进来的对象尤其糟：用户从官方商店装好之后让 OBSync 认下它，点「移除」时想表达的
几乎一定是「别再跟了」，却换来了不可逆的删除。

现在 `InstallerService.unbind` 只做两件事：从跟踪列表里去掉、清掉它的更新徽标。
于是：**不删文件、不改启用状态、不切主题、也不需要二次确认**（动作可逆，与「绑定」那侧对称）。
按钮图标随之从 `trash` 换成 `unlink`，文案写明「不删除文件」—— 用户对「移除 = 卸载」
有惯性，不写清楚会以为功能坏了。要真删文件，去 Obsidian 自己的界面删。

连带删掉的东西：`themeFolder.detachThemeIfActive`（连同它的四种返回状态）、
`removeConfirm` / `removeConfirmTheme` / `themeRevertedToDefault` / `themeDetachUnconfirmed`
四个 i18n 键。**递归删除现在只出现在回滚路径上**（`restoreBackup`），
而 `sanitizeTrackedItems` 的路径校验仍然必要 —— 主题的更新回滚用的正是 `tracked.id`。

### 设置结构 v3 与两处顺带修的坑

- `SETTINGS_VERSION = 3`：v2 → v3 迁移要给老条目补 `kind: "plugin"`、把 `pluginId`
  改名为 `id`、把 `availableUpdates` 的键换成 `<kind>:<id>`。**漏掉字段改名会让
  `data.json` 被清空**（sanitize 按 `id` 取值，拿不到就整条丢弃）—— 已有用例钉住。
- 顺带修掉一个真 bug：`mergeWithDefaults` 只做浅拷贝，「磁盘数据里缺这个键」时
  直接把默认值本身放进结果，于是运行时的写入会**就地改写模块级 `DEFAULT_SETTINGS`**
  （症状：删掉的条目又回来、全新库凭空多出跟踪条目）。现在所有默认值都过 `cloneDefault`。
- 顺带清掉一个死导出：`isPluginInstalled`（只被测试用过，`readInstalledManifest` 覆盖同一件事）。

## 五点六、OBSync 更新自己（2026-09-17）

设置页「安装器」页最后有一节「OBSync 自身」：当前版本 + 检查更新 + 更新到最新 + 一行状态。
实现在 `features/installer/selfUpdate.ts`（坐标与状态文案）、`updateChecker.checkSelf`
（查）、`installerService.updateSelf`（写）。

### 为什么它不在跟踪列表里

跟踪列表是「**用户装了什么**」的清单，每一项旁边挂着冻结 / 取消绑定这类操作 ——
对自己没有意义。所以它单独一节，而绑定列表也跳过自己（`SELF_PLUGIN_ID`，与
`manifest.json` 的 `id` 必须一致）。

### 更新只写文件，**不重载自己**（这块的核心取舍）

别的插件更新完是 disable → enable；对**自己**则是**先卸载正在执行这段更新代码的
实例**，剩下半段靠闭包才活着 —— 能成也是靠副作用成功，中途失败就停在「已禁用」，
而来得及提示你的代码已经不在了。

所以 `updateSelf` 只做三件事：写盘（失败整体回滚）、把版本号记进
`installer.pendingRestartVersion`、提示用户重启。**不碰启用状态、不记跟踪列表。**

于是有一段「磁盘上是新版、运行中是旧版」的窗口，这段时间必须如实告知，否则用户
以为已经在用新版本：

- 设置页那一行常驻显示「已下载 x，重启 Obsidian 后生效」（`describeSelfState` 里
  **「待重启」压在检查结果之上**）；
- 标记在**每次加载时清空**（`main.ts` 的 onload 调 `clearPendingRestart`）——
  既然加载成功了，跑的就是磁盘上那份；不清的话用户重启完还会看到「重启后生效」。
- 检查用的是**运行中**的版本（参数传进去），不是磁盘那份 —— 拿磁盘那份比会得出
  「已是最新」，而用户此刻跑的不是它。

### 两道守卫与一条放宽

| 规则 | 为什么 |
| --- | --- |
| 远端 manifest 的 id 必须是 `obsync` | `SELF_REPO` 是写死的常量（manifest 没有 repo 字段），万一指错地方，按错的 id 解析目录会**覆盖别的插件** |
| 不允许降级（远端比当前旧就中止） | 「更新」不该把用户降回旧版本 |
| 允许**同版本重装** | 把一个坏掉的安装修回来是合理需求 |

### 两条已知边界

- **只能吃 release 资产**：`main.js` 是构建产物（在 `.gitignore` 里），源码回退通道
  取不到它 —— 资产 CDN 不可达时自我更新会以 `missingRequiredFiles` 失败并回滚。
  没有 release 时检查如实报「无从比较」（`checkSelf`）。
- **另一条更稳的路是官方的**：插件发布到社区市场后，Obsidian 自带的更新入口
  也走 disable → enable，但那是官方支持的路径。本节的入口服务的是「没上架 /
  开发期」这段。

---

## 六、同步模块（阶段三）实现要点
文件都在 `src/features/sync/`。

**鉴权**（`auth.ts`）：远端是 GitHub/Gitee 且 secretStore 里有令牌时，通过
simple-git 的 `config` 选项（字符串数组，逐项 `-c key=value`）给每条命令注入
`http.extraheader=Authorization: Basic base64(user:token)`，不落盘、不进 remote URL。
simple-git 实例按「远端 URL + gitPath」缓存，`setRemoteUrl`/设置变更后重建。

> 验证边界（`tests/features/authWire.test.ts` 里也写了）：
> - ✅ simple-git 的 `config` 数组 → git 命令行的 `-c`（测试：让 git 在同一次调用里读回该配置）
> - ✅ git 把该配置变成 HTTP 的 `Authorization` 头，且**在第一个请求就带上**、
>   不等 401 挑战（`tests/features/authHeader.test.ts`：本地 HTTP 服务器实测
>   `/info/refs?service=git-upload-pack` 已带正确头）
> - ✅ **Gitee 服务端确实读取并校验这个头**（`tests/live/giteeGitAuth.live.test.ts`，
>   2026-09-17 实跑通过）：带伪造凭据会被拒（401 挑战），不带凭据可匿名读公开仓库。
>   两条同时成立才说明机制有效 —— 若 Gitee 忽略该头（当匿名请求处理），
>   公开仓库照样能读成功，那就说明这个机制在它这里不成立。
> - ✅ **用户名必须用 Gitee 认的值**（查出来的一个真 bug，见
>   `docs/reference-analysis.md` 差异 6）：Gitee 只接受 账号名 / `oauth2` /
>   `gitee.com`，之前填的 `git` 会被服务端**直接拒绝**。现在由
>   `IRepoHost.gitAuthUsername` 声明（Gitee → `oauth2`、GitHub → `x-access-token`）。
>   这条单测发现不了 —— 我们构造出的 Basic 头本身合法，不合法的是对端接不接受。
> - ✅ **有效令牌在真实私有仓库上被接受**（`tests/live/privateRepoAuth.live.test.ts`，
>   需 `OBSYNC_LIVE_PRIVATE_REPO` + 令牌，未配置则整组跳过）。
>   结构是「对照组（不带凭据必须失败）+ 接受（带令牌必须成功）」——
>   缺了对照组，「成功」什么也证明不了。
>   2026-09-17 用 GitHub 私有仓库实跑通过；Gitee 那边配上令牌即可同一条命令跑完。
> - ❌ **有效的 Gitee 令牌是否被接受** —— 需要真实 Gitee 令牌与私有仓库
>   （我没有 Gitee 令牌，只有 GitHub 的）。这是 PLAN.md 风险表第一条，
>   也是**目前唯一剩下的待实测项**。跑法见上面那条 live 测试的文件头。
>   注意：**「测试连接」发现不了用户名问题** —— 它走 `ls-remote`（fetch 路径），
>   而 Gitee 的用户名白名单只在 **push 路径的服务端钩子**里执行（实测：用伪造令牌
>   打 fetch 端点时，`git` / `oauth2` / 随机串返回完全相同的通用 401）。
>   所以这条必须靠一次真实 push 收尾；失败的回退方案是 askpass 弹窗
>   （obsidian-git 的做法，见其 simpleGit.ts:249）。

**pull 三态**（`simpleGitManager.ts`）：先 fetch、比较本地/远端引用（照搬
obsidian-git 验证过的形态），merge/rebase 直接整合；**reset = stash 保护（含
未跟踪）+ `reset --hard`**。注意 obsidian-git 的 reset 用的是 update-ref +
普通 reset，会让工作区与 HEAD 脱节、下次提交把远端改动倒推回去 —— 我们刻意
不用那套。

**冲突哲学**：不自动解决。merge/rebase 冲突 → 抛 `ConflictError` →
syncService 在库根目录写《OBSync 冲突指南.md》（冲突文件清单 + 处理/放弃指引）
→ **sync 链路立即停止**（继续提交会把冲突标记写进历史，继续推送会推上远端）。
恢复出路：手动解决后「立即同步」，或「放弃当前合并」（abortMerge）。

**并发**（`syncService.ts`）：所有动仓库的操作走一条 promise 串行队列；
`isBusy` 供自动定时器判断「跳过本轮」。sync 链路：提交 → 拉取 →（拉到东西就
再提交一次）→ 推送；推送前检查远端是否存在、ahead 是否 > 0。

**自动定时器**（`automatics.ts`）：照 obsidian-git 的剩余时间模型 ——
每次执行把时间戳写 localStorage，启动时按 `间隔 - 已流逝` 起表，
重启不重置周期；间隔 0 = 关闭，错过不补跑。

**状态栏**：由 service 在动作前后显式驱动（不跑轮询），展示
分支 / ↑ahead ↓behind / ~脏文件数 / ⚠冲突数。条目挂在状态栏**最左侧**、
其余条目留在原位 —— 靠 CSS 实现（`styles.css` 的 `.status-bar` 拉全宽 +
`.obsync-status-bar-item` 的 `order: -1` / `margin-right: auto`），**不碰 DOM**。
别改成 `prepend`：状态栏是「收缩到内容宽 + 靠右下」的，按 DOM 顺序把它插到
最前会把别人的条目整体右移一个条目的宽度（实测 1280 视口下 130px，用户当场
发现「其他图标全被挤走了」）。

**连接测试**（`syncService.diagnose()` + 设置页「仓库同步」页底部）：
一条递进的检查链 —— git 可执行文件 → 是否 git 仓库 → 有没有远端 →
平台能否识别（决定能否注入令牌）→ **真的 `ls-remote` 连一次**。
任何一步失败就停（后面依赖前面的前提）。

存在的理由：**鉴权配得对不对，光看设置项判断不了** —— 令牌填了不代表有效，
仓库是私有的才知道。只有真的连一次才有答案。

两个设计点：
- 结果是**结构化**的（`DiagnosticCheck { id, status, detail }`），文案由设置页按
  `id` 取 locale。所以 `diagnose()` 不依赖 i18n，可以单独测。
- 「平台认不出」与「没配令牌」都标成 `skipped` 而**不是 failed** ——
  它们只意味着注入不了令牌，用户仍可走系统凭据助手；报成失败会误导人去改一个
  没问题的配置。
- `testRemoteAccess()` 用 `ls-remote` 而不是 `fetch`：**只读**，不动 refs / index。
  这条性质有测试锁着。

**命令**：立即同步 / 提交全部 / 推送 / 拉取 / 初始化仓库 / 放弃当前合并 /
编辑远端 / **编辑 .gitignore** / 打开源码控制视图 /
**在浏览器中打开当前文件** / **在浏览器中查看当前文件的历史**。
后两条同时挂在文件右键菜单上（「在远端打开」「在远端查看历史」）。
设置页新增：拉取整合策略（三态下拉）、gitPath、**连接测试**。

**初始化仓库时会顺带建 `.gitignore`**（`syncService.initRepo()`）：

`.obsidian/workspace.json` 存的是面板与标签布局 —— **每开关一个标签它就变**。
多设备同步它必然冲突，而且冲突内容是整份 JSON，用户根本没法手工合并。
这是 Obsidian 同步最常见的坑，但用户不会预见到，等冲突发生了再处理成本高得多。
所以初始化时顺手挡掉，并明确告知建了什么（不偷偷摸摸）。

**已有 `.gitignore` 时绝不覆盖** —— 用户可能有自己的规则（实测用户的测试库里
就有一份别的同步插件建的）。建不了也不让初始化失败，只是少一层保护。
模板整段放在 locale 的 `sync.gitignoreTemplate` 里（它含面向用户的说明文字）。
另有「编辑 .gitignore」命令，不存在就先按同一份模板建出来 ——
空文件没法教人该忽略什么。

> 「在远端打开」的实现要点：URL 模板在 host 层（`repoRef.fileWebUrl` /
> `fileHistoryWebUrl`），`remoteLinks.ts` 只负责凑齐「origin 的 RepoRef + 当前分支」。
> 两个平台的网页路径格式一致，所以**没有平台分支** —— 这正是把
> `openInGitHub` 的硬编码正则抽象掉之后该有的样子。
> 拿不到远端 / 远端不是 GitHub 或 Gitee / 仓库还没有提交时，
> 给可行动的提示而不是打开一个必然 404 的地址。
> 路径逐段编码（`encodePathSegments`），中文文件名与空格不会截断链接。

**v1 有意不做的**（obsidian-git 有，但 PLAN.md 范围外）：逐文件 hunk 级暂存、
diff 查看、树形文件视图、squash、子模块、行作者/blame。GitManager 接口里
分支管理原语已备好（listBranches/checkout/createBranch/deleteBranch），
视图里有分支下拉，够用。

### simple-git 的实测坑（改 sync 层前先看）

1. `SimpleGitOptions.config` 是**字符串数组**（逐项 `-c`），不是对象；
   且 `simpleGit(options)` 收 `Partial<SimpleGitOptions>`。
2. `git.log({ max: n })` 会把 `--max=n` 原样传给 git 报错 —— 正确的键是
   `maxCount`（映射为 `--max-count`）。
3. **空仓库 commit 不抛错**：返回 `summary.changes === 0` 的摘要，要自己判断。
4. HEAD 未出生（无任何提交）时 `git restore --staged` 报
   "could not resolve HEAD"，等价做法是 `git rm --cached`（unstage 已做回退）。
5. 无提交的仓库 `git branch` 输出为空 → `branchLocal()` 的 current/all 为空。
6. push 不会更新裸仓库的 HEAD（clone 出来的分支取决于它）——测试环境要手动
   `symbolic-ref HEAD refs/heads/main`。
7. 测试机全局 `core.autocrlf=true`：检出的内容是 \r\n，测试断言要归一。
8. **`addStatusBarItem()` 在 `Plugin` 类上，不在 `app.workspace` 上** ——
   猜错位置会直接 `TypeError`（真实启动时才暴露，stub 造不出这种差异）。
   现状：状态栏元素由主类 `this.addStatusBarItem()` 创建后经 SyncDeps 传入。
9. **插件目录名不保证等于 manifest id**（实测测试库 32 个插件里 5 个错位：
   `MDRazor/`→`md-razor`、`obsidian-commander/`→`cmdr`、`obsidian-pkmer/`→`pkmer`、
   `obsidian-plugin-manager/`→`plugin-manager`、`obsidian-style-tuner/`→`style-tuner`；
   手动解压 release 或别的安装器用仓库名建目录所致）。
   所以：**插件身份一律用 manifest id**（查社区索引、查启用状态、写跟踪记录），
   **目录只用于定位文件**（`pluginFolder.resolvePluginFolder` 按 id 反查真实目录，
   否则更新会新建出第二份同 id 安装）。按目录名查索引会漏掉 5/32 的插件 ——
   曾表现为「明明上了官方市场却提示来源未识别」。
   另外 `loadManifest` 要目录、`enablePluginAndSave` 要 id，两者别混用。
   顺带观察：同一 id 可能存在于多个目录（旧 id 的残留安装），扫描时按 id 去重。
10. **`git restore --staged` 在 HEAD 未出生时报的错里，HEAD 是带引号的**：
    `fatal: could not resolve 'HEAD'`。`simpleGitManager.unstage` 的回退分支
    最初用 `/could not resolve HEAD/` 匹配，**永远匹配不上** ——
    回退形同虚设，表现为「全新仓库里取消暂存直接报错」。
    现在是 `HEAD_UNBORN_RE`，用 `['"\`]?` 容忍引号。
    教训：**靠 git 的错误文案做分支判断时，必须用真实输出校准正则**，
    不要凭记忆写（记忆里是"没有引号的版本"）。
11. **不要给 simple-git 传 `.env({ ...process.env })`**。simple-git 3.36 起会检查
    通过 `.env()` 显式传入的环境变量，遇到会注入 git 配置的变量直接抛
    `Use of "GIT_PAGER" is not permitted without enabling allowUnsafePager`
    （`GIT_EDITOR` / `GIT_ASKPASS` 等同理）。本机环境恰好有 `GIT_PAGER=cat`，
    于是测试以「本地服务器收到 0 个请求」的形式失败，看起来像网络问题。
    **生产代码不调 `.env()`，不受影响**；只有测试里需要绕过代理时才想调它。
    确实需要时改用 `unsafe: { allowUnsafePager: true }` 或只传需要的键。
12. **`git config --get <key>` 在键不存在时，simple-git 返回空串而不是抛错**
    （退出码 1 被解析掉了）。断言「配置未设置」要断言 `""`，别写 `rejects.toThrow()`。

### 测试策略

`simpleGitManager.test.ts` 用**真实临时 git 仓库**（mkdtemp + 系统 git），
覆盖 init/状态映射/提交/分支/克隆推送/merge/rebase/reset/冲突/abortMerge/
push 拒绝 —— git 语义的真实性是 mock 给不了的，且不碰网络。注意全局配置
`init.defaultBranch` 不可控，测试里统一 `checkout -b main`，提交身份用
`addConfig` 设在仓库本地（绝不碰用户全局配置）。`syncService.test.ts` 用
可编程假 GitManager 验证编排（顺序/冲突停止/推送前置/串行化）。
`authWire.test.ts` 用「让 git 在同一次调用里读回 `-c` 配置」的手法验证
simple-git 的 config 传递（不碰网络、不需令牌）。

**跑测试要有耐心**：本机进程创建开销约 340ms，`simpleGitManager.test.ts`
单独跑约 **150 秒**（不是"整个套件 1.5 秒"）。别因为"慢"就以为它挂了 ——
`vitest.config.ts` 里已把 `testTimeout` 提到 30 秒，卡死与否看这个。

**`pluginBoot.test.ts`：装配路径的冒烟测试。** 把真实的 `main.ts` `onload()`
跑在假 app 上，断言它注册了什么。这是唯一覆盖装配路径的测试，而它踩过坑：
曾经把状态栏元素挂到 `app.workspace.addStatusBarItem()`（真实 API 在 `Plugin` 类上），
**单测全绿、真机启动才 TypeError**。做法是让 stub 的 `Plugin` 把方法补全 ——
只要 `onload` 调用了 stub 没有的 API，这里就会以 TypeError 失败。

已做**变异验证**：把 `createStatusBarItem` 改回 `app.workspace.addStatusBarItem()`
后该测试立刻失败（`TypeError: ... is not a function`），确认它真的拦得住这类问题，
不是"永远通过"的装饰。改动装配路径时请保持这个性质。

## 七、实测发现（读文档看不出来，改代码前先看这里）

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
    live 测试里 Gitee 的 API 用例**已改为限流时跳过**（不是判失败）——
    长期飘红的套件会训练人忽略失败。想让它稳定跑绿就配令牌：
    `OBSYNC_GITEE_TOKEN=xxx pnpm test:live`（配了令牌还被限流才会真失败）。
14. **GitHub 的三条通道可达性互不相关**，本机 2026-09-16 实测：
    | 通道 | 用途 | 本机表现 |
    | --- | --- | --- |
    | `api.github.com` | release 列表、contents API | 稳定 |
    | `raw.githubusercontent.com` | 匿名读源码文件 | 稳定 |
    | `github.com/.../releases/download/...` → `objects.githubusercontent.com` | 下载 release 资产 | **3 次里 2 次 21 秒超时 0 字节** |
    这直接决定了安装器的两条降级（都是补的洞，别删）：
    - `pluginFiles.loadReleaseFile`：**资产下载失败**（不只是"资产不存在"）也回退该 tag 的源码文件；
    - `GitHubHost.readFile`：raw 域名不可达时回退 contents API（代价是消耗未认证配额）。
    国内网络下 raw 域名常被阻断、资产 CDN 常超时，所以这两条不是"锦上添花"。
15. **本机进程创建开销约 340ms**（连 `cmd /c echo` 也要 317ms，不是 git 特有的）。
    后果：`simpleGitManager.test.ts` 一个用例起十几次 git 就要 4~5 秒，
    vitest 默认的 5 秒超时必然不够 —— 表现为「用例超时 + 清理时 EBUSY」，
    极易误判成被测代码有 bug。已在 `vitest.config.ts` 设 `testTimeout: 30_000`。
    **该文件单独跑约 150 秒**（不是文档早先写的"整个套件 ~1.5s"，那个数字是错的）。
    Windows 上 git 进程退出后目录句柄还会被占一会儿，清理要带
    `maxRetries`/`retryDelay`，否则 EBUSY。
16. 测试库里已装的第三方插件 `gitee-sync-plus` 不是真 git 实现（只做文件级收发），
    所以 OBSync 走真 git 是差异化，不是重复劳动。
17. **`git ls-remote` 的输出可能撑爆 Node 的 `execFile` 缓冲**。
    默认 `maxBuffer` 是 1MB，而 `mindspore/mindspore` 实测有 **18 万个引用**，
    会以 `stdout maxBuffer length exceeded` 失败 —— 看着像网络问题，实则不是。
    挑测试仓库要选引用少的（`oschina/git-osc` 只有 33 个），并显式给 `maxBuffer`。
18. **401 之后 git 会调凭据助手，而本机系统级的 `helper-selector` 在非交互环境里会干等**。
    表现为「用例卡满 45 秒（execFile 超时）」，看起来像网络慢，实则是在等一个
    永远不会来的输入。跑需要触发 401 的 git 命令时，加
    `-c credential.helper=`（**空值会重置助手链**，这个语义在 git 文档里很隐晦）。

### 死代码清点（2026-09-16，2026-09-17 更新）

- `pluginFolder.isPluginInstalled` —— 只被测试用过，与 `readInstalledManifest` 重复。已删。
- `pluginFiles.ts` 整体被 `installFiles.ts` 取代（按文件集参数化），旧模块已删。

方法：扫 `src/**` 里所有 `export function|const|class` 声明，统计该名字在**整个
`src` 树**里的出现次数（先剥掉注释，再剥掉 barrel 的 `export { … } from` ——
否则 `hostRegistry` 那种集中再导出会把死导出全盖住）。只剩下声明处那一次 =
没有任何生产调用方。

**已删**（都是「重复实现里躺着的那一份」，理由见第二节缺陷表）：

- `InstallerService.checkForUpdate` —— 判据用 `requestedVersion`，几乎恒报有更新；
- `hostRegistry.hostFor` —— 与 `getHost(ref.host)` 等价，后者已在 10 处使用；
- `manifest.isManifestCompatible` —— 纯转发；它声明的「注入 `requireApiVersion`
  便于测试」已被 obsidian stub 的 `__setApiVersion` 取代。

**保留但未接线** —— 这些不是垃圾，是**只做了一半的功能**。按
`fileWebUrl` / `commitWebUrl` 那次的先例（当时也记作「死代码」，实际是漏做的功能）：

| 名字 | 现状 | 缺什么 |
| --- | --- | --- |
| `remoteLinks.commitOnRemoteUrl` | 已实现，但**无调用方、无测试**（同文件的 `fileOnRemoteUrl` / `fileHistoryOnRemoteUrl` 各有命令 + 文件右键菜单） | 「查看某个提交」的入口 —— 而提交列表已在下面那条里躺着 |
| `GitManager.log()` / `CommitInfo` | 有实现体，**没有任何调用方** | 同上，UI 侧 |
| `settingsTab.createSettingsTab` | 注释写「供测试与将来复用」，实际没有测试用它；且实现是 `void app` —— **参数是摆设，签名会误导** | 要么删，要么真的用起来 |
| `pluginFolder.isPluginInstalled`、`repoRef.isSameRepo` / `formatRemoteUrl` | 只有测试引用，生产路径没有调用方 | 判断是「模块的公开行为」还是残留 |

> 用这套方法加平台那条还有一层要在**测试**里记住：那些用例都是「遍历
> `SUPPORTED_HOSTS`」，所以**从数组里删掉一个平台它们照样全绿**（循环体少跑
> 一次而已）。那个方向由 `tsc` 兜住 —— 实测删掉 `"gitee"` 会报 **31 个**类型错误
> （`Record<HostKind, IRepoHost>` 的多余属性、`"gitee"` 与 `"github"` 无重叠的比较等）。
> 两个方向由两种机制分别覆盖，别以为测试覆盖了全部。

### 「设置项无人读取」这个自查为什么存在（2026-09-17）

它是被 `sync.enabled` 逼出来的。那个字段**声明了、持久化了、设置页也能改，
而 `src` 里没有一处读它** —— 用户关掉同步之后，自动提交照样每 N 分钟推远端。

关键在于**它掉在测试与类型两边的缝里**：

| 机制 | 为什么抓不到 |
| --- | --- |
| `tsc` | 接错线是 `enabled: true`，类型上也是 `boolean`，合法 |
| 单元测试 | `Automatics` 直接注入设置对象，**看不见装配层那一行**。实测把 `enabled: deps.getSettings().sync.enabled` 改成 `enabled: true`，全量测试**全绿**（12/12） |
| 之前没有的机制 | 与第 3 项「未使用的 i18n 键」同类（「死键是信号」），只是载体从文案换成了配置项 |

所以把它做成第 6 项自查。判据是**保守**的（只认「读」，宁可漏报不误报）：

- 只扫 `installer.*` / `sync.*` 两个嵌套容器 —— 顶层 `ObsyncSettings` 的字段读起来
  形如 `this.settings.language`，容器名与局部变量名混在一起，扫不准，故不扫；
- 一个文件算「读过」，要么限定访问 `.sync.enabled`（后面跟 `=` 是写，不算读），
  要么「提升访问」：文件里先 `const x = …getSettings().installer`，再读 `x.enabled`
  （`installer.enabled` 就是这个写法，只看限定访问会误报）；
- **`settingsTab.ts` 不在扫描范围**：它读设置是为了渲染与持久化，不是消费。
  没有这一条，每个字段都会被设置页自己「读」到，检查就没意义了。

**它扫不到的两类写法**（都在 `EXEMPT` 里，各写了理由）：走「`settingsTab` 组一个
参数对象 → 消费方读参数属性」的字段，读取点在范围外、消费点拿到的是参数
（`installer.lastUpdateCheckAt` 还在参数对象里改了名，静态规则根本接不上）。

> 别为了消掉那两条去放宽判据。试过「属性名在某处的参数类型里出现就算用过」——
> 后果是 `AutomaticsSettings` 里那个 `enabled: boolean` 会把 `sync.enabled` 也算成
> 用过，检查对真正的漏接线（`enabled: true`）**彻底失效**。
> 豁免表天生是盲区，所以每加一条必须写清理由，并且要能接受它保持很短。

验证方式：把 `index.ts` 里那行接线删掉、或改成 `enabled: true`，自查都会**退出码 1**
并把 `sync.enabled` 列出来。

### 三种机制各负责哪个方向（本项目反复踩到的一点）

同一个事实写在多处时，"哪份是权威"与"有没有人读"是两个独立的问题，
而**没有任何单一机制能覆盖全部方向**：

| 方向 | 谁兜住 | 实测依据 |
| --- | --- | --- |
| 副本之间不一致 | 单元测试（让使用点互相印证，而不是各列一份期望值） | 四个漂移方向各被精确抓住 |
| 权威声明被缩小 | `tsc` | 从 `SUPPORTED_HOSTS` 删掉 `"gitee"` → 31 个类型错误，而那 5 条测试全绿 |
| 声明了但没人读（接线漏了） | `scripts/checks.mjs` 第 6 项 | 改 `enabled: true` → 测试全绿、类型通过，只有自查报错 |

## 八、交接习惯（沿用 WorkBuddy 的做法）

- **边做边写文档**：本文件随代码一起更新；当日工作日志追加到
  `.workbuddy-ai/memory/YYYY-MM-DD.md`；新的"实测发现/踩坑"一定记入第七节。
- 提交信息用中文，说明"为什么"；阶段完成一次大提交。
- 参考 `MEMORY.md` 里的长期约定（i18n 规范源、host 层设计原则、代码风格）。
