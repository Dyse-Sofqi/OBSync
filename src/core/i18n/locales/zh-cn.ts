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

    host: {
        github: "GitHub",
        gitee: "Gitee",
        unknown: "未知平台",
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
        cmdOpenSettings: "OBSync：打开设置",

        tabs: {
            // 统一用「跟踪」而不是「追踪」—— 同页标题也用的是「跟踪」，
            // 混用会让用户以为指的是两样东西。
            // 这个页签现在同时管插件与主题（同一个列表，靠类型徽标区分），
            // 所以标签写两者而不是只写插件 —— 否则主题用户不会想到点进来。
            tracked: "插件与主题",
            installer: "插件安装器",
            sync: "仓库同步",
            general: "通用",
        },

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
            configured: "已配置",
            notConfigured: "未配置",
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
            autoCheckDesc: "Obsidian 启动后自动检查已跟踪插件与主题的更新。默认关闭 —— 多数情况下用「进入设置页时自动检查」就够。",
            autoCheckDelay: "启动检查延迟（秒）",
            autoCheckDelayDesc: "启动后等待多久再开始检查，避免与 Obsidian 自身的启动流程争抢资源。",
            autoCheckOnSettingsOpen: "进入设置页时自动检查",
            autoCheckOnSettingsOpenDesc: "打开本设置页时自动检查一次更新。短时间内重复打开会跳过，以免白白消耗接口配额。",
            tracked: "已跟踪的插件与主题",
            trackedDesc: "通过 OBSync 绑定、安装或更新的插件与主题。",
            trackedEmpty: "还没有添加任何插件或主题。",
            selfHeading: "OBSync 自身",
            selfDesc:
                "更新 OBSync 自己。只写入新版本的文件，不重载正在运行的插件 —— 重启 Obsidian 后新版本才生效。",
            mirrorDiscovery: "自动发现 Gitee 镜像",
            mirrorDiscoveryDesc: "安装 GitHub 插件时，探测 Gitee 上的镜像仓库：同名仓库，以及你 Gitee 账号下的同名仓库（后者需要先填 Gitee 令牌）。命中则改用镜像源下载，国内速度更快。",
        },

        sync: {
            heading: "仓库同步",
            enabled: "启用笔记同步",
            enabledDesc:
                "允许 OBSync 在后台自动同步这个库。关掉后自动提交 / 推送 / 拉取都会停止；" +
                "命令面板里的同步命令仍然可用（那是你主动发起的）。",
            desktopOnly: "笔记同步依赖系统 git，仅在桌面端可用。",
            autoCommit: "自动提交并同步间隔（分钟）",
            autoCommitDesc:
                "设为 0 表示关闭。这一项不只是提交：到点执行的是「提交 → 拉取 → 推送」" +
                "整条链路，与命令面板里的「立即同步」同一条。",
            autoPush: "自动推送间隔（分钟）",
            autoPushDesc:
                "设为 0 表示关闭。这一项是额外的推送定时器；即使设为 0，只要上面" +
                "「自动提交并同步」开着，推送仍会随它一起发生。",
            autoPull: "自动拉取间隔（分钟）",
            autoPullDesc:
                "设为 0 表示关闭。这一项是额外的拉取定时器；即使设为 0，只要上面" +
                "「自动提交并同步」开着，拉取仍会随它一起发生。",
            commitMessage: "提交信息模板",
            commitMessageDesc: "支持 {{date}}、{{hostname}}、{{numFiles}}、{{files}} 变量。",
            strategy: "拉取整合策略",
            strategyDesc:
                "拉取时如何处理本地与远端的历史分歧。merge 保留双方并产生合并提交；rebase 把本地提交放到远端之后；reset 放弃本地提交、完全以远端为准。",
            strategyMerge: "合并（保留双方历史）",
            strategyRebase: "变基（历史线性）",
            strategyReset: "重置（以远端为准，丢弃本地提交）",
    
        gitPath: "git 可执行文件路径",
            gitPathDesc: "留空使用系统 PATH 中的 git。Windows 上 git 不在 PATH 时才需要填写。",
        },
    },

    installer: {
        /**
         * 命令面板里的名字。
         *
         * 刻意与弹窗标题分开：弹窗标题不该带插件名前缀（用户已经在弹窗里了），
         * 但命令面板里**必须**带 —— Obsidian 用户是按插件名搜索命令的，
         * 一串没有前缀的「添加插件仓库 / 检查全部更新」在面板里根本找不着。
         */
        cmdAddRepo: "OBSync：添加插件仓库",
        cmdBindExisting: "OBSync：绑定库里已安装的插件与主题",
        cmdCheckUpdates: "OBSync：检查插件与主题更新",
        cmdUpdateAll: "OBSync：更新全部插件与主题",

        /**
         * 两种被跟踪对象的称呼。
         *
         * 它们出现在徽标、错误文案与列表说明里，必须是「可拼进句子」的名词
         * （例如「写入主题「Minimal」失败」）—— 错误文案按 kind 取词，见
         * `installer/errors.ts` 的 ofKind。
         */
        kindPlugin: "插件",
        kindTheme: "主题",

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
        installed: (name: string, version: string, source: string) =>
            `已安装 ${name} ${version}（来源：${source}）`,
        /**
         * 完成提示里的 `source` 由 `features/installer/downloadSource.ts` 拼好
         * （平台名，或命中镜像时的「Gitee 镜像」）。
         *
         * 每次都报：用户看不出「没走镜像」与「没探测镜像」的区别（跟踪列表里
         * 那行镜像文案只在命中时才出现），提示是唯一能确认「东西实际从哪来」的地方。
         */
        updated: (name: string, version: string, source: string) =>
            `已更新 ${name} 至 ${version}（来源：${source}）`,
        upToDate: (name: string) => `${name} 已是最新版本`,
        reinstalled: (name: string, source: string) => `已重装 ${name}（来源：${source}）`,
        removed: (name: string) => `已取消绑定 ${name}，它的文件未被改动`,
        removeFailed: "取消绑定失败",
        sourceRaw: "来源：仓库源码文件",
        /**
         * 探测到疑似镜像、但**没有**采用时的那句提示。
         *
         * 旧文案是「发现 Gitee 镜像：…，将改用镜像源下载」——「将改用」已经不成立：
         * 现在采用要用户勾选/确认，所以这句话必须说清「检测到了什么」+「默认不用」，
         * 否则用户看到的和旧版一样，分不清「没探测到」与「探测到了但没用」。
         */
        mirrorUnused: (host: string, repo: string) =>
            `发现疑似 ${host} 镜像：${repo}。默认不使用它，要改用请勾选上面的开关。`,
        /** 完成提示里报镜像来源时用（与 `mirrorLine` 的「镜像」同一层意思）。 */
        mirrorSource: (host: string) => `${host} 镜像`,
        /**
         * 跟踪列表里镜像那一行（紧跟在源仓库下面）。
         *
         * 必须点明「下载使用此源」：只写「Gitee 镜像」的话，用户看到上面一行是
         * GitHub、下面一行是 Gitee，无从判断 OBSync 到底在跟谁说话。
         */
        mirrorLine: (host: string, repo: string) => `${host} 镜像 · ${repo} · 下载使用此源`,
        /**
         * 疑似镜像的**确认**流程文案。
         *
         * 镜像发现从不自动采用一个镜像，只提出候选，由用户在这些文案所在的界面上
         * 拍板 —— 所以 `mirrorWarn*` 那几条不是客套话，是让用户能判断该不该绑的
         * 全部依据（判据只有「两边 manifest 的 id 相同」，那只证明是同一个插件）。
         */
        mirrorSuggestionLine: (host: string, repo: string) =>
            `疑似 ${host} 镜像 · ${repo} · 尚未使用，待确认`,
        mirrorConfirmTitle: "确认镜像来源",
        mirrorConfirmDesc:
            "这一项现在跟的是下面的源仓库；另外发现了一个仓库，看起来是它的镜像。请确认是否改用镜像下载。",
        mirrorConfirmSource: (host: string, repo: string) => `源仓库（现在使用）：${host} · ${repo}`,
        mirrorConfirmCandidate: (host: string, repo: string) => `疑似镜像：${host} · ${repo}`,
        mirrorWarnHeading: "确认前请自己核对这两个地址",
        mirrorWarnChecks:
            "判断镜像的依据只有一条：两边 manifest 的 id 相同。它只能说明「是同一个插件」，" +
            "**不能**证明是同一份代码、同一个作者，也不能保证它跟得上源仓库 —— fork、" +
            "或者别人用同一个 id 重新上传，都会通过这一条。",
        mirrorWarnRisk:
            "插件是能读写你整个库的代码。确认之后，下载与更新检查都会改走镜像；" +
            "如果镜像不是原作者维护的，你不只是在换个下载源，而是在换一个信任对象。",
        mirrorWarnHowTo:
            "核对方式：打开镜像仓库，看它的作者、主页或 README 是否指向源仓库；" +
            "两边的最新版本号也不该差太多。拿不准就别改 —— 保持现状不影响任何功能。",
        mirrorConfirmUse: (host: string) => `改用 ${host} 镜像`,
        mirrorConfirmKeep: "保持现状",
        mirrorConfirmTooltip: "确认镜像来源",
        mirrorConfirmed: (host: string, repo: string) =>
            `已改用 ${host} 镜像 ${repo}，下次更新从它下载`,
        mirrorDismissed: (repo: string) => `已忽略镜像提议 ${repo}`,
        /** 「添加插件仓库」弹窗里的镜像开关。默认不勾 —— 采用镜像必须由用户明示。 */
        mirrorToggleDesc:
            "勾选后改用它下载。判据只是两边 manifest 的 id 相同，不能证明是同一份代码 —— 确认这个地址可信再勾。",
        /**
         * 错误文案。
         *
         * 这些字符串以前是硬编码在逻辑层里的（manifest.ts / pluginFiles.ts /
         * pluginFolder.ts / installerService.ts），所以英文界面下会冒出中文。
         * 现在错误只携带类型码与参数，文案集中在这里。
         */
        errors: {
            manifestNotJson: (context: string) =>
                `${context} 的 manifest.json 不是合法的 JSON。`,
            manifestNotObject: (context: string) =>
                `${context} 的 manifest.json 不是一个对象。`,
            manifestMissingField: (context: string, field: string) =>
                `${context} 的 manifest.json 缺少必需字段「${field}」。`,
            manifestBadId: (context: string, id: string) =>
                `${context} 的插件 id「${id}」不合法（只允许小写字母、数字和连字符）。`,
            missingManifest: (repo: string, of: string) =>
                `${repo} 里找不到 manifest.json，它可能不是 Obsidian ${of}仓库。`,
            missingRequiredFiles: (repo: string, files: string, of: string) =>
                `${repo} 里找不到 ${files}，无法安装该${of}。`,
            missingBuildArtifacts:
                "如果这是源码仓库，作者可能没有把构建产物提交进仓库。",
            incompatibleApp: (name: string, minVersion: string) =>
                `${name} 需要 Obsidian ${minVersion} 或更高版本，当前版本过低，已中止安装。`,
            pluginIdConflict: (pluginId: string, repo: string) =>
                `插件 id「${pluginId}」已被另一个插件占用，无法安装 ${repo}。`,
            folderMissingRequired: (id: string, file: string, of: string) =>
                `${of}「${id}」缺少必需文件 ${file}，已中止写入。`,
            writeFailedRolledBack: (id: string, of: string) =>
                `写入${of}「${id}」失败，已还原到写入前的状态。`,
            writeFailedRollbackFailed: (id: string, of: string) =>
                `写入${of}「${id}」失败，且还原也失败。请手动检查它的目录。`,
            cannotEnablePlugin: "当前 Obsidian 版本不支持通过插件启用其他插件。",
            selfIdMismatch: (repo: string, id: string) =>
                `${repo} 里的插件 id 是「${id}」，不是 OBSync 自己（obsync）—— 已中止更新，以免覆盖别的插件。`,
            selfUpdateDowngrade: (current: string, latest: string) =>
                `远端最新版本 ${latest} 比当前运行的 ${current} 旧，已中止 —— 「更新」不该把你降级。`,
            communityIndexFailed: (status: number) =>
                `拉取官方社区索引失败（HTTP ${status}）。该索引托管在 GitHub，网络不通时无法使用。`,
            rateLimitFallback: (host: string) =>
                `${host} 接口调用次数已达上限，已改用仓库源码文件安装。` +
                `在设置里填入访问令牌可以显著提高额度。`,
            apiUnavailableFallback: (host: string) =>
                `${host} 接口暂时不可用，已改用仓库源码文件安装。`,
            rateLimited: (host: string) => `${host} 接口调用次数已达上限。`,
        },

        browse: "浏览社区插件",
        communitySearchPlaceholder: "搜索插件名称、作者或描述…",
        communityLoadFailed: "无法加载社区插件列表",

        checkOne: "检查更新",
        checkAll: "检查全部更新",
        updateAll: "更新全部",
        // 以下几条现在同时覆盖插件与主题 —— 用「项」而不是「个插件」，
        // 否则主题更新完会收到一句「已更新 1 个插件」。
        updatedMany: (count: number, names: string, source: string) =>
            `已更新 ${count} 项：${names}（来源：${source}）`,
        updateFailedMany: (count: number) => `${count} 项更新失败`,
        checkFailed: "更新检查失败",
        checking: "正在检查更新…",
        updateAvailable: (name: string, version: string) =>
            `${name} 有新版本 ${version}。`,
        updatesAvailable: (count: number, names: string) =>
            `有 ${count} 项可以更新：${names}`,
        checkNone: "所有插件与主题都是最新版本。",
        checkSummary: (outdated: number, failed: number) =>
            failed > 0
                ? `检查完成：${outdated} 个可更新，${failed} 个检查失败。`
                : `检查完成：${outdated} 个可更新。`,
        updateToLatest: "更新到最新版本",
        updateBadge: (version: string) => `可更新 → ${version}`,
        reinstall: "重装",
        freeze: "冻结（不参与更新检查）",
        unfreeze: "取消冻结",
        frozen: "已冻结",
        openRepo: "在浏览器中打开仓库",
        /**
         * 取消跟踪。
         *
         * 措辞里**必须**带「不删除文件」：这个动作以前会递归删掉整个目录
         * （插件还先禁用），现在只把它移出跟踪列表（见 `InstallerService.unbind`）。
         * 不写清楚的话，用户会因为「移除 = 卸载」的惯性而不敢点，或者点完发现
         * 插件还在库里，以为功能坏了。
         */
        remove: "取消绑定（不删除文件）",

        bindTitle: "绑定已安装的插件与主题",
        bindDesc:
            "扫描当前库中已安装的插件与主题，通过官方社区索引自动识别来源仓库；勾选后加入跟踪列表，即可接收更新检查。不会改动任何文件，也不会切换你当前的主题。",
        bindScanning: "正在扫描已安装的插件与主题…",
        bindEmpty: "没有发现可绑定的新插件或主题 —— 可能都已跟踪，或库里还没有。",
        bindPluginsHeading: (count: number) => `检测到 ${count} 个可绑定的插件`,
        bindThemesHeading: (count: number) => `检测到 ${count} 个可绑定的主题`,
        bindSelectAll: "全选 / 取消全选",
        bindUnresolvedHeading: (count: number) =>
            `另有 ${count} 个插件来源未识别（不在官方社区索引中）：`,
        bindUnresolved: "来源未识别，请用「添加插件仓库」手动添加",
        bindUnresolvedThemesHeading: (count: number) =>
            `另有 ${count} 个主题来源未识别（不在官方社区索引中）：`,
        /**
         * 主题这半给了手填仓库的入口，插件那半没有 —— 这是刻意的**不对称**：
         * 插件有「添加插件仓库」这个兜底入口，主题在本次范围里没有新装路径，
         * 不手填的话未识别主题就永远纳不进跟踪。
         */
        bindUnresolvedTheme: "来源未识别：填写仓库地址即可绑定",
        bindRepoPlaceholder: "例如 owner/repo 或完整仓库链接",
        bindManualBind: "绑定",
        bindManualFailed: "绑定主题失败",
        bindConfirm: (count: number) => `绑定所选（${count}）`,
        bindLoadFailed: "扫描已安装的插件与主题失败",
        bindDone: (count: number) => `已绑定 ${count} 项，将纳入更新检查。`,

        /**
         * OBSync 自身的更新。
         *
         * 「待重启」那句是这批文案里最要紧的：更新自己时**不重载自己**，
         * 磁盘上已经是新版本而运行中的还是旧的 —— 不写清楚，用户会以为
         * 已经用上新版了（所以这里也**不**清更新徽标，而是常驻这一行）。
         */
        selfNotChecked: (version: string) => `当前版本 ${version} · 尚未检查更新`,
        selfUpToDate: (version: string) => `OBSync ${version} 已是最新版本`,
        selfUpdateAvailable: (current: string, latest: string) =>
            `有新版本 ${latest}（当前 ${current}）`,
        selfPendingRestart: (version: string) =>
            `已下载 ${version}，重启 Obsidian 后生效`,
        selfUpdating: "正在下载新版本…",
        selfUpdateDone: (version: string) =>
            `已下载 OBSync ${version}，重启 Obsidian 后生效`,
        selfCheckFailed: (reason: string) => `检查 OBSync 更新失败：${reason}`,
        selfUpdateFailed: "更新 OBSync 失败",
    },

    sync: {
        viewTitle: "OBSync",
        statusPulling: "正在拉取…",
        statusPushing: "正在推送…",
        statusCommitting: "正在提交…",
        notARepo: "当前仓库尚未初始化 git。",
        gitNotFound: "找不到 git 可执行文件，请在设置中指定路径。",
        gitAuthFailed: "远端鉴权失败。请检查该平台的访问令牌是否有效、是否有所需权限。",
        /**
         * 与上一条**刻意分开**：令牌是好的，问题在插件填的用户名。
         * 并进上一条会把用户指去查令牌 —— 那是个没问题的东西。
         */
        gitCredentialUsernameRejected:
            "平台不接受凭据中的用户名，令牌本身是有效的。这是插件的配置错误（该平台只接受特定用户名），请把此提示反馈给插件作者。",
        pushRejected: "推送被远端拒绝。远端可能有你本地没有的提交，请先拉取再推送。",
        noUpstream: "当前分支没有跟踪的远端分支，无法拉取。请先设置上游分支或推送一次。",
        detachedHead: "当前处于游离 HEAD 状态（没有指向任何分支），无法推送。请先切换到一个分支。",
        nothingToCommit: "没有需要提交的更改。",
        noRemote: "还没有配置远端仓库，请在设置中填写远端地址。",
        conflictDetected: (count: number) =>
            `检测到 ${count} 个冲突文件，已生成冲突清单，请手动处理后提交。`,

        // 命令名（命令面板里显示）
        cmdSync: "OBSync：立即同步（提交 → 拉取 → 推送）",
        cmdCommit: "OBSync：提交全部更改",
        cmdPush: "OBSync：推送到远端",
        cmdPull: "OBSync：从远端拉取",
        cmdInit: "OBSync：初始化仓库",
        cmdAbortMerge: "OBSync：放弃当前合并（冲突恢复）",
        cmdEditRemote: "OBSync：编辑远端地址",
        cmdOpenFileOnRemote: "OBSync：在浏览器中打开当前文件",
        cmdOpenFileHistoryOnRemote: "OBSync：在浏览器中查看当前文件的历史",

        // 文件右键菜单
        menuOpenOnRemote: "在远端打开",
        menuOpenHistoryOnRemote: "在远端查看历史",
        remoteLinkUnavailable:
            "无法生成远端链接。请确认已配置 GitHub 或 Gitee 远端，且当前仓库至少有一次提交。",

        // 视图 / 状态栏里的短动作名
        actSync: "立即同步",
        actCommit: "提交全部",
        actPull: "拉取",
        actPush: "推送",
        actEditRemote: "编辑远端…",
        branchLabel: "分支",

        editRemoteTitle: "编辑远端地址",
        editRemoteLabel: "远端仓库地址",
        editRemotePlaceholder: "https://github.com/owner/repo.git",
        editRemoteSaved: (url: string) => `远端已设置为 ${url}`,
        // 按类型码取文案（与 diagnoseDetail 同一套约定），判定见 classifyRemoteUrl。
        editRemoteHint: {
            invalid: "这看起来不是一个 git 远端地址。请填写 URL、git@host:path 或本地路径。",
            credentials:
                "这个地址里带着账号和令牌，保存后它们会以明文写进库里的 .git/config —— " +
                "`git remote -v` 能直接看到，备份或同步整个库时也会一起带走。" +
                "建议把地址改成不带凭据的形式，令牌填到上面「访问令牌」里（走系统密钥库，不落盘）。",
            notGithubOrGitee:
                "可以保存并使用 —— 同步是纯 git 操作。但该平台不是 GitHub 或 Gitee，所以不会自动注入访问令牌，「在远端打开」也用不了（私有仓库需要系统凭据助手）。",
        },
        // ── .gitignore ──
        gitignoreCreated: "已创建 .gitignore（排除了 Obsidian 的工作区状态文件，避免多设备冲突）。",
        cmdEditGitignore: "OBSync：编辑 .gitignore",
        /**
         * 初始化仓库时写入的 .gitignore 内容（整段放在 locale 里，
         * 而不是在代码里拼 —— 它含面向用户的说明文字）。
         */
        gitignoreTemplate: [
            "# 由 OBSync 创建。",
            "",
            "# Obsidian 的工作区布局（面板、标签、光标位置）。每台设备各自维护，",
            "# 同步它只会制造冲突 —— 这是 Obsidian 多设备同步最常见的坑。",
            ".obsidian/workspace.json",
            ".obsidian/workspace-mobile.json",
            "",
            "# Obsidian 的回收站",
            ".trash/",
            "",
            "# 系统垃圾文件",
            ".DS_Store",
            "Thumbs.db",
            "",
            "# 想忽略别的文件，直接加到下面即可。",
        ].join("\n"),

        repoInited: "git 仓库已初始化。",
        mergeAborted: "已放弃当前合并，仓库回到拉取前的状态。",

        // ── 连接测试 ──
        diagnoseHeading: "连接测试",
        diagnoseDesc:
            "检查同步配置是否可用，并验证访问令牌。只读操作，不会改动任何东西。",
        diagnoseRun: "测试连接",
        diagnoseRunning: "正在测试…",
        // 措辞刻意限定在「读取」：这个测试走 ls-remote，验不了推送路径。
        // 说成「同步配置可用」会让人以为推送也验过了（实测：Gitee 的凭据用户名
        // 规则只在 push 路径执行，ls-remote 发现不了）。
        diagnoseAllPassed: "全部通过：远端可读取。",
        diagnoseScopeNote:
            "本次只验证了读取（ls-remote）。推送权限与凭据规则要真正推送一次才能确认。",
        diagnoseHasFailures: "发现问题，详见下方。",
        diagnoseCheck: {
            git: "git 可执行文件",
            repo: "git 仓库",
            remote: "远端地址",
            platform: "平台与令牌",
            access: "远端访问",
        },
        diagnoseDetail: {
            gitOk: "可用",
            gitFailed: (detail: string) => `不可用：${detail}`,
            repoOk: "已初始化",
            repoFailed: "尚未初始化 —— 请先执行命令「OBSync：初始化仓库」",
            remoteOk: (url: string) => url,
            remoteFailed: "未配置 —— 请用命令「OBSync：编辑远端地址」填写",
            platformOk: (host: string) => `${host}，已配置访问令牌`,
            platformNoToken: (host: string) =>
                `${host}，**未配置访问令牌** —— 公开仓库可以同步，私有仓库会失败`,
            platformUnknown: "无法识别平台，不会注入令牌（私有仓库需依赖系统凭据助手）",
            accessOk: (count: string) => `可以访问，读到 ${count} 个分支`,
        },


        conflictGuideFile: "OBSync 冲突指南.md",
        conflictGuideTitle: "同步冲突指南",
        conflictGuideIntro:
            "本次拉取时，下列文件在本地和远端都被修改了，git 无法自动决定保留哪一边。文件里的冲突位置以 <<<<<<< 与 >>>>>>> 标出。",
        conflictGuideFiles: "冲突文件：",
        conflictGuideResolve:
            "处理方式：打开每个文件，编辑冲突位置保留你想要的内容（删掉标记行），然后执行「OBSync：立即同步」，冲突解决后会正常提交并推送。",
        conflictGuideAbort:
            "如果想放弃本次合并、回到拉取之前的状态，执行命令「OBSync：放弃当前合并」。",
        conflictGuideFooter: (time: string) => `此文件由 OBSync 于 ${time} 自动生成，处理后可删除。`,
    },
};

/**
 * 注意：这里刻意**不加** `as const`。
 * 加了会把所有字符串收窄成字面量类型，导致其他语言无法满足该类型。
 * 需要的是「结构一致」，不是「取值一致」。
 */
export type LocaleStrings = typeof zhCN;
