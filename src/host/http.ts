import { requestUrl } from "obsidian";
import { NetworkError } from "./errors";
import { redactUrl } from "./redact";

/**
 * 对 Obsidian `requestUrl` 的薄封装。
 *
 * 为什么不直接用 `fetch`：Obsidian 的 `requestUrl` 绕开渲染进程的 CORS 限制，
 * 这是插件能直接调 api.github.com / gitee.com 的前提。参考项目 BRAT 也是这么做的。
 *
 * 注意一个容易踩的坑：`requestUrl` 的 `throw` 选项**默认为 true**，
 * 也就是 HTTP 400+ 会直接抛异常。我们要自己按状态码分派错误类型
 * （限流 / 鉴权 / 不存在），所以必须显式传 `throw: false`。
 */

export interface HttpResponse {
    status: number;
    headers: Record<string, string>;
    text: string;
    arrayBuffer: ArrayBuffer;
}

export interface HttpRequestOptions {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string | ArrayBuffer;
    /** 额外重试次数（不含首次请求）。默认 2。 */
    retries?: number;
    /** 单次请求超时毫秒数。默认 20000。 */
    timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 400;

/** 调试日志开关，由插件在加载设置后注入。 */
let debugLogger: ((message: string) => void) | undefined;

export function setHttpDebugLogger(logger: ((message: string) => void) | undefined): void {
    debugLogger = logger;
}

function sleep(ms: number): Promise<void> {
    // `window.` 前缀不是装饰：审核的 `prefer-window-timers` 要求用 window 上的定时器，
    // 否则插件在**弹出窗口**（popout window）里行为不一致。
    return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/**
 * 哪些状态码值得重试。
 *
 * 刻意**不含 429**：限流重试只会浪费配额，正确做法是把恢复时间告诉用户。
 * 429 由 host 层转成 `RateLimitError`。
 */
function isRetryableStatus(status: number): boolean {
    return status === 408 || (status >= 500 && status <= 599);
}

function withTimeout<T>(promise: Promise<T>, ms: number, url: string): Promise<T> {
    // `window.setTimeout` 返回 number（Node 的返回 Timeout 对象）—— 这里必须
    // 用 window 上的那一份，插件在 popout window 里才不会错乱（审核规则
    // `prefer-window-timers`）。所以类型也跟着写 number。
    let timer: number | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = window.setTimeout(
            () => reject(new NetworkError(`Request to ${url} timed out after ${ms}ms.`)),
            ms
        );
    });
    return Promise.race([promise, timeout]).finally(() => {
        if (timer !== undefined) window.clearTimeout(timer);
    }) as Promise<T>;
}

/** 把响应头统一小写，避免不同平台大小写不一致导致取不到值。 */
function normalizeHeaders(headers: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers ?? {})) {
        out[key.toLowerCase()] = value;
    }
    return out;
}

/** 大小写不敏感地取响应头。 */
export function getHeader(
    headers: Record<string, string>,
    name: string
): string | undefined {
    return headers[name.toLowerCase()];
}

/**
 * 发一次请求。
 *
 * **HTTP 错误状态不会抛异常** —— 返回带 `status` 的响应，由调用方决定怎么解释。
 * 只有传输层失败（连不上、超时、重试耗尽）才抛 `NetworkError`。
 */
export async function httpRequest(options: HttpRequestOptions): Promise<HttpResponse> {
    const retries = options.retries ?? DEFAULT_RETRIES;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let lastError: unknown;

    /**
     * 日志与错误消息里一律用它，**不用 `options.url`**。
     *
     * 实际请求照旧发 `options.url`（Gitee 必须把令牌放查询串）。区别只在
     * 呈现给人和写进日志的那一份 —— 否则 Gitee 每次请求失败，令牌都会
     * 出现在屏幕上的错误提示里（Notifier 会把 NetworkError 的消息原样弹出来）
     * 和控制台输出里，而后者正是用户报 issue 时要贴的东西。
     */
    const displayUrl = redactUrl(options.url);

    /**
     * 实际发出去的请求次数。
     *
     * **不能用 `retries + 1` 反推** —— 传输层失败会立刻 `break`（见下面的说明），
     * 所以发出去几次取决于失败发生在第几轮。写死 `retries + 1` 会让日志里出现
     * 「failed after 3 attempt(s)」而实际只发了 1 次，排查网络问题时把人带偏
     * （去找那两次不存在的重试）。
     */
    let attemptsMade = 0;

    for (let attempt = 0; attempt <= retries; attempt++) {
        if (attempt > 0) {
            const delay = RETRY_BASE_DELAY_MS * 3 ** (attempt - 1);
            debugLogger?.(`[http] retry ${attempt}/${retries} after ${delay}ms — ${displayUrl}`);
            await sleep(delay);
        }

        attemptsMade += 1;

        try {
            const response = await withTimeout(
                requestUrl({
                    url: options.url,
                    method: options.method ?? "GET",
                    headers: options.headers,
                    body: options.body,
                    throw: false,
                }),
                timeoutMs,
                displayUrl
            );

            const normalized: HttpResponse = {
                status: response.status,
                headers: normalizeHeaders(response.headers),
                text: response.text,
                arrayBuffer: response.arrayBuffer,
            };

            if (isRetryableStatus(response.status) && attempt < retries) {
                lastError = new NetworkError(
                    `HTTP ${response.status} from ${displayUrl}.`
                );
                continue;
            }

            debugLogger?.(`[http] ${response.status} ${options.method ?? "GET"} ${displayUrl}`);
            return normalized;
        } catch (err) {
            // **传输层失败不重试。**
            //
            // 超时 / DNS 失败 / 连接被拒这类错误是确定性的：再试两次只是把
            // 「等 20 秒」变成「等 62 秒」，而调用方的降级路径往往立刻就能成功。
            // 实测场景：GitHub 资产 CDN（github.com → objects.githubusercontent.com）
            // 不可达时，安装器是**逐文件**回退的（manifest.json / main.js / styles.css），
            // 每个文件各付 62 秒 = 卡三分钟 —— 而这正是国内网络的常态。
            // 不重试后降到 20 秒，再配合调用方的「记住资产通道失败」，总计 20 秒。
            //
            // 值得重试的是**服务端临时故障**（5xx / 408），那些会很快返回状态码，
            // 见上面的 `isRetryableStatus` 分支。
            lastError = err;
            debugLogger?.(`[http] attempt ${attempt} failed — ${displayUrl}: ${String(err)}`);
            break;
        }
    }

    // `detail` 也过一遍脱敏：底层错误（Electron 的 net 层等）有时会把请求地址
    // 带进自己的消息里，而那个地址同样是带令牌的那一份。
    const detail = redactUrl(lastError instanceof Error ? lastError.message : String(lastError));
    throw new NetworkError(
        `Request to ${displayUrl} failed after ${attemptsMade} attempt(s): ${detail}`,
        { cause: lastError }
    );
}

export interface JsonResponse<T> {
    status: number;
    headers: Record<string, string>;
    /** 响应体不是合法 JSON 时为 undefined。 */
    data: T | undefined;
    /** 原始文本，用于错误信息里展示服务端的说明。 */
    text: string;
}

/** 发请求并解析 JSON。解析失败不抛异常，把 `data` 留成 undefined。 */
export async function httpJson<T>(options: HttpRequestOptions): Promise<JsonResponse<T>> {
    const response = await httpRequest(options);
    let data: T | undefined;
    try {
        data = response.text ? (JSON.parse(response.text) as T) : undefined;
    } catch {
        data = undefined;
    }
    return { status: response.status, headers: response.headers, data, text: response.text };
}

/**
 * 逐段编码路径，保留 `/` 作为分隔符。
 *
 * 不能用 `encodeURIComponent` 整体编码：文件路径和含斜杠的分支名
 * （例如 `feature/new-ui`）都必须保留斜杠，否则远端会 404。
 */
export function encodePathSegments(value: string): string {
    return value
        .split("/")
        .filter((segment) => segment.length > 0)
        .map(encodeURIComponent)
        .join("/");
}

/**
 * 从错误响应体里挖出服务端给的人类可读说明。
 *
 * GitHub 用 `message`，Gitee 用 `message` 或 `error`，字段名不统一，
 * 所以三个都试一遍，最后兜底截断原始文本。
 */
export function extractServerMessage(text: string): string {
    if (!text) return "";
    try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        for (const key of ["message", "error", "error_description"]) {
            const value = parsed[key];
            if (typeof value === "string" && value.trim()) return value.trim();
        }
    } catch {
        // 不是 JSON，直接当文本用
    }
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat;
}
