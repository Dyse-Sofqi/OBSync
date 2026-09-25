/**
 * 简体中文 —— 规范语言（source of truth）。
 *
 * `LocaleStrings` 从本文件推导，其他语言必须 `satisfies LocaleStrings`，
 * 漏翻译或键名写错会在编译期直接报错，而不是运行时静默回退英文。
 */

/**
 * 疑似镜像那一行/那一项的前缀。
 *
 * 提成模块级常量是因为**两处共用同一句话**：确认弹窗里要把它与「可点开的地址」
 * 分开渲染（见 `ui/repoLink.ts`），而「添加插件仓库」弹窗里用的是拼好的整句。
 * 写两份的话，改一处就会与另一处不一致。
 */
const mirrorCandidatePrefix = "疑似镜像：";

export const zhCN = {
    plugin: {
        name: "SyncHub",
        /**
         * 侧边栏图标（ribbon）的悬停文案。
         *
         * 拆成两条是因为插件现在有**两个** ribbon：一个打开同步详情视图
         * （与 git 插件一样），一个打开安装器。原来那句「同步笔记仓库 / 安装插件」
         * 是给唯一一个图标的，而那个图标打开的是安装器 —— 想找同步视图的人
         * 会点它、然后看到一个装插件的弹窗。
         */
        ribbonSync: "SyncHub：打开仓库同步视图",
        ribbonInstaller: "SyncHub：安装社区插件",
        ribbonImages: "SyncHub：打开图片管理",
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
        cmdOpenSettings: "SyncHub：打开设置",

        tabs: {
            // 统一用「跟踪」而不是「追踪」—— 同页标题也用的是「跟踪」，
            // 混用会让用户以为指的是两样东西。
            // 这个页签现在同时管插件与主题（同一个列表，靠类型徽标区分），
            // 所以标签写两者而不是只写插件 —— 否则主题用户不会想到点进来。
            tracked: "插件与主题",
            installer: "插件安装器",
            sync: "仓库同步",
            images: "图片同步",
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
            statusBarFullWidth: "状态栏占满整屏宽",
            /**
             * 说清「关掉会失去什么、不失去什么」：条目**不会消失**，只是不再贴屏幕最左。
             * 只说「关闭后状态栏恢复原样」会让人以为同步条目没了。
             */
            statusBarFullWidthDesc:
                "把状态栏拉成整屏宽，同步条目才能贴在**最左侧**（否则左边没有空位）。" +
                "关掉后状态栏恢复 Obsidian 原样（右下角一簇），同步条目仍在那一簇的**最前面** —— " +
                "功能不变，只是不再占满一整条。",
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
            trackedDesc: "通过 SyncHub 绑定、安装或更新的插件与主题。",
            trackedEmpty: "还没有添加任何插件或主题。",
            selfHeading: "SyncHub 自身",
            selfDesc:
                "更新 SyncHub 自己。只写入新版本的文件，不重载正在运行的插件 —— 重启 Obsidian 后新版本才生效。",
            /**
             * 自身更新的来源。
             *
             * 文案必须点明两件事：**留空是什么**（否则用户不知道该不该填），
             * 以及**填错了会怎样**（校验 id，所以不会误伤别的插件）——
             * 后者是他敢不敢填的前提。
             */
            selfSource: "自身更新来源",
            selfSourceDesc:
                "留空 = 官方仓库（github.com/Dyse-Sofqi/SyncHub）。国内访问 GitHub 慢或被阻断时，" +
                "可以填 Gitee 镜像的地址 —— 填一次就一直用它，不再自动探测。" +
                "更新前会校验远端 manifest 的 id 必须是 ob-sync，所以地址填错不会覆盖别的插件。",
            selfSourcePlaceholder: "https://gitee.com/sofqi/SyncHub",
            mirrorDiscovery: "自动发现 Gitee 镜像",
            mirrorDiscoveryDesc: "安装 GitHub 插件时，探测 Gitee 上的镜像仓库：同名仓库，以及你 Gitee 账号下的同名仓库（后者需要先填 Gitee 令牌）。命中则改用镜像源下载，国内速度更快。",
        },

        sync: {
            heading: "仓库同步",
            enabled: "启用笔记同步",
            enabledDesc:
                "允许 SyncHub 在后台自动同步这个库。关掉后自动提交 / 推送 / 拉取都会停止；" +
                "命令面板里的同步命令仍然可用（那是你主动发起的）。",
            /**
             * 开关被挂起时的**替代**描述（策略为「重置」，见 `Automatics.start()`）。
             *
             * 必须同时说清「为什么灰掉」和「怎么恢复」：只把开关灰掉不解释，
             * 用户的第一反应是「插件坏了」。
             */
            enabledSuspendedByReset:
                "已暂停：当前拉取整合策略是「重置」，每一轮自动同步都会丢弃刚提交的内容。" +
                "改回「合并」或「变基」后自动恢复。",
            desktopOnly: "笔记同步依赖系统 git，仅在桌面端可用。",
            /**
             * 注意事项：放在这一页最上方（标题正下方），而不是塞进各设置项的描述里。
             *
             * 这两条都是**组合条件**才踩得到的坑（策略选「重置」+ 开着自动同步；
             * 多设备同时编辑同一个文件），写进单项描述没人读得到 ——
             * 用户是在配好之后才出问题，那时早就不翻设置了。
             *
             * 第一条与 `Automatics.start()` 里的挂起逻辑是一件事的两面，必须一起改：
             * 只改文案会变成「说了会暂停其实没暂停」，只改逻辑则用户不知道发生了什么。
             */
            notesHeading: "注意事项",
            notes: [
                "拉取整合策略选「重置」时，自动同步的每一轮都是「提交 → 拉取 → 推送」，" +
                    "而重置会把刚提交的内容丢掉。所以选它时自动同步会被暂停，" +
                    "改回「合并」或「变基」后自动恢复。",
                "同一篇笔记在另一台设备上刚改过、这边又正在编辑时，自动拉取可能覆盖你手上的改动。" +
                    "多设备同时编辑同一个文件时，建议先关掉自动同步。",
            ],
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

            /**
             * `.gitignore` 一节。
             *
             * 为什么把它放在设置页而不是只留一条「打开文件」的命令：`.gitignore`
             * 是**同步行为的一部分**（它决定哪些文件根本不会进版本控制），
             * 而命令面板只有已经知道有这个功能的人才找得到。更重要的是，
             * 在这里能**看见当前内容**——`workspace.json` 是不是被排除了，
             * 是用户配好之后最想确认的一件事。
             */
            gitignoreHeading: "忽略规则（.gitignore）",
            gitignoreDesc:
                "一行一条规则，`#` 开头是注释。这里的改动**直接写进库根目录的 .gitignore**，" +
                "不需要另开编辑器 —— 想用 Obsidian 的编辑器改，点下面的「在编辑器中打开」。",
            gitignoreMissing: "尚未创建",
            gitignoreDirty: "有未保存的修改",
            gitignoreSaved: "已保存",
            gitignoreSave: "保存",
            gitignoreSaving: "正在保存…",
            gitignoreRestore: "填入默认内容",
            gitignoreOpen: "在编辑器中打开",
            gitignoreSavedNotice: "已保存 .gitignore。",
            /**
             * 保存失败要说清「磁盘上还是旧内容」——
             * 用户以为自己改了，而 git 那边一点没变。
             */
            gitignoreSaveFailed: "保存 .gitignore 失败，磁盘上仍是原来的内容。",
        },

        /**
         * 「图片同步」页（R2 双副本）。
         *
         * 这一页的注意事项比「仓库同步」页更要紧：那页的坑是「数据可能丢」，
         * 这页的坑是「文件可能**被删掉**」。所以三条注意事项必须留在最上方。
         */
        images: {
            heading: "图片同步",
            notesHeading: "注意事项",
            notes: [
                "同步只复制、从不删除：每一轮把两边缺的补上（云端多了就下载、本地多了就上传），" +
                    "一个文件都不会删。删除只由你主动发起 —— 见下面这条。",
                "在本机删掉一张受管图片时，插件会问一句「云端那份也删吗」。删掉不可逆" +
                    "（R2 没有回收站）；选「保留」会记一笔，下一轮同步不会把它下载回来。" +
                    "这个询问可以在「冲突与删除」一节里改成「永远同步云端」或「永不同步云端」。",
                "受管文件夹里的图片通常同时也在 git 仓库里，两条链路各管各的：git 管版本历史，" +
                    "R2 管「图片不占仓库体积、且能被外链引用」。SyncHub 不会替你改 .gitignore。",
            ],
            enabled: "启用图片同步",
            enabledDesc:
                "允许 SyncHub 在启动时与后台自动同步图片。关掉后自动同步全部停止；" +
                "这一页里的「立即同步」仍然可用（那是你主动发起的）。",
            folders: "受管的图片文件夹",
            foldersDesc:
                "一行一个，填库内的相对路径（例如 attachments）。只处理这些文件夹里的图片，" +
                "删除也只发生在它们里面 —— 这是插件能碰哪些文件的唯一边界。填 . 表示整个库，" +
                "**默认即仓库根目录（整个库）**：可以用下面的「浏览…」从库里挑，「恢复默认」一键回到它。",
            foldersPlaceholder: "attachments\nassets/images",
            foldersEmpty:
                "一个文件夹都没指定，所以同步不会执行。填一个（例如 attachments）、" +
                "用「浏览…」从库里挑，或按「恢复默认」回到仓库根目录，再点「立即同步」。",
            foldersBrowse: "浏览…",
            foldersReset: "恢复默认",
            folderPickerPlaceholder: "搜索文件夹…",
            folderPickerRoot: "仓库根目录（整个库）",
            folderPickerIncluded: "已在受管范围",

            connectionHeading: "Cloudflare R2 连接",
            accountId: "R2 账号 ID",
            accountIdDesc:
                "Cloudflare 控制台 R2 概览页上的账号 ID。填 ID 即可（会自动补上 .r2.cloudflarestorage.com），" +
                "也可以直接填完整的存储端点地址。",
            accountIdPlaceholder: "例如 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d",
            bucket: "存储桶名称",
            bucketDesc:
                "图片存进哪个桶。前缀之外的对象不会被碰，但用一个**专用桶**最省心。",
            accessKeyId: "Access Key ID",
            accessKeyIdDesc:
                "在 R2 的「管理 API 令牌」里创建，权限至少要有「对象读与写」。这个值不是秘密，" +
                "会随配置一起同步到别的设备。",
            secretKey: "Secret Access Key",
            secretKeyDesc:
                "创建令牌时**只显示一次**的那一串。它只保存在本机（系统密钥库），" +
                "不会写进 data.json，也不会随仓库同步。",
            secretPlaceholder: "粘贴密钥…",
            secretSave: "保存密钥",
            secretClear: "清除密钥",
            secretSaved: "R2 密钥已保存",
            secretCleared: "R2 密钥已清除",
            secretConfigured: "已配置",
            secretNotConfigured: "未配置",
            prefix: "云端前缀",
            prefixDesc:
                "对象键的前缀（例如 images）。留空表示直接放在桶根。它只影响「放在哪儿」，" +
                "改它不会让同步状态失效。",
            publicBaseUrl: "公网访问地址",
            publicBaseUrlDesc:
                "自定义域名或 r2.dev 域名，用来生成图片的外链。留空则「复制云端链接」不可用 —— " +
                "存储端点每次读取都要签名，粘到笔记里必然打不开，所以这里不猜。",

            conflictHeading: "冲突与删除",
            conflictPolicy: "两边都被修改时",
            conflictPolicyDesc:
                "同一个文件在本地和云端都变了。图片没法自动合并，只能选一边作为结果。",
            conflictNewer: "谁新听谁的（比较修改时间）",
            conflictLocal: "以本地为准",
            conflictRemote: "以云端为准",
            deleteRemotePolicy: "删除本地图片时，询问是否同时删除云端备份",
            /**
             * 三个选项各自的后果都要说清 —— 这是一个下拉，用户看的是当前值，
             * 另外两个值会发生什么他并不知道。其中「永不同步云端」那一半尤其
             * 要写：不写的话用户会发现删掉的图下一轮又回来了（镜像逻辑会把它
             * 从云端补回本地），而那看起来像 bug。
             */
            deleteRemotePolicyDesc:
                "在库里删掉一张图片、而云端还有它的备份时怎么办：「询问用户」弹一次窗；" +
                "「永远同步云端」直接连云端一起删（R2 没有回收站，删掉不可逆）；" +
                "「永不同步云端」则云端永远不动 —— 但那一份会被下一次同步**下载回本地**" +
                "（镜像是双向补齐的）。",
            deleteRemoteAsk: "询问用户",
            deleteRemoteAlways: "永远同步云端",
            deleteRemoteNever: "永不同步云端",
            autoSync: "自动同步间隔（分钟）",
            autoSyncDesc:
                "设为 0 表示关闭（默认）。到点执行的是一整轮比对：把两边缺的补上（上传与下载）。" +
                "同步**不会删除**任何文件 —— 删除只在你删本地图片时问过你之后才发生。",

            compressHeading: "裁剪与压缩的默认值",
            compressQuality: "默认质量",
            compressQualityDesc:
                "有损格式（JPEG / WebP）的默认质量，10–100。PNG 是无损的，用不到它。",
            compressMaxEdge: "默认最长边（像素）",
            compressMaxEdgeDesc:
                "裁剪压缩弹窗里默认的缩放上限。0 表示不缩放。只缩不放 —— 放大小图只会更模糊、更大。",
            compressFormat: "默认输出格式",
            compressFormatDesc:
                "「保持原样」不等于「不压缩」：原格式是 JPEG 时照样按质量重编码，只是不换容器。",

            actionsHeading: "操作",
            test: "测试连接",
            testing: "正在测试…",
            testOk: (bucket: string) => `连接正常，可以访问存储桶 ${bucket}。`,
            testFailed: "连接测试失败",
            preview: "预览变更",
            previewing: "正在比对…",
            syncNow: "立即同步",
            syncing: "正在同步…",
            /**
             * 图片管理面板的入口。
             *
             * 放在设置页是因为它是**发现性**的落点：命令面板与侧栏图标在
             * 「我知道有这个东西」之后才有用，而设置页是用户排查时的必经之路。
             */
            openManager: "打开图片管理",
            openManagerDesc:
                "按「本地 / 云端 / 已链接」三种状态列出受管文件夹里的所有图片，" +
                "可以筛选出失联图片、待上传的、只留在云端的，并批量同步、压缩、重命名或删除。",
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
        cmdAddRepo: "SyncHub：添加插件仓库",
        cmdBindExisting: "SyncHub：绑定库里已安装的插件与主题",
        cmdCheckUpdates: "SyncHub：检查插件与主题更新",
        cmdUpdateAll: "SyncHub：更新全部插件与主题",

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
        repoPlaceholder: "例如：Dyse-Sofqi/SyncHub 或 https://gitee.com/owner/repo",
        resolve: "识别",
        resolving: "正在识别…",
        resolved: (host: string, repo: string) => `已识别为 ${host} 上的 ${repo}`,
        versionLabel: "安装版本",
        versionLatest: "最新版本",
        versionListFailed: "无法获取版本列表，将按最新版本安装。",

        /**
         * 「版本管理」—— 已跟踪插件行上的按钮（**只有插件有**，主题没有版本钉选）。
         *
         * 这几条要交代清楚三件事，缺一件用户就会踩坑：选旧版本是**回退**、
         * 选「最新版本」是**解开钉住的选择**、以及这个选择会被记住
         * （在版本管理里再打开它，默认选中的就是这一版）。
         */
        versionManage: "版本管理（可回退到指定版本）",
        versionManageTitle: "选择版本",
        versionManageDesc:
            "切换到这个插件的另一个发布版本：选旧版本即为回退。选「最新版本」则恢复跟随最新发布。",
        versionInstalled: (version: string) => `当前安装：${version}`,
        /** 读不到 manifest 里的版本时（手工装的目录）—— 不写「当前安装：」，那后面空着像坏了。 */
        versionInstalledUnknown: "当前安装：版本未知",
        /** 标在**磁盘上装的那一版**后面（`1.2.3 · 当前`），否则一串 tag 里认不出自己在哪。 */
        versionCurrent: "当前",
        versionLoading: "正在获取版本列表…",
        /** 「一个 release 都没发」与「这次没拉到」是两件事，文案也必须分开。 */
        versionNoneAvailable: "这个仓库没有发布任何版本（只能从源码安装），没有可切换的版本。",
        versionFetchFailed: "无法获取版本列表。",
        versionApply: "切换到此版本",
        versionSwitched: (name: string, version: string, source: string) =>
            `已把 ${name} 切换到 ${version}（来源：${source}）`,
        /**
         * 列表上的「已固定」徽标。
         *
         * 这个状态只在 `data.json` 里（`requestedVersion`），而它的后果是
         * 「在版本管理里点一下就会装回这一版」—— 不显示出来，用户看到旧版本号
         * 会分不清是自己选的还是更新失败留下的。
         */
        versionPinned: (version: string) => `已固定 ${version}`,

        /**
         * 「下载来源」一节（版本管理弹窗里）。
         *
         * 为什么把来源与版本放在同一个弹窗：用户心里这是同一件事 ——
         * 「我选了 1.0.2，但它不走 Gitee，我也找不到选 Gitee 的地方」。
         */
        versionSourceLabel: "下载来源",
        versionSourceCurrent: (host: string, repo: string) => `当前下载走：${host} · ${repo}`,
        /** 走了镜像时才有：记录里留着的那个「家」。 */
        versionSourceOrigin: (host: string, repo: string) => `源仓库：${host} · ${repo}`,
        /** 同理：地址与前缀分开，地址要能点开去核对。 */
        versionMirrorFoundPrefix: "发现疑似镜像：",
        /**
         * 探不到镜像时的解释。**必须有**：自动探测只猜两个候选，镜像挂在第三个
         * 地方（作者自己的 Gitee 账号）时永远猜不到 —— 不解释的话，用户会把这句
         * 读成「这个插件没有镜像」。
         */
        versionMirrorNone:
            "没发现镜像。自动探测只会猜两个候选：同名仓库，以及你 Gitee 账号下的同名仓库" +
            "（后者需要先填 Gitee 令牌）。镜像挂在别的账号下时，在下面手填地址即可。",
        versionUseMirror: (host: string) => `改用 ${host} 镜像`,
        versionManualLabel: "手填镜像地址",
        versionManualDesc:
            "例如 sofqi/Trefoil，或粘贴完整链接。地址里的插件 id 必须与这一项一致，否则拒绝采用。",
        versionManualPlaceholder: "例如 sofqi/Trefoil",
        versionManualApply: "改用这个地址",
        versionManualChecking: "正在核对地址…",
        versionMirrorFailed: "改用这个镜像失败",
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
         * GitHub、下面一行是 Gitee，无从判断 SyncHub 到底在跟谁说话。
         */
        mirrorLine: (host: string, repo: string) => `${host} 镜像 · ${repo} · 下载使用此源`,
        /**
         * 疑似镜像的**确认**流程文案。
         *
         * 镜像发现从不自动采用一个镜像，只提出候选，由用户在这些文案所在的界面上
         * 拍板 —— 所以 `mirrorWarn*` 那几条不是客套话，是让用户能判断该不该绑的
         * 全部依据（判据只有「两边 manifest 的 id 相同」，那只证明是同一个插件）。
         */
        /**
         * 记录与磁盘不一致时的校正提示，以及「同一个 id 有几个目录」的警告。
         *
         * 这两条都来自实测的一个坑：`plugins/` 里多出一份同 id 的残留备份，
         * Obsidian 重启后加载了那份旧版本，而记录里还写着新版本 —— 更新检查
         * 于是永远报「已是最新」，用户被卡住且看不出原因。
         */
        versionCorrected: (names: string) =>
            `检测到实际安装的版本与记录不一致，已按磁盘上的文件更正：${names}`,
        duplicateFolders: (name: string, count: number) =>
            `${name}：有 ${count} 个插件目录声明同一个 id，Obsidian 加载哪一个是不定的。` +
            `建议把多余的（通常是残留备份）移出插件目录后重启。`,
        mirrorSuggestionLine: (host: string, repo: string) =>
            `疑似 ${host} 镜像 · ${repo} · 尚未使用，待确认`,
        mirrorConfirmTitle: "确认镜像来源",
        mirrorConfirmDesc:
            "这一项现在跟的是下面的源仓库；另外发现了一个仓库，看起来是它的镜像。请确认是否改用镜像下载。",
        /**
         * 确认页里的两个地址：**前缀与地址分开**，因为地址要渲染成可点开的链接
         * （那一页存在的意义就是让用户去核对它们 —— 判据只有 `id` 相同）。
         */
        mirrorSourcePrefix: "源仓库（现在使用）：",
        mirrorCandidatePrefix,
        /** 拼好的整句：给「添加插件仓库」弹窗当设置行名用，确认页用上面那两个前缀。 */
        mirrorConfirmCandidate: (host: string, repo: string) =>
            `${mirrorCandidatePrefix}${host} · ${repo}`,
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
            /**
             * 「资产里挂着，但没下下来」—— 与上一条分开，因为下一步完全不同：
             * 上一条要做的是去问作者（或去看发布流程），这一条是检查自己的网络。
             * 分开的由来见 `installFiles.ts` 里 `assetNames` 的注释（实测踩过）。
             */
            assetDownloadFailed: (repo: string, files: string, of: string) =>
                `从 ${repo} 下载 ${files} 失败：${of}的 release 里确实挂着这个文件，` +
                `是这次没取回来（通常是网络问题，不是作者没上传 —— 它的资产 CDN ` +
                `在国内经常连不上）。检查网络后重试，或改用 Gitee 镜像。`,
            /**
             * 手填镜像地址时 id 不一致 —— 硬拦，不是提醒。
             * 说明里要写清「为什么不能装」：用户手填的地址看起来往往很像。
             */
            mirrorIdMismatch: (repo: string, expected: string, found: string) =>
                `${repo} 里的插件 id 是「${found}」，而这一项跟踪的是「${expected}」—— ` +
                `已拒绝改用，以免装错东西。请核对地址是否指到了同一个插件的镜像。`,
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
                `${repo} 里的插件 id 是「${id}」，不是 SyncHub 自己（ob-sync）—— 已中止更新，以免覆盖别的插件。`,
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
        /**
         * 长耗时操作的进度提示（带旋转图标）。
         *
         * 文案必须点出**在做什么**：用户的原话是「不然我根本不知道你是不是在更新」，
         * 一句笼统的「加载中…」回答不了这个问题。
         */
        progressChecking: (name: string) => `${name}：正在检查更新…`,
        progressUpdating: (name: string) => `${name}：正在更新…`,
        progressFetching: (name: string, file: string) => `${name}：正在获取 ${file}…`,
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
         * SyncHub 自身的更新。
         *
         * 「待重启」那句是这批文案里最要紧的：更新自己时**不重载自己**，
         * 磁盘上已经是新版本而运行中的还是旧的 —— 不写清楚，用户会以为
         * 已经用上新版了（所以这里也**不**清更新徽标，而是常驻这一行）。
         */
        selfNotChecked: (version: string) => `当前版本 ${version} · 尚未检查更新`,
        selfUpToDate: (version: string) => `SyncHub ${version} 已是最新版本`,
        selfUpdateAvailable: (current: string, latest: string) =>
            `有新版本 ${latest}（当前 ${current}）`,
        selfPendingRestart: (version: string) =>
            `已下载 ${version}，重启 Obsidian 后生效`,
        selfUpdating: "正在下载新版本…",
        selfUpdateDone: (version: string) =>
            `已下载 SyncHub ${version}，重启 Obsidian 后生效`,
        selfCheckFailed: (reason: string) => `检查 SyncHub 更新失败：${reason}`,
        selfUpdateFailed: "更新 SyncHub 失败",
    },

    sync: {
        /**
         * 侧边栏视图的名字（标签页标题）。
         *
         * 原来这里写的是「SyncHub」——于是视图标题、页内标题、以及**打开它的那条
         * 命令名**全都是「SyncHub」：命令面板里搜「同步」搜不到它，也没人知道
         * 它是个什么面板。改成与 README 一致的说法。
         *
         * 2026-09-19 又从「源码控制」改成「仓库同步」：面板里那个重复的页内标题
         * 删掉了，于是这个名字就是用户唯一看到的名字，而「源码控制」是 git 的
         * 说法、不是这个插件的 —— 它做的就是把笔记仓库同步到远端。
         */
        viewTitle: "仓库同步",
        statusPulling: "正在拉取…",
        statusPushing: "正在推送…",
        statusCommitting: "正在提交…",
        notARepo: "当前仓库尚未初始化 git。",
        gitNotFound: "找不到 git 可执行文件，请在设置中指定路径。",
        gitAuthFailed: "远端鉴权失败。请检查该平台的访问令牌是否有效、是否有所需权限。",
        /**
         * git 卡住被中止。
         *
         * 用户的原话是「尝试推送后一直看到正在推送」—— 那种「什么都不发生」
         * 必须被说出来，并告诉他下一步能做什么（这正是这个类型存在的理由）。
         */
        gitTimeout:
            "git 长时间没有任何响应，本次操作已中止。请检查网络（或代理）后重试；" +
            "若反复出现，可能是远端仓库过大或需要凭据 —— 后者请到设置页填写访问令牌。",
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
        /**
         * 用户主动点「推送」而本地没有新提交时说的话。
         *
         * **注意它不宣称「与远端一致」**：`ahead === 0` 只说明本地没有新提交，
         * 完全可能还落后远端（别人推过）。真正「完全一致」有专门的
         * `syncedInSync`（带 ✓ 的醒目提示）。
         */
        pushUpToDate: "没有需要推送的内容（本地没有新提交）。",
        /**
         * 同上，但工作区还有未提交的改动 —— 这才是最容易误会的那个状态：
         * 用户带着一堆改动点「推送」，等的是「我的改动上去了」，
         * 而推送**只发送已提交的内容**。
         */
        pushNeedsCommit: (count: number) =>
            `推送只发送**已提交**的内容，而你有 ${count} 个更改还没提交。` +
            `请先点「提交」（或「立即同步」）。`,
        /** 推送成功，但工作区还有未提交的改动。 */
        pushDonePending: (count: number) =>
            `已推送到远端。注意：另有 ${count} 个更改尚未提交，推送不会自动提交它们。`,
        pushDone: "已推送到远端。",
        /** 「提交」之后：提交好了，但还没推上去。 */
        commitsNotPushed: (count: number) =>
            `已提交，另有 ${count} 个提交尚未推送（可点「推送」或「立即同步」）。`,
        /**
         * 「与远端完全一致」——**醒目**的那条（带 ✓、停留更久）。
         *
         * 用户的原话：「当提交结束与远端一致时，给出醒目的反馈」。
         * 体积读得到就带上，读不到就只说状态（不编一个 0 B）。
         */
        syncedInSync: (size?: string) =>
            size ? `已同步：本地与远端一致 · 仓库 ${size}` : "已同步：本地与远端一致",

        // ── 体积 ──
        repoSizeLabel: "仓库大小",
        repoSizeDesc: (size: string, objects: number) => `${size}（${objects} 个对象）`,
        pendingChangesLabel: "待提交改动",
        pendingChangesDesc: (size: string, files: number) => `${size}（${files} 个文件）`,
        /** 读不到体积时**不编数字** —— 0 B 会被当成「空仓库」。 */
        sizeUnknown: "读不到",
        noRemote: "还没有配置远端仓库，请在设置中填写远端地址。",
        conflictDetected: (count: number) =>
            `检测到 ${count} 个冲突文件，已生成冲突清单，请手动处理后提交。`,

        // 命令名（命令面板里显示）
        cmdSync: "SyncHub：立即同步（提交 → 拉取 → 推送）",
        cmdCommit: "SyncHub：提交全部更改",
        cmdPush: "SyncHub：推送到远端",
        cmdPull: "SyncHub：从远端拉取",
        cmdInit: "SyncHub：初始化仓库",
        cmdAbortMerge: "SyncHub：放弃当前合并（冲突恢复）",
        cmdEditRemote: "SyncHub：编辑远端地址",
        cmdOpenFileOnRemote: "SyncHub：在浏览器中打开当前文件",
        cmdOpenFileHistoryOnRemote: "SyncHub：在浏览器中查看当前文件的历史",
        cmdOpenDiff: "SyncHub：查看当前文件的差异",

        // 文件右键菜单
        menuOpenOnRemote: "在远端打开",
        menuOpenHistoryOnRemote: "在远端查看历史",
        remoteLinkUnavailable:
            "无法生成远端链接。请确认已配置 GitHub 或 Gitee 远端，且当前仓库至少有一次提交。",

        // 视图 / 状态栏里的短动作名
        actSync: "立即同步",
        /**
         * 三个动作的悬停提示。
         *
         * 必要性来自一个真实的提问：「推送按钮是单纯的推送还是提交全部加推送，
         * 如果是后者应该写清楚」—— 按钮上只有两个字，而「提交」与「推送」
         * 是两件事（本地 vs 远端）。答案是「单纯的推送」，那就得让界面自己说。
         */
        actSyncHint: "提交 → 拉取 → 推送，一条链走完",
        actCommitHint: "把所有更改提交到本地仓库（不推送）",
        actPushHint: "只推送**已提交**的内容，不会自动提交",
        actCommit: "提交",
        actPull: "拉取",
        actPush: "推送",
        actEditRemote: "编辑远端…",
        branchLabel: "分支",

        /**
         * ── 侧边栏详情面板（2026-09-19）
         *
         * 视图从「一个标题 + 四个按钮」扩成 git 插件那样的面板时新增的一组文案。
         * `cmdOpenView` 与 `viewTitle` **必须是两条**：命令名要以 `SyncHub` 开头
         * 才能在命令面板里被搜到（有测试钉着），而面板标题不该带这个前缀。
         */
        cmdOpenView: "SyncHub：打开仓库同步面板",
        statusBarHint: "点击打开仓库同步面板",
        actRefresh: "刷新",
        actInit: "初始化仓库",
        actStage: "暂存此文件",
        actUnstage: "取消暂存此文件",
        actStageAll: "全部暂存",
        actUnstageAll: "全部取消暂存",
        actOpenFile: "打开此文件",
        actOpenFileOnRemote: "在远端打开此文件",
        actDiff: "查看差异",
        actAbortMerge: "放弃本次合并",
        sectionStaged: (count: number) => `已暂存的更改（${count}）`,
        sectionChanges: (count: number) => `更改（${count}）`,
        sectionConflicts: (count: number) => `冲突（${count}）`,
        sectionHistory: "最近提交",
        historyEmpty: "还没有提交。",
        historyFailed: "无法读取提交历史。",
        commitOnRemote: "在远端查看此提交",
        actDiffCommit: "查看此提交的改动",
        remoteLabel: "远端",
        detachedHeadLabel: "游离 HEAD（当前不在任何分支上）",
        aheadOf: (count: number) => `领先远端 ${count} 个提交`,
        behindOf: (count: number) => `落后远端 ${count} 个提交`,
        inSyncWithRemote: "与远端一致",
        noUpstreamHint: "该分支还没有跟踪远端分支，推送时会自动建立。",
        conflictHint:
            "这些文件在本地和远端都被修改过，git 无法自动决定保留哪一边。解决后提交即可；也可以放弃本次合并。",

        /**
         * ── 差异视图（2026-09-24）
         *
         * 弹窗里那几行说明。这里的 `section` 是**按下标取**的
         * （`t.sync.diff.section[kind]`），与 `diagnoseCheck[check.id]` 同一套写法。
         */
        diff: {
            title: "差异",
            section: {
                /** 工作区 ↔ 索引：还没暂存的内容。 */
                working: "工作区改动（未暂存）",
                /** 索引 ↔ HEAD：即将被提交的内容。 */
                staged: "已暂存改动",
                /** `git show`：一条提交引入的改动。 */
                commit: "本次提交的改动",
            },
            loading: "正在读取差异…",
            loadFailed: "读取差异失败。",
            noChanges: "没有可显示的差异。",
            /** 二进制没有可读的行 —— 说成「没有差异」是错的，那是个**有**改动的文件。 */
            binary: "二进制文件，不显示内容差异。",
            renamed: "内容没有改动，只是改了名字。",
            /** 未跟踪文件超过上限时不再读进内存（几十 MB 的文件会把界面卡住）。 */
            tooLarge: "文件太大，未显示内容差异。",
            truncated: "内容过多，只显示了前面一部分。",
            noNewline: "（此文件末尾没有换行）",
            stats: (additions: number, deletions: number) =>
                `+${additions} −${deletions}`,
        },

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
        cmdEditGitignore: "SyncHub：编辑 .gitignore",
        /**
         * 「在编辑器里打开 .gitignore」没成时说的一句话。
         *
         * **不猜原因**：`getAbstractFileByPath` 查的是 Obsidian 的库索引，而以点
         * 开头的文件在有些环境里不在索引里 —— 但那不是我们能在这一层确认的事。
         * 所以说清「没打开」，并给出两条**确实能用**的路。
         */
        gitignoreOpenFailed:
            "没能在 Obsidian 的编辑器里打开 .gitignore。可以到「仓库同步」设置页用那个" +
            "代码框直接改，或用系统编辑器打开库根目录下的 .gitignore。",
        /**
         * 初始化仓库时写入的 .gitignore 内容（整段放在 locale 里，
         * 而不是在代码里拼 —— 它含面向用户的说明文字）。
         *
         * 参数是**库的配置目录名**（`vault.configDir`），不是一个写死的
         * `.obsidian`：用户可以改它，而写死的话那些排除规则会一条都不匹配 ——
         * 表现是「明明建了 .gitignore，workspace.json 还是被同步出去了」。
         * 审核的 `hardcoded-config-path` 报的也是这件事。
         */
        gitignoreTemplate: (configDir: string) =>
            [
                "# 由 SyncHub 创建。",
                "",
                "# Obsidian 的工作区布局（面板、标签、光标位置）。每台设备各自维护，",
                "# 同步它只会制造冲突 —— 这是 Obsidian 多设备同步最常见的坑。",
                `${configDir}/workspace.json`,
                `${configDir}/workspace-mobile.json`,
                "",
                "# 本插件自己的设置（同步间隔、拉取策略…）。这些是**按设备**的，",
                "# 同步它只会让两台设备互相覆盖设置。",
                `${configDir}/plugins/ob-sync/data.json`,
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
            repoFailed: "尚未初始化 —— 请先执行命令「SyncHub：初始化仓库」",
            remoteOk: (url: string) => url,
            remoteFailed: "未配置 —— 请用命令「SyncHub：编辑远端地址」填写",
            platformOk: (host: string) => `${host}，已配置访问令牌`,
            platformNoToken: (host: string) =>
                `${host}，**未配置访问令牌** —— 公开仓库可以同步，私有仓库会失败`,
            platformUnknown: "无法识别平台，不会注入令牌（私有仓库需依赖系统凭据助手）",
            accessOk: (count: string) => `可以访问，读到 ${count} 个分支`,
        },


        conflictGuideFile: "SyncHub 冲突指南.md",
        conflictGuideTitle: "同步冲突指南",
        conflictGuideIntro:
            "本次拉取时，下列文件在本地和远端都被修改了，git 无法自动决定保留哪一边。文件里的冲突位置以 <<<<<<< 与 >>>>>>> 标出。",
        conflictGuideFiles: "冲突文件：",
        conflictGuideResolve:
            "处理方式：打开每个文件，编辑冲突位置保留你想要的内容（删掉标记行），然后执行「SyncHub：立即同步」，冲突解决后会正常提交并推送。",
        conflictGuideAbort:
            "如果想放弃本次合并、回到拉取之前的状态，执行命令「SyncHub：放弃当前合并」。",
        conflictGuideFooter: (time: string) => `此文件由 SyncHub 于 ${time} 自动生成，处理后可删除。`,
    },

    /**
     * 图片同步 / R2 / 图片编辑。
     *
     * 与 `installer` / `sync` 同构：错误文案集中在这里，由
     * `features/images/errors.ts` 的 `describeImageSyncError` 按类型码取。
     */
    images: {
        /** 输出格式的下拉项。设置页与编辑弹窗**共用一份** —— 两处措辞不一致会让人以为是两个不同的东西。 */
        formatOption: {
            keep: "保持原样",
            jpeg: "JPEG",
            webp: "WebP",
            png: "PNG",
        },

        cmdSync: "SyncHub：同步图片到云端",
        cmdPreview: "SyncHub：预览图片同步的变更",
        cmdEdit: "SyncHub：裁剪 / 压缩当前图片",
        cmdCopyLink: "SyncHub：复制当前图片的云端链接",
        cmdManage: "SyncHub：打开图片管理",

        toolbar: {
            crop: "裁剪 / 压缩",
            copyLink: "复制云端链接",
        },

        notice: {
            syncDone: (uploaded: number, downloaded: number) =>
                `图片同步完成：上传 ${uploaded}，下载 ${downloaded}。`,
            syncNothing: "图片同步完成：本地与云端已经一致，没有需要处理的内容。",
            syncFailed: "图片同步失败",
            syncFailedMany: (count: number) => `有 ${count} 个文件处理失败`,
            previewFailed: "预览图片同步变更失败",
            linkCopied: (url: string) => `云端链接已复制：${url}`,
            noPublicBase:
                "还没有配置公网访问地址，无法生成链接。请在「图片同步」设置里填一个自定义域名或 r2.dev 域名。",
            notInScope: "这张图片不在受管的图片文件夹里，SyncHub 不会同步它。",
            notConfigured:
                "图片同步还没配置好。请先在「图片同步」设置页填写 R2 信息与受管的图片文件夹。",
            editorOpenFailed: "打开图片编辑器失败",
            singleUploadFailed: "把这张图上传到云端失败（不影响本地保存）",
            deleteBackupFailed: "删除云端备份失败",
            deleteBackupFailedMany: (count: number) => `有 ${count} 个云端备份没能删除。`,
            remoteDeleted: (count: number) => `已删除 ${count} 个云端备份。`,
            remoteKept: (count: number) =>
                `已保留 ${count} 个云端备份（本地不再保留副本，也不会再同步回来）。`,
            renameFailed: "把云端那一份搬到新名字下失败",
            deleteOutOfScope: "不在受管的图片文件夹里，SyncHub 不会动它",
        },

        /**
         * 本地删除图片时的确认弹窗。
         *
         * 标题要带数量：一次删十张图时弹的是一个窗，用户得知道自己在回答什么。
         */
        deleteRemote: {
            title: (count: number) =>
                count === 1
                    ? "要从云端也删除这张图片吗？"
                    : `要从云端也删除这 ${count} 张图片吗？`,
            desc:
                "这些图片在云端还有一份备份。本地这一份已经删掉了 —— 云端那一份要怎么处理？",
            more: (count: number) => `另有 ${count} 个未列出。`,
            warningHeading: "云端删除不可撤销",
            /**
             * 必须写清「为什么这里没有后悔药」：本地那次删除多半还躺在 Obsidian
             * 的回收站里，而 R2 没有回收站。不写出来，用户会按「本地删除」的经验
             * 去点这个按钮。
             */
            warning:
                "本地那份大概率还能从库的回收站找回来，但云端**没有回收站** —— " +
                "删掉就真的没有了（除非你在别处还有副本）。选「保留云端备份」则云端那一份" +
                "会留着，只是不再同步回本地。",
            keep: "保留云端备份",
            delete: "同时删除云端备份",
        },

        plan: {
            heading: "变更预览",
            empty: "本地与云端已经一致，没有需要处理的内容。",
            counts: (upload: number, download: number, conflicts: number, skipped: number) =>
                `将上传 ${upload}，下载 ${download}，冲突 ${conflicts}，跳过 ${skipped}。`,
            /**
             * 列举被截断时的说明。
             *
             * 现在它只影响「结果完不完整」：删除已经不在计划里了，所以没有
             * 「不敢删」这回事了。但截断仍然要说出来 —— 否则「明明云端有这一份，
             * 为什么又传了一次」会让人以为是重复上传的 bug。
             */
            truncated:
                "云端对象数量超过了一次列举的上限，这一轮看到的结果可能不完整：" +
                "没被列到的图片会被当成「云端缺这一份」而重传一次。重传是安全的，只是白传。",
            more: (count: number) => `另有 ${count} 项未列出。`,
            action: {
                upload: "上传",
                download: "下载",
                conflict: "冲突",
                skip: "跳过",
            },
            reason: {
                "local-new": "本地新增",
                "local-changed": "本地有改动",
                "remote-new": "云端新增",
                "remote-changed": "云端有改动",
                "local-deleted": "本地已删除（云端保留）",
                conflict: "两边都改过",
                "in-sync": "一致",
            },
        },

        editor: {
            title: (name: string) => `裁剪 / 压缩：${name}`,
            /**
             * svg 与 gif 的拒绝理由必须写出来。
             *
             * 只说「不支持这个格式」的话，用户会去试别的操作，或者以为插件坏了 ——
             * 而真实原因是**画布会毁掉这两种格式**（矢量被栅格化、动图只剩第一帧）。
             */
            unsupported:
                "这个格式不能用画布重新编码：SVG 会被栅格化成位图，GIF 只会保留第一帧。" +
                "请先转成 PNG / JPEG / WebP 再编辑。",
            readFailed: "读取这张图片失败。",
            decodeFailed: "无法解码这张图片，它可能已损坏，或这个格式在当前平台不受支持。",
            format: "输出格式",
            formatDesc: "换格式对体积的影响往往比调质量更大。WebP 一般比 JPEG 小四分之一左右，且支持透明。",
            quality: "质量",
            qualityDesc: "只对有损格式有效（JPEG / WebP）。PNG 是无损的，这一项对它不起作用。",
            maxEdge: "最长边（像素）",
            maxEdgeDesc: "0 表示不缩放。只缩不放 —— 放大小图只会更模糊、更大。",
            ratio: "锁定比例",
            ratioDesc: "拖动选框时保持比例。",
            ratioFree: "自由",
            ratioOriginal: "原图比例",
            ratioSquare: "1:1",
            overwrite: "覆盖原图",
            overwriteDesc:
                "关掉则另存为新文件（同目录，文件名加 -edited 后缀），原图保持不变。" +
                "覆盖是多数人的意图 —— 笔记里的链接指着原文件，另存会让链接指向旧图。",
            targetOverwrite: (path: string) => `将写回：${path}`,
            targetNew: (path: string) => `将新建：${path}`,
            reset: "重置选框",
            cancel: "取消",
            save: "保存",
            saving: "正在保存…",
            /**
             * 输出信息。字节数是**真的编码一遍**量出来的，不是估算 ——
             * 用公式估的 jpeg 体积能差两三倍，那等于编数字。
             */
            summary: (width: number, height: number, size: string, extension: string) =>
                `输出：${width} × ${height} · ${size} · .${extension}`,
            saveFailed: "保存图片失败",
            /**
             * 保存成功。
             *
             * 要说清「存到哪儿了」：另存模式下文件不叫原名，而用户下一步
             * 往往就是去笔记里改链接 —— 不给路径的话他得自己去找。
             */
            saved: (path: string) => `已保存 ${path}`,
        },

        /**
         * 图片管理面板。
         *
         * ## 这一页的文案原则：把「后果」写在按钮附近，而不是藏在文档里
         *
         * 这里的每个按钮都会**改文件**（删除、重命名、覆盖）。而重命名会连带
         * 改掉笔记里的链接、删除会留下墓碑（下次同步不再把图补回来）—— 这些
         * 都不是按钮文字能表达的。所以确认框里必须逐条说清。
         */
        manager: {
            title: "图片管理",

            scanning: "正在扫描库里的图片与引用…",
            scanningOf: (done: number, total: number) => `正在扫描引用… ${done}/${total}`,
            scanFailed: "扫描图片与引用失败",
            loading: "正在扫描…",

            /** 六个统计数字。标签要短 —— 它们并排显示在一行里。 */
            statLocal: "本地",
            statRemote: "云端",
            statLinked: "已链接",
            statOrphan: "失联",
            statTotal: "合计",
            statLocalBytes: "本地体积",

            /**
             * 云端列举失败时必须显式说明。
             *
             * 不说的话，列表里「云端」这一列全是空的，用户会读成「云端一张都没有」，
             * 进而放心地把本地全删了 —— 而真相是**根本没读到云端**。
             */
            remoteFailed: (message: string) => `没能读取云端列表：${message}。列表里「云端」这一列不可信。`,
            notConfigured: "图片同步还没配置好，所以只能看到本地与引用情况。",
            truncated: "云端对象超过了一次列举的上限，这一轮看到的结果可能不完整。",

            filterLocal: "本地",
            filterRemote: "云端",
            filterLinked: "已链接",
            filterState: {
                any: "任意",
                yes: "有",
                no: "无",
            },
            minSize: "最小体积",
            minSizeUnit: "KB",
            sort: "排序",
            sortOption: {
                path: "按路径",
                "size-desc": "体积大 → 小",
                "size-asc": "体积小 → 大",
            },
            search: "搜索",
            searchPlaceholder: "路径包含…",

            presetOrphans: "失联图片",
            presetPendingUpload: "待上传",
            presetRemoteOnly: "仅云端",
            presetLarge: "大图",
            presetReset: "重置筛选",

            selectAll: "全选",
            clearSelection: "清空选择",
            selectedCount: (count: number) => `已选 ${count}`,
            shown: (visible: number, total: number) => `显示 ${visible} / ${total}`,
            empty: "这个库里没有受管文件夹中的图片。",
            emptyFiltered: "没有符合当前筛选条件的图片。",
            capped: (hidden: number) => `另有 ${hidden} 项未显示 —— 请用筛选缩小范围。`,

            columnPath: "路径",
            columnSize: "体积",
            columnState: "状态",
            badgeLocal: "本地",
            badgeRemote: "云端",
            badgeLinked: (count: number) => `已链接 ×${count}`,
            badgeOrphan: "无人引用",

            actionSync: "同步选中",
            actionCompress: "压缩并同步",
            /** 底部那颗 —— 它管的是「勾选了一批」，与行内的单文件重命名是两条路。 */
            actionRename: "批量重命名",
            /** 列表里每一行那个铅笔按钮的标签（只有图标，含义全靠它）。 */
            renameThis: "重命名这个文件",
            /** 行内缩略图的标签 —— 它就是那个「点开看大图」的入口。 */
            previewOpen: "查看大图",
            previewZoomIn: "放大",
            previewZoomOut: "缩小",
            previewZoomReset: "重置缩放",
            /** 图片比窗口大时的提示（此时只能靠拖动看其余部分）。 */
            previewPannable: "可拖动",
            previewPannableHint: "图片比窗口大，按住拖动查看其余部分",
            actionDeleteLocal: "删除本地",
            actionDeleteBoth: "删除本地 + 云端",
            noSelection: "先在上面的列表里勾选要处理的图片。",
            compressHint: (params: string) =>
                `压缩参数取自设置页（质量 / 最长边 = ${params}），**保持原格式**，且只在变小的时候才写回。`,

            syncing: "正在同步选中的图片…",
            syncDone: (uploaded: number, downloaded: number, failed: number) =>
                failed > 0
                    ? `选中同步完成：上传 ${uploaded}，下载 ${downloaded}，失败 ${failed}。`
                    : `选中同步完成：上传 ${uploaded}，下载 ${downloaded}。`,
            syncFailed: "同步选中的图片失败",
            syncFailedMany: (count: number) => `有 ${count} 张没能同步。`,

            compressing: "正在压缩…",
            compressingOf: (done: number, total: number) => `正在压缩… ${done}/${total}`,
            compressNothing: (skipped: number) =>
                `没有图片被压缩 —— ${skipped} 张要么不支持重编码（SVG / GIF），要么压完反而更大。`,
            compressDone: (count: number, saved: string, skipped: number) =>
                `已压缩 ${count} 张，省下 ${saved}${skipped > 0 ? `（另有 ${skipped} 张跳过）` : ""}。`,
            compressFailed: (count: number, sample: string) =>
                `有 ${count} 张压缩失败，例如 ${sample}。`,

            renaming: "正在重命名…",
            renameTitle: (count: number) => `重命名 ${count} 张图片`,
            renameDesc: (placeholders: string) =>
                `用模板拼新文件名，可用占位符：${placeholders}。目录不变 —— 笔记里的链接由 Obsidian 跟着更新。`,
            renameTemplate: "文件名模板",
            renameStart: "起始序号",
            renamePreviewCount: (renameable: number, total: number) =>
                `将重命名 ${renameable} 张（共选中 ${total} 张）。`,
            renameProblem: {
                unchanged: "名字没变，跳过",
                invalid: "名字不合法，跳过",
                taken: "目标已存在，跳过",
                extChanged: "改了扩展名，跳过",
            },
            renameConfirm: (count: number) => `重命名 ${count} 张`,
            renameCancel: "取消",
            renameDone: (renamed: number, planned: number) => `已重命名 ${renamed} / ${planned} 张。`,
            renameFailedMany: (count: number, sample: string) =>
                `有 ${count} 张没能重命名，例如 ${sample}。`,
            renameMissing: "文件已经不在库里了",

            renameFileTitle: "重命名文件",
            renameFileDesc: "只改文件名，目录不变。不写扩展名就沿用原来的；笔记里指向它的链接会跟着更新。",
            renameFileName: "文件名",
            renameFileConfirm: "重命名",
            renameFileDone: (name: string) => `已重命名为 ${name}。`,

            deleting: "正在删除…",
            deleteDone: (local: number, remote: number, failed: number) =>
                failed > 0
                    ? `已删除本地 ${local} 张、云端 ${remote} 份，失败 ${failed} 张。`
                    : `已删除本地 ${local} 张、云端 ${remote} 份。`,
            deleteFailed: "批量删除失败",
            deleteFailedMany: (count: number, sample: string) =>
                `有 ${count} 张没能删除，例如 ${sample}。`,

            confirmLocalTitle: (count: number) => `只删除本地的 ${count} 张图片？`,
            confirmLocalDesc:
                "本地这一份会被移入回收站（按你在「设置 → 文件与链接 → 删除文件」里选的方式）。" +
                "云端那一份保留 —— 但**不会再同步回这台设备**：SyncHub 会记下「你已经删过它」，" +
                "否则下一轮同步会把它们下载回来。",
            confirmLocalOk: (count: number) => `删除本地 ${count} 张`,

            confirmBothTitle: (count: number) => `删除本地与云端的 ${count} 张图片？`,
            confirmBothDesc:
                "本地这一份进回收站，云端那一份被真的删除。这一步之后，两边都不再有它们。",
            confirmBothWarningHeading: "云端删除不可撤销",
            confirmBothWarning:
                "本地那份大概率还能从回收站找回来，但云端**没有回收站** —— 删掉就真的没有了" +
                "（除非你在别处还有副本）。另外，如果你在笔记里引用过它们，那些链接会变成断链。",
            confirmBothOk: (count: number) => `删除 ${count} 张（含云端）`,
            confirmCancel: "取消",
        },

        errors: {
            notConfigured: (missing: string) =>
                `图片同步还没配置好，缺少：${missing}。请在「图片同步」设置页补全。`,
            noFolders:
                "还没有指定受管的图片文件夹。请在「图片同步」设置页填写一个（例如 attachments）。",
            authFailed:
                "R2 拒绝了这次请求：Access Key ID 或 Secret Access Key 不正确，" +
                "或者这个令牌没有访问该桶的权限。",
            bucketNotFound: (bucket: string) =>
                `找不到存储桶 ${bucket}。请核对桶名，以及令牌是否授权了这个桶。`,
            listFailed: (status: number, detail: string) =>
                `列举云端对象失败（HTTP ${status}）：${detail}`,
            uploadFailed: (path: string, status: number, detail: string) =>
                `上传 ${path} 失败（HTTP ${status}）：${detail}`,
            downloadFailed: (path: string, status: number, detail: string) =>
                `下载 ${path} 失败（HTTP ${status}）：${detail}`,
            deleteFailed: (path: string, status: number, detail: string) =>
                `删除云端的 ${path} 失败（HTTP ${status}）：${detail}`,
            network: (detail: string) =>
                `连接 R2 失败：${detail}。请检查网络（或代理）后重试。`,
            localReadFailed: (path: string, detail: string) =>
                `读取本地文件 ${path} 失败：${detail}`,
            localWriteFailed: (path: string, detail: string) =>
                `写入本地文件 ${path} 失败：${detail}`,
            decodeFailed: (path: string) =>
                `无法解码 ${path}，它可能已损坏，或这个格式在当前平台不受支持。`,
        },
    },
};

/**
 * 注意：这里刻意**不加** `as const`。
 * 加了会把所有字符串收窄成字面量类型，导致其他语言无法满足该类型。
 * 需要的是「结构一致」，不是「取值一致」。
 */
export type LocaleStrings = typeof zhCN;
