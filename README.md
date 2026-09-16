# OBSync

一个 Obsidian 插件，把两件事合在一起：

- **笔记仓库同步** —— 用 git 把整个库同步到 GitHub 或 Gitee
- **社区插件安装** —— 从 GitHub 或 Gitee 安装、更新社区插件

两个功能共用同一层平台适配，所以 **GitHub 与 Gitee 的差别只实现一次**。

---

## 为什么又做一个

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

---

## 安装

插件尚未上架官方市场。手动安装：

1. 下载 `main.js`、`manifest.json`、`styles.css`
2. 放进 `<你的库>/.obsidian/plugins/obsync/`
3. 在 Obsidian 的「第三方插件」里启用 OBSync

**平台要求**：笔记同步依赖系统 git，**仅桌面端可用**（Windows / macOS / Linux）。
插件安装是纯网络操作，移动端也能用。

---

## 用法

### 安装社区插件

1. 命令面板 → **OBSync：添加插件仓库**（或点设置页的「添加插件仓库」）
2. 填 `owner/repo` 简写，或直接粘贴完整链接（GitHub / Gitee 都行）
3. 点「识别」→ 选版本 → 安装

也可以点「**浏览社区插件**」从官方市场检索 —— 注意这是 Obsidian 官方维护的索引，
**只有 GitHub 源**，Gitee 上没有等价物，所以 Gitee 的插件需要手输地址。

库里已经装好的插件不用一个个手输：命令 **OBSync：绑定库里已安装的插件**
（或设置页的「绑定已有插件」）会扫描插件目录，按 manifest id 反查来源仓库，
一次性纳入跟踪。

> 所有命令在命令面板里都以 `OBSync：` 开头，直接搜插件名就能找到。

### 同步笔记仓库

先在设置页的「仓库同步」里填远端地址（命令 **OBSync：编辑远端地址**），然后：

- **OBSync：立即同步** —— 提交 → 拉取 → 推送，一条链走完
- 也可以单独用「OBSync：提交全部更改」「OBSync：从远端拉取」「OBSync：推送到远端」
- 侧边栏有源码控制视图，能看分支、ahead/behind、脏文件数与冲突数
- 想在浏览器里看某个文件：命令 **OBSync：在浏览器中打开当前文件**，
  或右键文件选「**在远端打开**」；看它的修改历史用「**在远端查看历史**」。
  GitHub 与 Gitee 都支持（链接按平台拼，中文文件名会自动转义）

自动同步默认关闭。需要的话在设置页设「自动提交 / 自动推送 / 自动拉取」的间隔（分钟），
计时基于**上次执行时间**，重启 Obsidian 不会重置周期。

**遇到冲突**：OBSync 不替你决定保留哪一边。它会在库根目录写一份
《OBSync 冲突指南.md》列出冲突文件，然后**立即停止同步链**
（继续提交会把冲突标记写进历史，继续推送会把它们推上远端）。
手动解决后执行「立即同步」；想放弃这次合并就用「**放弃当前合并**」。

---

## 关于 Gitee 的几点说明

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
- 大多数 Gitee 插件仓库**没有发布 release**，所以源码文件通道是必需的，不是补充

---

## 设置页

| 标签 | 内容 |
| --- | --- |
| 已追踪插件 | 已安装/添加的插件列表，含更新徽标、冻结、重装、移除 |
| 插件安装器 | 开关、更新检查时机、Gitee 镜像发现、**访问令牌** |
| 仓库同步 | 同步开关、自动提交/推送/拉取间隔、提交信息模板、整合策略、git 路径 |
| 通用 | 界面语言、提示开关、调试日志 |

**令牌只保存在本机**（Obsidian 的密钥存储，老版本回退到 localStorage），
不会写进 `data.json`，也不会随库同步到其他设备。

---

## 开发

```bash
pnpm install
pnpm dev        # esbuild watch，构建后自动部署到测试库
pnpm build      # 类型检查 + 生产构建 + 部署
pnpm typecheck
pnpm test       # 单元测试（不碰网络）
pnpm test:live  # 真实 API 测试，需要网络
```

- 部署目标默认是 `F:/_Workspace/Plugin-Test/.obsidian/plugins/obsync`，
  用环境变量 `OBSYNC_DEPLOY_DIR` 覆盖，设为空串则跳过部署。
- 改了 git 相关代码后注意：`simpleGitManager.test.ts` 会起真实 git 进程，
  在这台机器上单独跑约 150 秒 —— 它没挂，只是慢。
- `pnpm test:live` 里 Gitee 的用例在没有令牌且被限流时会**跳过**而不是失败。
  想跑绿就设 `OBSYNC_GITEE_TOKEN=<令牌>`。

架构与踩坑记录见 [`docs/HANDOVER.md`](docs/HANDOVER.md)，
两个参考项目的分析见 [`docs/reference-analysis.md`](docs/reference-analysis.md)。

---

## 授权

见 [LICENSE](LICENSE)。
