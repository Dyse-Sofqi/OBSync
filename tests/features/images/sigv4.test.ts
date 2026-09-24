import { describe, expect, it } from "vitest";
import {
    EMPTY_PAYLOAD_SHA256,
    authorizationHeader,
    canonicalHeaders,
    canonicalQueryString,
    canonicalRequest,
    encodeCanonicalPath,
    encodeRfc3986,
    signingKey,
    stringToSign,
    type SignInput,
} from "../../../src/features/images/sigv4";
import { toHex, utf8 } from "../../../src/features/images/sha256";

/**
 * AWS Signature Version 4 的**官方向量**校准。
 *
 * ## 为什么期望值必须来自外部
 *
 * 这套签名只有两个可能的结果：对端接受，或者对端返回一个不带解释的 403。
 * 所以「自己算一遍存进期望值」的测试是没有价值的 —— 实现与期望值一起错，
 * 测试照样全绿，而线上全是 403。
 *
 * 下面的每一组期望值都抄自 AWS 官方文档（《Examples of the complete
 * Signature Version 4 signing process (Python)》里的 GET Object / GET Bucket /
 * PUT Object 三例）。它们是**独立于本仓库**的事实，因此能真正校准实现。
 *
 * 顺带一提，这三例也正好覆盖了实现里最容易写错的三处：
 * - 规范请求里「空查询串也要占一行」以及头块结尾那个空行；
 * - 路径的 RFC3986 逐段编码（`test$file.text` → `test%24file.text`）；
 * - 查询串按键排序后再编码。
 */

const ACCESS_KEY = "AKIAIOSFODNN7EXAMPLE";
const SECRET_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const AMZ_DATE = "20130524T000000Z";

function sign(input: Partial<SignInput>): SignInput {
    return {
        method: "GET",
        path: "/",
        query: {},
        headers: { host: "examplebucket.s3.amazonaws.com" },
        payloadHash: EMPTY_PAYLOAD_SHA256,
        accessKeyId: ACCESS_KEY,
        secretAccessKey: SECRET_KEY,
        region: "us-east-1",
        service: "s3",
        amzDate: AMZ_DATE,
        ...input,
    };
}

/**
 * 把 `Authorization` 头压成「无空白」再比较。
 *
 * AWS 的示例里逗号后**没有**空格，而本实现写的是 `, `（规范允许，
 * 且真实 R2 也接受）。直接把两种写法当不等会让测试盯住一个无关的排版差异，
 * 而真正该钉住的是签名本身与各段的值。
 */
function compact(value: string): string {
    return value.replace(/\s+/g, "");
}

describe("encodeRfc3986", () => {
    /**
     * `encodeURIComponent` 会漏掉 `!'()*` 五个字符（它按 HTML 表单的旧规则办事），
     * 而 RFC3986 要求它们编码。图片文件名里出现 `'` 或 `(` 是常事
     * （`Bob's photo (1).png`），漏编码的后果是签名与请求路径对不上。
     */
    it("补上 encodeURIComponent 漏掉的字符", () => {
        expect(encodeRfc3986("'")).toBe("%27");
        expect(encodeRfc3986("!")).toBe("%21");
        expect(encodeRfc3986("(")).toBe("%28");
        expect(encodeRfc3986(")")).toBe("%29");
        expect(encodeRfc3986("*")).toBe("%2A");
        // 十六进制要用大写 —— 小写虽然语义相同，但 S3 的字符串比较是逐字节的。
        expect(encodeRfc3986("!*")).toBe("%21%2A");
    });

    it("空格编成 %20 而不是 +", () => {
        // `+` 是 form-urlencoded 的写法，S3 不认 —— 那会变成「路径里多了一个加号」。
        expect(encodeRfc3986("a b")).toBe("a%20b");
    });

    it("保留未保留字符（字母数字与 -_.~）", () => {
        expect(encodeRfc3986("aZ0-_.~")).toBe("aZ0-_.~");
    });

    it("非 ASCII 走 UTF-8 百分号编码", () => {
        expect(encodeRfc3986("图片")).toBe("%E5%9B%BE%E7%89%87");
    });
});

describe("encodeCanonicalPath", () => {
    it("逐段编码但保留斜杠分隔符", () => {
        expect(encodeCanonicalPath("/images/2026/我的 图.png")).toBe(
            "/images/2026/%E6%88%91%E7%9A%84%20%E5%9B%BE.png"
        );
    });

    it("段内的撇号与括号被编码（AWS PUT Object 示例里的 $ 同理）", () => {
        expect(encodeCanonicalPath("/test$file.text")).toBe("/test%24file.text");
        expect(encodeCanonicalPath("/Bob's (1).png")).toBe("/Bob%27s%20%281%29.png");
    });

    it("前导斜杠保留（它是规范请求的第一行的一部分）", () => {
        expect(encodeCanonicalPath("/")).toBe("/");
    });
});

describe("canonicalQueryString", () => {
    it("按键排序，键与值都编码", () => {
        expect(canonicalQueryString({ prefix: "images/", "list-type": "2", "max-keys": "1000" })).toBe(
            "list-type=2&max-keys=1000&prefix=images%2F"
        );
    });

    it("空对象产出空串（不是 undefined）", () => {
        expect(canonicalQueryString({})).toBe("");
    });
});

describe("canonicalHeaders", () => {
    it("名字小写、排序，值折叠内部空白", () => {
        const { block, signed } = canonicalHeaders({
            "X-Amz-Date": "20130524T000000Z",
            Host: "examplebucket.s3.amazonaws.com",
            Range: "bytes=0-9",
        });

        expect(block).toBe(
            "host:examplebucket.s3.amazonaws.com\n" +
                "range:bytes=0-9\n" +
                "x-amz-date:20130524T000000Z\n"
        );
        expect(signed).toBe("host;range;x-amz-date");
    });

    it("值里的连续空白折叠成一个空格", () => {
        // 规范要求这个形状，不是美化 —— 不折叠会让签名与实际发出的头不一致。
        const { block } = canonicalHeaders({ date: "Fri,  24 May   2013 00:00:00 GMT" });
        expect(block).toBe("date:Fri, 24 May 2013 00:00:00 GMT\n");
    });

    /**
     * 键的大小写不该影响结果。
     *
     * 这条守的是一个具体的写法错误：先 `Object.keys().map(toLowerCase)` 再拿
     * **原始键**去取值 —— 键本来就小写的调用方看不出问题，而传 `Host` 时会
     * 取到 `undefined` 并抛 TypeError。症状是「签名函数崩了」，
     * 与真正的原因（键的大小写）隔得很远。
     */
    it("键的大小写不影响结果", () => {
        const lower = canonicalHeaders({ host: "h", "x-amz-date": "d" });
        const mixed = canonicalHeaders({ Host: "h", "X-Amz-Date": "d" });
        expect(mixed).toEqual(lower);
    });
});

describe("规范请求（AWS 官方向量）", () => {
    it("GET Object", () => {
        const input = sign({
            method: "GET",
            path: "/test.txt",
            headers: {
                host: "examplebucket.s3.amazonaws.com",
                range: "bytes=0-9",
                "x-amz-content-sha256": EMPTY_PAYLOAD_SHA256,
                "x-amz-date": AMZ_DATE,
            },
        });

        expect(canonicalRequest(input)).toBe(
            [
                "GET",
                "/test.txt",
                "",
                "host:examplebucket.s3.amazonaws.com",
                "range:bytes=0-9",
                `x-amz-content-sha256:${EMPTY_PAYLOAD_SHA256}`,
                `x-amz-date:${AMZ_DATE}`,
                "",
                "host;range;x-amz-content-sha256;x-amz-date",
                EMPTY_PAYLOAD_SHA256,
            ].join("\n")
        );
    });

    it("GET Object：待签字符串与签名", () => {
        const input = sign({
            method: "GET",
            path: "/test.txt",
            headers: {
                host: "examplebucket.s3.amazonaws.com",
                range: "bytes=0-9",
                "x-amz-content-sha256": EMPTY_PAYLOAD_SHA256,
                "x-amz-date": AMZ_DATE,
            },
        });

        expect(stringToSign(input)).toBe(
            [
                "AWS4-HMAC-SHA256",
                AMZ_DATE,
                "20130524/us-east-1/s3/aws4_request",
                "7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972",
            ].join("\n")
        );

        expect(compact(authorizationHeader(input))).toBe(
            "AWS4-HMAC-SHA256" +
                `Credential=${ACCESS_KEY}/20130524/us-east-1/s3/aws4_request,` +
                "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date," +
                "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
        );
    });

    it("GET Bucket（查询串参与签名）", () => {
        const input = sign({
            method: "GET",
            path: "/",
            query: { "max-keys": "2", prefix: "J" },
            headers: {
                host: "examplebucket.s3.amazonaws.com",
                "x-amz-content-sha256": EMPTY_PAYLOAD_SHA256,
                "x-amz-date": AMZ_DATE,
            },
        });

        expect(stringToSign(input)).toBe(
            [
                "AWS4-HMAC-SHA256",
                AMZ_DATE,
                "20130524/us-east-1/s3/aws4_request",
                "df57d21db20da04d7fa30298dd4488ba3a2b47ca3a489c74750e0f1e7df1b9b7",
            ].join("\n")
        );

        expect(compact(authorizationHeader(input))).toContain(
            "Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7"
        );
    });

    it("PUT Object（路径编码 + 请求体摘要 + 额外头）", () => {
        const bodyHash = "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072";
        const input = sign({
            method: "PUT",
            path: "/test$file.text",
            headers: {
                date: "Fri, 24 May 2013 00:00:00 GMT",
                host: "examplebucket.s3.amazonaws.com",
                "x-amz-content-sha256": bodyHash,
                "x-amz-date": AMZ_DATE,
                "x-amz-storage-class": "REDUCED_REDUNDANCY",
            },
            payloadHash: bodyHash,
        });

        expect(canonicalRequest(input).split("\n")[1]).toBe("/test%24file.text");
        expect(compact(authorizationHeader(input))).toContain(
            "Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd"
        );
    });
});

describe("signingKey", () => {
    /**
     * 中间密钥**不写成对某个十六进制值的断言**。
     *
     * AWS 文档只公布最终签名，不公布 `kDate` / `kRegion` 的中间值 —— 编一个
     * 期望值塞进来，等于把「实现与期望值一起错」重新引进来（正是本文件开头
     * 反对的那种测试）。所以这里只钉住**性质**：确定性、长度、以及对每个
     * 输入的敏感性。真正的正确性由上面的 `Authorization` 官方向量端到端保证。
     */
    it("确定：同样的输入总是同样的 32 字节密钥", () => {
        const first = signingKey(SECRET_KEY, "20130524", "us-east-1", "s3");
        const second = signingKey(SECRET_KEY, "20130524", "us-east-1", "s3");

        expect(first.byteLength).toBe(32);
        expect(toHex(first)).toBe(toHex(second));
    });

    it("四个输入各自都会改变结果（否则说明某一轮没参与派生）", () => {
        const base = toHex(signingKey(SECRET_KEY, "20130524", "us-east-1", "s3"));

        expect(toHex(signingKey("other", "20130524", "us-east-1", "s3"))).not.toBe(base);
        expect(toHex(signingKey(SECRET_KEY, "20130525", "us-east-1", "s3"))).not.toBe(base);
        expect(toHex(signingKey(SECRET_KEY, "20130524", "auto", "s3"))).not.toBe(base);
        expect(toHex(signingKey(SECRET_KEY, "20130524", "us-east-1", "s3x"))).not.toBe(base);
    });
});

describe("EMPTY_PAYLOAD_SHA256", () => {
    it("是空串的 SHA-256（GET / DELETE / LIST 都用它）", () => {
        expect(EMPTY_PAYLOAD_SHA256).toBe(
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    });
});

describe("utf8", () => {
    it("非 ASCII 走 UTF-8（而不是 UTF-16 或 latin-1）", () => {
        expect(toHex(utf8("中"))).toBe("e4b8ad");
    });
});
