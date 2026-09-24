import { hmacSha256, sha256Hex, toHex, utf8 } from "./sha256";

/**
 * AWS Signature Version 4 的签名计算。
 *
 * Cloudflare R2 对外提供的是 **S3 兼容接口**，鉴权就是 SigV4 —— 没有别的选择，
 * 也没有「R2 专用」的简化版。所以这里按 AWS 规范实现，而不是照 R2 文档写一份
 * 似是而非的近似版本。
 *
 * ## 正确性怎么保证
 *
 * 用 **AWS 官方文档里的示例向量**校准（`tests/features/images/sigv4.test.ts`）：
 * 同一份输入必须算出同一个 `Authorization` 头。自己造期望值是没有意义的
 * （两边一起错也一样绿），而 R2 不接受错误签名 —— 那会表现为一个没有解释的 403。
 *
 * ## 几个容易写错的点
 *
 * 1. **路径编码**：S3 的路径要按 RFC3986 逐段编码，且**不做二次编码**
 *    （其他 AWS 服务才需要双编码）。`encodeURIComponent` 少编码 `!'()*` 四个字符，
 *    必须补上 —— 文件名里出现 `'` 或 `(` 是常事。
 * 2. **查询串必须按键排序**，且键与值都要编码。
 * 3. **参与签名的头必须小写并按名排序**，值要折叠内部连续空白。
 * 4. `host` **必须**在签名头里。我们发请求时不自己设 Host（由 Obsidian 的
 *    HTTP 层按 URL 填），所以签名的那个值必须与 URL 里的 host 一致。
 */

export interface SignInput {
    method: string;
    /** URL 的 path（带前导 `/`，未编码）。 */
    path: string;
    /** 查询参数（未编码）。空对象表示没有查询串。 */
    query: Record<string, string>;
    /** 参与签名的请求头（小写名 → 值）。**必须包含 `host`**。 */
    headers: Record<string, string>;
    /** 请求体的 SHA-256 十六进制；无请求体时传空串的摘要。 */
    payloadHash: string;
    accessKeyId: string;
    secretAccessKey: string;
    region: string;
    service: string;
    /** `YYYYMMDDTHHMMSSZ`（UTC）。 */
    amzDate: string;
}

const ALGORITHM = "AWS4-HMAC-SHA256";
/** 空请求体的摘要 —— GET / DELETE / LIST 都用它。 */
export const EMPTY_PAYLOAD_SHA256 = sha256Hex(new Uint8Array(0));

/** 按 RFC3986 编码：`encodeURIComponent` 之外还要补上它漏掉的四个字符。 */
export function encodeRfc3986(value: string): string {
    return encodeURIComponent(value).replace(
        /[!'()*]/g,
        (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
    );
}

/** 逐段编码路径，保留 `/` 作为分隔符。 */
export function encodeCanonicalPath(path: string): string {
    return path
        .split("/")
        .map((segment) => encodeRfc3986(segment))
        .join("/");
}

/** 规范化查询串：按键排序，键值都编码。 */
export function canonicalQueryString(query: Record<string, string>): string {
    return Object.keys(query)
        .sort()
        .map((key) => `${encodeRfc3986(key)}=${encodeRfc3986(query[key])}`)
        .join("&");
}

/**
 * 规范化请求头 + 签名头列表。
 *
 * 返回的两段都要用：头块进规范请求，名字列表进 `SignedHeaders` 与 `Authorization`。
 */
export function canonicalHeaders(headers: Record<string, string>): {
    block: string;
    signed: string;
} {
    // 先归一成小写名的表再排序取值。
    //
    // 不能写成 `Object.keys(headers).map(lowercase)` 之后仍然用 `headers[name]` 取值：
    // 那对「键本来就是小写」的调用方没问题，但传进 `Host` / `X-Amz-Date` 这类
    // 大小写混写的键时取到的是 `undefined`，`.trim()` 直接抛 TypeError ——
    // 而症状会表现为「签名函数崩了」，与真正的原因（键的大小写）隔得很远。
    const normalized: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) {
        normalized[name.toLowerCase()] = value;
    }

    const names = Object.keys(normalized).sort();

    const block = names
        // 值里的连续空白要折叠成一个空格，首尾也要去 —— 这是规范要求的形状，
        // 不是美化（否则签名与实际发出的头不一致）。
        .map((name) => `${name}:${normalized[name].trim().replace(/\s+/g, " ")}\n`)
        .join("");

    return { block, signed: names.join(";") };
}

/** 规范请求（Canonical Request）—— 签名前必须先拼出它，再对它取摘要。 */
export function canonicalRequest(input: SignInput): string {
    const { block, signed } = canonicalHeaders(input.headers);
    return [
        input.method.toUpperCase(),
        encodeCanonicalPath(input.path),
        canonicalQueryString(input.query),
        block,
        signed,
        input.payloadHash,
    ].join("\n");
}

/** 待签字符串（String to Sign）。 */
export function stringToSign(input: SignInput): string {
    const scope = `${input.amzDate.slice(0, 8)}/${input.region}/${input.service}/aws4_request`;
    return [
        ALGORITHM,
        input.amzDate,
        scope,
        sha256Hex(utf8(canonicalRequest(input))),
    ].join("\n");
}

/**
 * 派生签名密钥。
 *
 * 四轮 HMAC 是规范规定的（`AWS4` 前缀 + 日期 + 区域 + 服务 + 终止串），
 * 每一轮的**输出是下一轮的密钥** —— 所以这里必须是字节级 HMAC，不能中途转十六进制。
 */
export function signingKey(
    secretAccessKey: string,
    date: string,
    region: string,
    service: string
): Uint8Array {
    const kDate = hmacSha256(utf8(`AWS4${secretAccessKey}`), utf8(date));
    const kRegion = hmacSha256(kDate, utf8(region));
    const kService = hmacSha256(kRegion, utf8(service));
    return hmacSha256(kService, utf8("aws4_request"));
}

/** 计算出完整的 `Authorization` 头值。 */
export function authorizationHeader(input: SignInput): string {
    const scope = `${input.amzDate.slice(0, 8)}/${input.region}/${input.service}/aws4_request`;
    const key = signingKey(
        input.secretAccessKey,
        input.amzDate.slice(0, 8),
        input.region,
        input.service
    );
    const signature = toHex(hmacSha256(key, utf8(stringToSign(input))));

    return (
        `${ALGORITHM} Credential=${input.accessKeyId}/${scope}, ` +
        `SignedHeaders=${canonicalHeaders(input.headers).signed}, ` +
        `Signature=${signature}`
    );
}

/** `YYYYMMDDTHHMMSSZ`，UTC。 */
export function formatAmzDate(date: Date): string {
    const pad = (value: number): string => String(value).padStart(2, "0");
    return (
        `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
        `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
    );
}
