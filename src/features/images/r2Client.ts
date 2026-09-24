import { getHeader, httpRequest, extractServerMessage, type HttpResponse } from "../../host/http";
import { ImageSyncError } from "./errors";
import {
    EMPTY_PAYLOAD_SHA256,
    authorizationHeader,
    canonicalQueryString,
    encodeCanonicalPath,
    formatAmzDate,
} from "./sigv4";
import { sha256Hex } from "./sha256";
import type { RemoteObject } from "./types";

/**
 * Cloudflare R2 的 S3 兼容客户端。
 *
 * ## 为什么走 S3 协议而不是 R2 的某个「专用」接口
 *
 * R2 对外只提供 S3 兼容接口（外加一个 Workers 绑定，插件用不上）。
 * 所以鉴权就是 AWS SigV4、操作就是 ListObjectsV2 / PutObject / GetObject / DeleteObject。
 * 这里刻意不引入 `@aws-sdk/client-s3`：那个包在浏览器环境下要几百 KB，
 * 而我们要用到的只有四个操作 —— 自己写反而更小、更可控，也能被单测完整覆盖。
 *
 * ## 路径风格（path-style）
 *
 * URL 形状是 `https://<account>.r2.cloudflarestorage.com/<bucket>/<key>`，
 * 即桶名在路径里，不在域名里。R2 两种都支持，但路径风格不需要通配符 DNS
 * 和证书，配置出错的概率更低。
 *
 * ## 与 `host/http.ts` 的关系
 *
 * 请求统一走 `httpRequest`（Obsidian `requestUrl` 的薄封装），于是重试、
 * 超时、调试日志这三件事与其他模块**同一套行为**，不另起炉灶。
 * 它的「HTTP 错误不抛异常」约定也正好合用：状态码在这里被翻译成领域错误。
 */

export interface R2Config {
    /** 端点，不带尾斜杠（例如 `https://abc123.r2.cloudflarestorage.com`）。 */
    endpoint: string;
    /** 从端点解析出的 host —— SigV4 必须签它。 */
    host: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    /** 对象键前缀（已归一：无前后斜杠；空串表示桶根）。 */
    prefix: string;
}

const SERVICE = "s3";
/** R2 只认 `auto`。写成具体区域会让签名与对端不一致，表现为 403。 */
const REGION = "auto";
const LIST_PAGE_SIZE = 1000;
/**
 * 列举页数上限。
 *
 * 桶里放了几万个对象时，无限翻页会把界面卡在一个转圈的按钮上。
 * 到上限就停下来并**标记截断** —— 调用方据此拒绝执行删除动作
 * （见 `SyncPlan.truncated` 的说明）。
 */
const MAX_LIST_PAGES = 20;
/** 传输单个文件的超时。比默认的 20 秒长得多：几十 MB 的图片在慢网络下要一会儿。 */
const TRANSFER_TIMEOUT_MS = 120_000;

interface SendOptions {
    method: string;
    /** 未编码的路径，带前导 `/`。 */
    path: string;
    query?: Record<string, string>;
    payloadHash: string;
    body?: ArrayBuffer;
    contentType?: string;
    timeoutMs?: number;
}

export class R2Client {
    constructor(private readonly config: R2Config) {}

    /** 桶里的对象键前缀（状态行展示用）。 */
    get prefix(): string {
        return this.config.prefix;
    }

    /** 把一个 vault 路径映射成对象键。 */
    keyFor(path: string): string {
        return `${this.config.prefix}${path}`;
    }

    /**
     * 列出桶里（前缀下）的全部对象。
     *
     * 返回 `truncated` 而不是抛错：截断本身不是失败，但它会让「云端有什么」
     * 这个判断不完整，调用方必须知道。
     */
    async listAll(): Promise<{ objects: RemoteObject[]; truncated: boolean }> {
        const objects: RemoteObject[] = [];
        let token: string | undefined;

        for (let page = 0; page < MAX_LIST_PAGES; page++) {
            const result = await this.listPage(token);
            objects.push(...result.items);

            if (!result.next) {
                // **以响应里的 `IsTruncated` 为准**，不是「有没有下一页」。
                // 服务端说截断了却没给 token 时（畸形响应、代理改写），
                // 「没有下一页」不等于「列举完整」—— 而把不完整的列举当成完整，
                // 会让「云端没有这个对象」这个前提成立，进而删掉本地文件。
                // 这是删除路径上唯一一个「宁可少做事」的位置。
                return { objects, truncated: result.truncated };
            }
            token = result.next;
        }

        return { objects, truncated: true };
    }

    /** 上传（覆盖）一个对象，返回它的 ETag。 */
    async putObject(
        key: string,
        body: ArrayBuffer,
        contentType: string
    ): Promise<string> {
        const payloadHash = sha256Hex(new Uint8Array(body));
        const response = await this.send({
            method: "PUT",
            path: `/${this.config.bucket}/${key}`,
            payloadHash,
            body,
            contentType,
            timeoutMs: TRANSFER_TIMEOUT_MS,
        });

        if (response.status === 403) {
            throw new ImageSyncError("authFailed", { status: response.status });
        }
        if (response.status >= 400) {
            throw new ImageSyncError("uploadFailed", {
                path: key,
                status: response.status,
                detail: extractServerMessage(response.text),
            });
        }

        // R2 在 ETag 里带引号（`"abc"`）；有些实现不带，所以两种都兼容。
        return stripQuotes(getHeader(response.headers, "etag") ?? payloadHash);
    }

    /** 下载一个对象。 */
    async getObject(key: string): Promise<ArrayBuffer> {
        const response = await this.send({
            method: "GET",
            path: `/${this.config.bucket}/${key}`,
            payloadHash: EMPTY_PAYLOAD_SHA256,
            timeoutMs: TRANSFER_TIMEOUT_MS,
        });

        if (response.status === 403) {
            throw new ImageSyncError("authFailed", { status: response.status });
        }
        if (response.status >= 400) {
            throw new ImageSyncError("downloadFailed", {
                path: key,
                status: response.status,
                detail: extractServerMessage(response.text),
            });
        }

        return response.arrayBuffer;
    }

    /**
     * 删除一个对象。
     *
     * **404 视为成功**：S3 的 DELETE 本来就不保证幂等可见（同一秒内重复删
     * 同一个键会先 204 后 404），而我们真正的诉求是「它不在了」。
     * 把 404 当失败会让「双向删除」在重跑时反复报错。
     */
    async deleteObject(key: string): Promise<void> {
        const response = await this.send({
            method: "DELETE",
            path: `/${this.config.bucket}/${key}`,
            payloadHash: EMPTY_PAYLOAD_SHA256,
        });

        if (response.status === 403) {
            throw new ImageSyncError("authFailed", { status: response.status });
        }
        if (response.status >= 400 && response.status !== 404) {
            throw new ImageSyncError("deleteFailed", {
                path: key,
                status: response.status,
                detail: extractServerMessage(response.text),
            });
        }
    }

    /**
     * 打一次最小代价的列举，用来判断「这套凭据能不能用」。
     *
     * 刻意不用 HEAD 桶（`HeadBucket`）：某些代理会把 HEAD 的响应体丢掉，
     * 出错时看不出原因；而列举的响应体里带着服务端的说明文字。
     */
    async testConnection(): Promise<{ ok: true } | { ok: false; error: unknown }> {
        try {
            await this.listPage(undefined);
            return { ok: true };
        } catch (error) {
            return { ok: false, error };
        }
    }

    // ── 内部 ──────────────────────────────────────────────────────────────

    private async listPage(
        token: string | undefined
    ): Promise<{ items: RemoteObject[]; next?: string; truncated: boolean }> {
        const query: Record<string, string> = {
            "list-type": "2",
            "max-keys": String(LIST_PAGE_SIZE),
        };
        if (this.config.prefix) query.prefix = this.config.prefix;
        if (token) query["continuation-token"] = token;

        const response = await this.send({
            method: "GET",
            path: `/${this.config.bucket}`,
            query,
            payloadHash: EMPTY_PAYLOAD_SHA256,
        });

        if (response.status === 403) {
            throw new ImageSyncError("authFailed", { status: response.status });
        }
        if (response.status === 404) {
            throw new ImageSyncError("bucketNotFound", { bucket: this.config.bucket });
        }
        if (response.status >= 400) {
            throw new ImageSyncError("listFailed", {
                status: response.status,
                detail: extractServerMessage(response.text),
            });
        }

        return parseListResponse(response.text);
    }

    private async send(options: SendOptions): Promise<HttpResponse> {
        const query = options.query ?? {};
        const amzDate = formatAmzDate(new Date());

        const headers: Record<string, string> = {
            host: this.config.host,
            "x-amz-content-sha256": options.payloadHash,
            "x-amz-date": amzDate,
        };

        const authorization = authorizationHeader({
            method: options.method,
            path: options.path,
            query,
            headers,
            payloadHash: options.payloadHash,
            accessKeyId: this.config.accessKeyId,
            secretAccessKey: this.config.secretAccessKey,
            region: REGION,
            service: SERVICE,
            amzDate,
        });

        const encodedPath = encodeCanonicalPath(options.path);
        const queryString = queryForUrl(query);
        const url = `${this.config.endpoint}${encodedPath}${queryString}`;

        try {
            return await httpRequest({
                url,
                method: options.method,
                headers: {
                    // 只把**实际要发**的头交出去；`host` 由 HTTP 层按 URL 填，
                    // 我们不设它（也不该设）—— 但签名里必须有它，且值要一致。
                    "x-amz-content-sha256": options.payloadHash,
                    "x-amz-date": amzDate,
                    authorization,
                    ...(options.contentType ? { "Content-Type": options.contentType } : {}),
                },
                body: options.body,
                timeoutMs: options.timeoutMs,
                // 5xx 由 httpRequest 自己重试；这里不额外加次数。
                retries: 2,
            });
        } catch (error) {
            // 传输层失败（连不上 / 超时）。`httpRequest` 已经脱敏过 URL 与消息，
            // 这里只负责换成领域错误，让界面能说人话。
            throw new ImageSyncError(
                "network",
                { detail: error instanceof Error ? error.message : String(error) },
                { cause: error }
            );
        }
    }
}

/**
 * 拼实际请求用的查询串。
 *
 * **必须与签名时用的一致** —— 所以这里直接复用 `canonicalQueryString`，
 * 而不是另写一遍（或交给 `URLSearchParams`：它对空格编成 `+`，而规范要求 `%20`，
 * 结果是签名与请求对不上，对端返回 403 而看不出原因）。
 */
function queryForUrl(query: Record<string, string>): string {
    const encoded = canonicalQueryString(query);
    return encoded.length > 0 ? `?${encoded}` : "";
}

function stripQuotes(value: string): string {
    return value.replace(/^"|"$/g, "");
}

/** XML 实体反转义。键里出现 `&` `'` 都很正常（文件名如此）。 */
function unescapeXml(value: string): string {
    return value
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
        // `&amp;` **必须最后**替换：放前面会把 `&amp;lt;` 变成 `<`（双重转义的文件名）。
        .replace(/&amp;/g, "&");
}

function tagValue(block: string, tag: string): string | undefined {
    const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(block);
    return match ? unescapeXml(match[1]) : undefined;
}

/**
 * 解析 ListObjectsV2 的响应。
 *
 * 为什么用正则而不是 `DOMParser`：`DOMParser` 在 Node（测试环境）里不是全局对象，
 * 而这里要解析的 XML 形状是固定的、由 AWS 规范钉死的 —— 正则足够，
 * 而且能在一段纯函数里被完整测试。
 *
 * `truncated` 与 `next` **分开返回**：服务端说截断了却没给 token 时，
 * 调用方仍然要知道「这一份列举不完整」（见 `listAll` 里的说明）。
 */
export function parseListResponse(xml: string): {
    items: RemoteObject[];
    next?: string;
    truncated: boolean;
} {
    const items: RemoteObject[] = [];

    for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const block = match[1];
        const key = tagValue(block, "Key");
        if (!key) continue;

        const size = Number.parseInt(tagValue(block, "Size") ?? "0", 10);
        const lastModified = Date.parse(tagValue(block, "LastModified") ?? "");

        items.push({
            key,
            size: Number.isFinite(size) ? size : 0,
            etag: stripQuotes(tagValue(block, "ETag") ?? ""),
            // 时间戳解析不出来时给 0 —— 它的唯一用途是「比谁更新」，
            // 而 0 会让冲突判定偏向「本地更新」，比编一个当前时间安全。
            lastModified: Number.isFinite(lastModified) ? lastModified : 0,
        });
    }

    const truncated = tagValue(xml, "IsTruncated") === "true";
    const next = truncated ? tagValue(xml, "NextContinuationToken") : undefined;

    return { items, truncated, ...(next ? { next } : {}) };
}
