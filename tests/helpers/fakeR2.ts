import { __setRequestUrlHandler } from "../stubs/obsidian";

/**
 * 假的 R2（S3 兼容）服务端。
 *
 * ## 为什么值得写一个「真」的假服务端
 *
 * `R2Client` 的价值全在**协议细节**上：路径风格、查询串的排序与编码、
 * `x-amz-*` 头、`ETag` 的引号、`IsTruncated` 的翻页。用
 * `vi.mock` 去替换 `R2Client` 自己（或者逐个用例塞一个响应字符串）测不到
 * 这些 —— 而那正是「本地全绿、真机上 403」的来源。
 *
 * 所以这里做的是**按 S3 的形状解释请求**：解析 URL 拿到桶与键、按前缀过滤、
 * 按 `continuation-token` 翻页、PUT 真的写进 map、DELETE 真的删掉。
 * 于是被测代码拿到的响应与真实 R2 同构，断言也能落在「发了什么请求」上。
 *
 * ## 它是**内存**的，没有网络、没有延迟
 *
 * 唯一的例外是 `throwOn`：它用来构造传输层失败（`requestUrl` 抛错），
 * 而 `httpRequest` 对这类失败**不重试**，所以不会拖慢测试。
 * 反过来说，**不要**用 `override` 返回 5xx —— `httpRequest` 会对 5xx 重试两次
 * （退避 400ms + 1200ms），每个用例白等 1.6 秒。
 */

export interface FakeObject {
    /** 对象大小（字节）。 */
    size: number;
    /** 已去掉引号的 ETag。 */
    etag: string;
    /** 最后修改时间（毫秒）。 */
    lastModified: number;
    /** 内容（GET 时返回）。不设时按 `size` 造一段字节。 */
    body?: ArrayBuffer;
}

export interface RecordedRequest {
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: string | ArrayBuffer;
    /** 解析出来的查询参数（已解码）。 */
    query: Record<string, string>;
    bucket: string;
    /** 对象键；列举请求为空串。 */
    key: string;
}

export interface FakeResponse {
    status: number;
    text?: string;
    headers?: Record<string, string>;
}

/** 处理器实际返回的形状（比 `FakeResponse` 多一条二进制通道）。 */
interface HandlerResponse extends FakeResponse {
    arrayBuffer?: ArrayBuffer;
}

export interface FakeR2 {
    /** 桶里的对象。测试直接改它来构造「云端有什么」。 */
    objects: Map<string, FakeObject>;
    /** 已收到的请求（按顺序）。断言「发了什么」用。 */
    requests: RecordedRequest[];
    /** 列举一页返回几个对象。设小一点就能造出翻页。 */
    pageSize: number;
    /** 每次列举都说「还有下一页」—— 用来触发 `listAll` 的翻页上限。 */
    endlessPagination: boolean;
    /** 覆盖响应。返回 `undefined` 表示按默认行为处理。 */
    override: ((request: RecordedRequest) => FakeResponse | undefined) | undefined;
    /** 让匹配的请求抛错（模拟连不上 / 超时）。 */
    throwOn: ((request: RecordedRequest) => Error | undefined) | undefined;

    /** 最后一次请求（没有请求时抛错 —— 那说明测试的假设就不成立）。 */
    last(): RecordedRequest;
    /** 某个键的请求数。 */
    countFor(key: string): number;
    /** 装上处理器（`beforeEach` 调）。 */
    install(): void;
    /** 卸下处理器（`afterEach` 调）。 */
    restore(): void;
}

function escapeXml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

/** 把请求 URL 拆成「桶 + 键 + 查询参数」。 */
function parseRequest(
    url: string,
    method: string,
    headers: Record<string, string>,
    body: string | ArrayBuffer | undefined
): RecordedRequest {
    const queryIndex = url.indexOf("?");
    const pathPart = queryIndex < 0 ? url : url.slice(0, queryIndex);
    const queryPart = queryIndex < 0 ? "" : url.slice(queryIndex + 1);

    const afterOrigin = pathPart.replace(/^https?:\/\/[^/]+/, "");
    const segments = afterOrigin.split("/").filter((segment) => segment.length > 0);
    const bucket = segments[0] ?? "";
    // 逐段解码 —— 整串 `decodeURIComponent` 会把键里真正的 `/` 与编码的 `%2F` 混起来。
    const key = segments.slice(1).map(decodeURIComponent).join("/");

    const query: Record<string, string> = {};
    for (const pair of queryPart.split("&")) {
        if (!pair) continue;
        const eq = pair.indexOf("=");
        const name = eq < 0 ? pair : pair.slice(0, eq);
        const value = eq < 0 ? "" : pair.slice(eq + 1);
        query[decodeURIComponent(name)] = decodeURIComponent(value);
    }

    return { method, url, headers, body, query, bucket, key };
}

function bodySize(body: string | ArrayBuffer | undefined): number {
    if (body === undefined) return 0;
    if (typeof body === "string") return new TextEncoder().encode(body).byteLength;
    return body.byteLength;
}

function toArrayBuffer(body: string | ArrayBuffer | undefined): ArrayBuffer {
    if (body === undefined) return new ArrayBuffer(0);
    if (typeof body === "string") return new TextEncoder().encode(body).buffer as ArrayBuffer;
    return body;
}

export function createFakeR2(): FakeR2 {
    const objects = new Map<string, FakeObject>();
    const requests: RecordedRequest[] = [];
    let putCount = 0;

    const state: FakeR2 = {
        objects,
        requests,
        pageSize: 1000,
        endlessPagination: false,
        override: undefined,
        throwOn: undefined,

        last(): RecordedRequest {
            const request = requests[requests.length - 1];
            if (!request) throw new Error("没有收到任何请求");
            return request;
        },

        countFor(key: string): number {
            return requests.filter((request) => request.key === key).length;
        },

        install(): void {
            __setRequestUrlHandler(handle);
        },

        restore(): void {
            __setRequestUrlHandler(undefined);
        },
    };

    function listResponse(request: RecordedRequest): FakeResponse {
        const prefix = request.query.prefix ?? "";
        const all = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
        const offset = Number.parseInt(request.query["continuation-token"] ?? "0", 10) || 0;

        // `endlessPagination` 时只有第一页给内容，之后每页都空 ——
        // 与真实分页一样不重复返回同一个对象，只是永远说「还有下一页」。
        const slice = state.endlessPagination
            ? offset === 0
                ? all.slice(0, state.pageSize)
                : []
            : all.slice(offset, offset + state.pageSize);

        const nextOffset = offset + state.pageSize;
        const more = state.endlessPagination || nextOffset < all.length;

        const contents = slice
            .map((key) => {
                const object = objects.get(key)!;
                return (
                    "<Contents>" +
                    `<Key>${escapeXml(key)}</Key>` +
                    `<Size>${object.size}</Size>` +
                    `<ETag>${escapeXml(`"${object.etag}"`)}</ETag>` +
                    `<LastModified>${new Date(object.lastModified).toISOString()}</LastModified>` +
                    "</Contents>"
                );
            })
            .join("");

        const xml =
            '<?xml version="1.0" encoding="UTF-8"?>' +
            "<ListBucketResult>" +
            `<IsTruncated>${more ? "true" : "false"}</IsTruncated>` +
            (more ? `<NextContinuationToken>${nextOffset}</NextContinuationToken>` : "") +
            contents +
            "</ListBucketResult>";

        return { status: 200, text: xml };
    }

    function putResponse(request: RecordedRequest): FakeResponse {
        const size = bodySize(request.body);
        // ETag 带引号 —— 与 R2 一致，这样才验得到 `stripQuotes`。
        const etag = `put-${(putCount += 1)}`;
        objects.set(request.key, {
            size,
            etag,
            lastModified: Date.now(),
            body: toArrayBuffer(request.body),
        });
        return { status: 200, headers: { etag: `"${etag}"` } };
    }

    function getResponse(request: RecordedRequest): HandlerResponse {
        const object = objects.get(request.key);
        if (!object) return { status: 404, text: "<Error><Code>NoSuchKey</Code></Error>" };
        // 走 `arrayBuffer` 通道 —— 真实 Obsidian 的 `text` 与 `arrayBuffer`
        // 都反映响应体，所以两个都要给（只给 text 时替身会从文本派生，
        // 二进制内容会在这里被 UTF-8 往返毁掉）。
        const body = object.body ?? new Uint8Array(object.size).fill(0x42).buffer;
        return {
            status: 200,
            headers: { etag: `"${object.etag}"` },
            arrayBuffer: body as ArrayBuffer,
        };
    }

    function deleteResponse(request: RecordedRequest): HandlerResponse {
        if (!objects.has(request.key)) return { status: 404 };
        objects.delete(request.key);
        return { status: 204 };
    }

    async function handle(request: {
        url: string;
        method?: string;
        headers?: Record<string, string>;
        body?: string | ArrayBuffer;
    }): Promise<HandlerResponse> {
        const recorded = parseRequest(
            request.url,
            request.method ?? "GET",
            request.headers ?? {},
            request.body
        );
        requests.push(recorded);

        const thrown = state.throwOn?.(recorded);
        if (thrown) throw thrown;

        const overridden = state.override?.(recorded);
        if (overridden) {
            return {
                status: overridden.status,
                headers: overridden.headers,
                text: overridden.text,
            };
        }

        if (recorded.method === "GET" && "list-type" in recorded.query) {
            return listResponse(recorded);
        }
        if (recorded.method === "PUT") return putResponse(recorded);
        if (recorded.method === "GET") return getResponse(recorded);
        if (recorded.method === "DELETE") return deleteResponse(recorded);

        return { status: 400, text: "<Error><Code>BadMethod</Code></Error>" };
    }

    return state;
}
