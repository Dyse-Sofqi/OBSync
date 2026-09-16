# OBSync 项目长期约定

## 项目定位
单个 Obsidian 插件（id `obsync`），两个功能模块共用一层平台抽象：
- `features/installer` —— 复刻 BRAT 的社区插件安装能力
- `features/sync` —— 复刻 obsidian-git 的笔记仓库同步能力
- `host/` —— GitHub / Gitee 双平台适配层，两个模块共用

参考源码在 `F:\_Workspace\GitHub-Project\` 下，**只读参考，不要改动**。

## 命令
```
pnpm dev        # esbuild watch + 自动部署到测试库
pnpm build      # typecheck + 生产构建 + 部署
pnpm typecheck  # tsc --noEmit
pnpm test       # 单元测试（不含网络）
pnpm test:live  # 真实 API 测试（需要网络）
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

### 测试
- `tests/live/**` 默认被 `vitest.config.ts` 排除，靠 `OBSYNC_LIVE=1` 开启。
- `obsidian` 模块在测试里被 alias 到 `tests/stubs/obsidian.ts`。
  **测试里要调 stub 的辅助函数（如 `__setRequestUrlHandler`）必须用相对路径 import** ——
  TS 会把 `"obsidian"` 解析到真实的类型包，只有 vitest 运行时才走 alias。
- stub 的 `requestUrl` 返回的 `json` 必须是**惰性 getter**（真实 Obsidian 就是如此），
  写成立即求值会让非 JSON 响应误抛异常。

### host 层设计原则
- 平台差异**只允许出现在 `host/` 内部**。上层（安装器 / 同步）不得出现 `if (host === "gitee")`。
- 鉴权注入是**接口方法**（`applyAuth`），不是共用工具函数 —— Gitee 用查询参数、GitHub 用请求头。
- 状态码 → 错误类型的映射共用（`statusMapper.ts`），但**判定条件由各 host 提供**。
- 两个平台的已知差异（都有实测依据，改动前先看 `docs/reference-analysis.md`）：
  - Gitee releases **默认升序**，必须传 `direction=desc`
  - Gitee 的 API raw 端点对匿名请求返回 **401**，匿名读文件必须走网页 raw 通道
  - Gitee 的 `html_url` 带 `.git` 后缀
  - Gitee 的 `access_token` 走查询参数

### 代码风格
- 注释用中文，写**为什么**而不是**做了什么**。
- 不复刻参考项目的兼容包袱（如 BRAT 的设置页新旧双渲染、obsidian-git 的树形视图）。
- 敏感项（令牌）**绝不进 `data.json`**，走 `core/secretStore`。
