/**
 * 简体中文 —— 规范语言（source of truth）。
 *
 * `LocaleStrings` 从本文件推导，其他语言必须 `satisfies LocaleStrings`，
 * 漏翻译或键名写错会在编译期直接报错，而不是运行时静默回退英文。
 */

export const zhCN = {
    plugin: {
        name: "OBSync",
        ribbonTooltip: "OBSync：同步笔记仓库 / 安装插件",
        commandCategory: "OBSync",
    },

    common: {
        ok: "确定",
        cancel: "取消",
        save: "保存",
        close: "关闭",
        delete: "删除",
        edit: "编辑",
        retry: "重试",
        copy: "复制",
        copied: "已复制到剪贴板",
        loading: "加载中…",
        none: "无",
        unknown: "未知",
        yes: "是",
        no: "否",
        confirm: "确认",
        enabled: "已启用",
        disabled: "已禁用",
        version: "版本",
        actions: "操作",
        refresh: "刷新",
        optional: "可选",
        required: "必填",
    },

    notice: {
        error: "出错了",
        warning: "注意",
        info: "提示",
        success: "完成",
    },

    host: {
        github: "GitHub",
        gitee: "Gitee",
        unknown: "未知平台",
        detecting: "正在识别平台…",
        tokenMissing: (host: string) =>
            `${host} 需要访问令牌才能访问私有仓库，请在设置中填写。`,
        tokenInvalid: (host: string) => `${host} 访问令牌无效或已过期。`,
        rateLimited: (host: string, resetAt: string) =>
            `${host} 接口调用次数已达上限，将于 ${resetAt} 恢复。`,
        notFound: (host: string, repo: string) => `${host} 上找不到仓库 ${repo}。`,
        networkFailed: (detail: string) => `网络请求失败：${detail}`,
        requestFailed: (status: number, detail: string) =>
            `请求失败（HTTP ${status}）：${detail}`,
        parseFailed: (input: string) =>
            `无法识别仓库地址「${input}」。请填写 owner/repo，或完整的仓库链接。`,
        unsupportedHost: (input: string) =>
            `暂不支持该平台「${input}」，目前仅支持 GitHub 与 Gitee。`,
    },

    settings: {
        title: "OBSync 设置",

        language: {
            heading: "语言",
            name: "界面语言",
            desc: "插件界面的显示语言。选择「跟随 Obsidian」会使用 Obsidian 当前的语言设置。",
            auto: "跟随 Obsidian",
        },

        token: {
            heading: "访问令牌",
            desc: "访问私有仓库、或提高接口调用上限时需要。令牌只会保存在本机，不会写入 data.json，也不会随仓库同步。",
            githubName: "GitHub 访问令牌",
            githubDesc: "在 GitHub 的 Settings → Developer settings → Personal access tokens 中创建。",
            giteeName: "Gitee 访问令牌",
            giteeDesc: "在 Gitee 的「设置 → 私人令牌」中创建，至少需要 projects 权限。",
            placeholder: "粘贴令牌…",
            test: "测试",
            testing: "测试中…",
            valid: (host: string, account: string) => `${host} 令牌有效，账号：${account}`,
            invalid: (host: string) => `${host} 令牌无效。`,
            cleared: "令牌已清除",
        },

        general: {
            heading: "通用",
            showNotices: "显示操作结果提示",
            showNoticesDesc: "关闭后只显示错误提示，成功与进度提示会被静默。",
            debugLogging: "输出调试日志",
            debugLoggingDesc: "在开发者控制台输出详细的请求与同步日志，排查问题时开启。",
        },

        installer: {
            heading: "插件安装器",
            enabled: "启用插件安装器",
            enabledDesc: "从 GitHub 或 Gitee 安装并更新社区插件。",
            autoCheck: "启动时检查更新",
            autoCheckDesc: "Obsidian 启动后自动检查已跟踪插件的更新。",
            autoCheckDelay: "启动检查延迟（秒）",
            autoCheckDelayDesc: "启动后等待多久再开始检查，避免与 Obsidian 自身的启动流程争抢资源。",
            tracked: "已跟踪的插件",
            trackedDesc: "通过 OBSync 安装或添加的插件仓库。",
            trackedEmpty: "还没有添加任何插件仓库。",
            mirrorDiscovery: "自动发现 Gitee 镜像",
            mirrorDiscoveryDesc: "安装 GitHub 插件时，优先探测 Gitee 上的同名镜像仓库，命中则改用镜像源下载（国内速度更快）。",
        },

        sync: {
            heading: "笔记同步",
            enabled: "启用笔记同步",
            enabledDesc: "使用系统 git 同步当前仓库。此功能仅在桌面端可用。",
            desktopOnly: "笔记同步依赖系统 git，仅在桌面端可用。",
            autoCommit: "自动提交间隔（分钟）",
            autoCommitDesc: "设为 0 表示关闭。",
            autoPush: "自动推送间隔（分钟）",
            autoPushDesc: "设为 0 表示关闭。",
            autoPull: "自动拉取间隔（分钟）",
            autoPullDesc: "设为 0 表示关闭。",
            commitMessage: "提交信息模板",
            commitMessageDesc: "支持 {{date}}、{{hostname}}、{{numFiles}}、{{files}} 变量。",
        },
    },

    installer: {
        modalTitle: "添加插件仓库",
        repoLabel: "仓库地址",
        repoDesc: "填写 owner/repo 简写，或粘贴完整的 GitHub / Gitee 仓库链接。",
        repoPlaceholder: "例如：Dyse-Sofqi/OBSync 或 https://gitee.com/owner/repo",
        resolve: "识别",
        resolving: "正在识别…",
        resolved: (host: string, repo: string) => `已识别为 ${host} 上的 ${repo}`,
        versionLabel: "安装版本",
        versionLatest: "最新版本",
        versionListFailed: "无法获取版本列表，将按最新版本安装。",
        enableAfterInstall: "安装后立即启用",
        install: "安装",
        installing: "正在安装…",
        installFailed: "安装失败",
        installed: (name: string, version: string) => `已安装 ${name} ${version}`,
        updated: (name: string, version: string) => `已更新 ${name} 至 ${version}`,
        upToDate: (name: string) => `${name} 已是最新版本`,
        reinstalled: (name: string) => `已重装 ${name}`,
        removed: (name: string) => `已移除 ${name}`,
        removeFailed: "移除失败",
        sourceRelease: "来源：Release 资产",
        sourceRaw: "来源：仓库源码文件",
        mirrorFound: (repo: string) => `发现 Gitee 镜像：${repo}，将改用镜像源下载。`,
        noReleaseFallback: "该仓库没有发布 Release，将直接从源码文件安装。",
        missingManifest: (repo: string) =>
            `${repo} 中找不到有效的 manifest.json，可能不是 Obsidian 插件仓库。`,
        missingMainJs: (repo: string) => `${repo} 中找不到 main.js，无法安装。`,

        browse: "浏览社区插件",
        communitySearchPlaceholder: "搜索插件名称、作者或描述…",
        communityLoadFailed: "无法加载社区插件列表",

        checkOne: "检查更新",
        checkAll: "检查全部更新",
        updateAll: "更新全部插件",
        updatedMany: (count: number, names: string) => `已更新 ${count} 个插件：${names}`,
        updateFailedMany: (count: number) => `${count} 个插件更新失败`,
        checkFailed: "更新检查失败",
        checking: "正在检查更新…",
        updateAvailable: (name: string, version: string) =>
            `${name} 有新版本 ${version}。`,
        updatesAvailable: (count: number, names: string) =>
            `有 ${count} 个插件可以更新：${names}`,
        checkNone: "所有插件都是最新版本。",
        checkSummary: (outdated: number, failed: number) =>
            failed > 0
                ? `检查完成：${outdated} 个可更新，${failed} 个检查失败。`
                : `检查完成：${outdated} 个可更新。`,
        updateToLatest: "更新到最新版本",
        reinstall: "重装",
        freeze: "冻结（不参与自动更新）",
        unfreeze: "取消冻结",
        frozen: "已冻结",
        openRepo: "在浏览器中打开仓库",
        remove: "移除",
        removeConfirm: (name: string) =>
            `确定要移除 ${name} 吗？\n\n插件目录会被删除，其中的自定义内容也会一并丢失。`,
    },

    sync: {
        viewTitle: "OBSync",
        statusIdle: "就绪",
        statusPulling: "正在拉取…",
        statusPushing: "正在推送…",
        statusCommitting: "正在提交…",
        notARepo: "当前仓库尚未初始化 git。",
        gitNotFound: "找不到 git 可执行文件，请在设置中指定路径。",
        nothingToCommit: "没有需要提交的更改。",
        conflictDetected: (count: number) =>
            `检测到 ${count} 个冲突文件，已生成冲突清单，请手动处理后提交。`,
    },
};

/**
 * 注意：这里刻意**不加** `as const`。
 * 加了会把所有字符串收窄成字面量类型，导致其他语言无法满足该类型。
 * 需要的是「结构一致」，不是「取值一致」。
 */
export type LocaleStrings = typeof zhCN;
