import { requestUrl } from "obsidian";
import { NetworkError } from "./errors";

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
    return new Promise((resolve) => setTimeout(resolve, ms));
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
            () => reject(new NetworkError(`Request to ${url} timed out after ${ms}ms.`)),
            ms
        );
    });
    return Promise.race([promise, timeout]).finally(() => {
        if (timer !== undefined) clearTimeout(timer);
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

    for (let attempt = 0; attempt <= retries; attempt++) {
        if (attempt > 0) {
            const delay = RETRY_BASE_DELAY_MS * 3 ** (attempt - 1);
            debugLogger?.(`[http] retry ${attempt}/${retries} after ${delay}ms — ${options.url}`);
            await sleep(delay);
        }

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
                options.url
            );

            const normalized: HttpResponse = {
                status: response.status,
                headers: normalizeHeaders(response.headers),
                text: response.text,
                arrayBuffer: response.arrayBuffer,
            };

            if (isRetryableStatus(response.status) && attempt < retries) {
                lastError = new NetworkError(
                    `HTTP ${response.status} from ${options.url}.`
                );
                continue;
            }

            debugLogger?.(`[http] ${response.status} ${options.method ?? "GET"} ${options.url}`);
            return normalized;
        } catch (err) {
            lastError = err;
            debugLogger?.(`[http] attempt ${attempt} failed — ${options.url}: ${String(err)}`);
        }
    }

    const detail = lastError instanceof Error ? lastError.message : String(lastError);
    throw new NetworkError(
        `Request to ${options.url} failed after ${retries + 1} attempt(s): ${detail}`,
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
