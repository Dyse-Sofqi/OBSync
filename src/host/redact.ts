/**
 * URL / 文本里的凭据脱敏。
 *
 * ## 为什么必须有这一层
 *
 * Gitee 的鉴权是把令牌拼进查询串（`?access_token=...`，见 `IRepoHost.applyAuth`），
 * 而 `http.ts` 会把 URL 原样写进错误消息与调试日志。于是 **任何一次 Gitee 请求失败**，
 * 令牌都会同时出现在两个地方：
 *
 * 1. 错误提示里 —— `Notifier.describeError` 把 `NetworkError.message` 交给
 *    `t.host.networkFailed()` 再 `new Notice(...)`，也就是**弹在屏幕上**，
 *    用户随手截个图就带出去了；
 * 2. `console.warn/error` 的输出里 —— 而用户报 issue 时正是要贴这段输出。
 *
 * 令牌本身存在系统密钥库里（`core/secretStore`，刻意绕开 `data.json`），
 * 却从错误消息这条侧路原样漏出去，前面那些功夫等于白做。
 *
 * ## 为什么放在 host 层、判定按「参数名」而不是「哪个平台」
 *
 * 所有网络请求都经过 `httpRequest`，那是唯一的收口点 —— 放在这里，
 * 上层（host 各方法、安装器、同步）不必各自记得该脱敏什么。
 *
 * 判定不看平台：这是**通用**规则。GitHub 现在把令牌放请求头，但
 * 一旦错误消息里出现带令牌的 URL（例如资产下载地址被追加查询参数、
 * 或者用户把 `https://oauth2:TOKEN@gitee.com/...` 这种克隆地址粘进来），
 * 同一条规则同样能兜住。
 *
 * ## 顺序要点
 *
 * 先处理 `userinfo`（`scheme://user:secret@host`）再处理查询串。
 * 两者互不重叠，但顺序固定下来更好推理：userinfo 在查询串之前，
 * 而且它会把 `oauth2:TOKEN@` 这种形态整段换掉，先清掉能少一种边界情况。
 */

const REDACTED = "***";

/**
 * 参数名里出现这些词就当值是凭据。
 *
 * 拆成「词段」再比，所以 `access_token` / `private-token` / `api_key`
 * 都能命中而不必逐个列举。
 */
const SECRET_WORDS = new Set([
    "token",
    "secret",
    "password",
    "passwd",
    "pwd",
    "auth",
    "credential",
    "signature",
    "key",
    // 连写形式（按分隔符切不出来）
    "apikey",
    "accesskey",
    "secretkey",
]);

/** 自由文本里也可能嵌着 `scheme://user:pass@host`，所以不加 `^` 锚点。 */
const USERINFO_RE = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/?#\s@]*@)/g;

/**
 * 这些协议的 userinfo **只有用户名**，不可能是凭据。
 *
 * SSH 系地址里的 `git@` 就是登录名，这个位置没有「把令牌当用户名」的用法 ——
 * 而它又极其常见（本项目的输入提示自己就写着 `git@host:path`）。
 * 不排除它的话，每一个正常的 SSH 远端都会被判成「地址里有令牌」，
 * 提示变成噪音，真正该被看见的那条也就没人看了。
 *
 * 反过来，`https://TOKEN@github.com/...` 是确实存在的用法
 * （GitHub / Gitee 都接受「令牌当用户名」），所以 http 系**必须**算凭据。
 * 白名单之外一律按凭据处理 —— 宁可多脱一点。
 */
const USERNAME_ONLY_SCHEMES = /^(?:git\+ssh|ssh|sftp):\/\/$/i;

function isSecretName(name: string): boolean {
    let decoded = name;
    try {
        decoded = decodeURIComponent(name);
    } catch {
        // 畸形百分号编码：按原样判断即可，反正比较的是字母。
    }
    const lower = decoded.toLowerCase();
    if (SECRET_WORDS.has(lower)) return true;
    return lower
        .split(/[^a-z0-9]+/)
        .some((segment) => segment.length > 0 && SECRET_WORDS.has(segment));
}

/**
 * userinfo 里只脱密码部分，保留用户名 —— 用户名不敏感，而且排查
 * 「凭据用户名不被平台接受」那类问题时它正是关键信息。
 *
 * 没有冒号时分两种情况：
 *
 * - **`https://TOKEN@github.com/...`** —— 这一段就是令牌本身，整段脱掉；
 * - **`ssh://git@host/...`** —— `git` 只是登录名，原样保留。
 *
 * 第二种曾是漏掉的（判成「地址里有凭据」），症状是正常的 SSH 远端被
 * 「编辑远端地址」弹窗警告「你的令牌会被明文写进 .git/config」。
 * 详见 `USERNAME_ONLY_SCHEMES`。
 */
function redactUserInfo(scheme: string, userinfo: string): string {
    const colon = userinfo.lastIndexOf(":");
    if (colon !== -1) return `${userinfo.slice(0, colon)}:${REDACTED}`;
    return USERNAME_ONLY_SCHEMES.test(scheme) ? userinfo : REDACTED;
}

/**
 * 查询串里的 `name=value`，值到下一个 `&` / `#` / **空白**为止。
 *
 * 用正则扫全文，而不是「先切出查询段再逐段比」：同一个地址在一条错误消息里
 * 可能出现不止一次（外层 `Request to X failed after N attempt(s): Request to Y timed out`），
 * 只处理「第一段查询」会漏掉后面那个。
 *
 * 值遇到空白就停，是因为**消息不是纯 URL** ——
 * `...?access_token=T failed after 2 attempt(s)` 里，值只是 `T`，
 * 后面的 ` failed after 2 attempt(s)` 是给人看的说明，必须留下。
 * 第一版按「`?` 之后全是查询串」处理，结果整条说明被吃掉，日志退化成
 * `Request to https://gitee.com/api/v5/repos/o/r?access_token=***`，
 * 看不出那次到底是超时还是失败 —— 这就是「过脱」的代价。
 */
const SECRET_PARAM_RE = /([?&])([^=&#\s]+)=([^&#\s]*)/g;

/**
 * 去掉一处或一段文本里的凭据，其余内容逐字保留。
 *
 * 刻意**不**走 `new URL()` 再 `toString()` 的往返：那样会规范化 URL
 * （补斜杠、重排），既让排查时看到的地址和实际发出去的不一样，
 * 也可能在畸形输入上直接抛错。这里只做定点替换。
 *
 * 同样因为它容忍「不是纯 URL」的输入，用户粘进来的
 * `git clone https://oauth2:TOKEN@gitee.com/...` 这种整条命令
 * 在错误消息里也会被脱敏。
 */
export function redactUrl(text: string): string {
    if (!text) return text;

    return text
        .replace(
            USERINFO_RE,
            (_match, scheme: string, userinfo: string) =>
                `${scheme}${redactUserInfo(scheme, userinfo.slice(0, -1))}@`
        )
        .replace(
            SECRET_PARAM_RE,
            (match, separator: string, name: string, value: string) =>
                value === REDACTED || !isSecretName(name)
                    ? match
                    : `${separator}${name}=${REDACTED}`
        );
}

/**
 * 这段文本里有没有凭据 —— 即「脱敏会不会改动它」。
 *
 * **刻意用 `redactUrl` 的结果来判定**，而不是另写一套识别规则：
 * 两者的判定范围一旦分叉，就会出现「警告了却脱不干净」或
 * 「脱干净了却不警告」这种自相矛盾的状态。这里只有一个事实来源。
 *
 * 用途是「编辑远端地址」时的提醒：项目刻意不把令牌写进 remote URL
 * （见 `features/sync/auth.ts` 的方案取舍 —— 会落进 `.git/config`、
 * `git remote -v` 一眼可见、还会随配置文件泄漏），
 * 所以用户粘一个带令牌的地址进来时该拦住他，而不是默默照写。
 */
export function containsCredentials(text: string): boolean {
    if (!text) return false;
    return redactUrl(text) !== text;
}
