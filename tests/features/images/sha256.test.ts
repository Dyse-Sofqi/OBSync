import { describe, expect, it } from "vitest";
import {
    hmacSha256,
    sha256Hex,
    toHex,
    utf8,
} from "../../../src/features/images/sha256";
import { formatAmzDate } from "../../../src/features/images/sigv4";

/**
 * SHA-256 / HMAC-SHA256 的**公开测试向量**。
 *
 * ## 为什么必须有这个文件
 *
 * 这套实现是 R2 签名的地基，而位运算是「看起来等价但结果是错的」最容易发生的地方
 * —— 它不会抛异常，只会让对端返回一个没有解释的 403。所以这里用**外部给定的
 * 期望值**校准（FIPS 180-4 的示例、RFC 4231 的 HMAC 用例），而不是自己算一遍
 * 存进去：自己算的期望值两边一起错也照样绿。
 *
 * 覆盖的边界：空输入、单分组、跨分组（56 字节，padding 会多占一个分组）、
 * 超分组的密钥（HMAC 要先摘要密钥）、超分组的数据。
 */

describe("sha256", () => {
    it("空输入", () => {
        expect(sha256Hex(new Uint8Array(0))).toBe(
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    });

    it("abc（单分组）", () => {
        expect(sha256Hex(utf8("abc"))).toBe(
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    });

    it("56 字节：补齐会多占一个分组", () => {
        // 56 = 448 比特，正好卡在「长度字段放不下、必须再开一个分组」的边界上。
        // 这是补齐逻辑最常见的 off-by-one 位置。
        expect(sha256Hex(utf8("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"))).toBe(
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
        );
    });

    it("多分组（长输入）", () => {
        // AWS 文档里 PUT Object 示例的请求体，同时验证 20 字节的多分组路径。
        expect(sha256Hex(utf8("Welcome to Amazon S3."))).toBe(
            "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072"
        );
    });

    it("toHex 补零到两位", () => {
        // 0x0a 必须输出 "0a" 而不是 "a" —— 少一位会让摘要长度变成 63，
        // 而 R2 只会说签名不对。
        expect(toHex(new Uint8Array([0, 10, 255]))).toBe("000aff");
    });

    it("utf8 对代理对（emoji）产出 4 字节", () => {
        // 图片路径里出现 emoji 完全正常。用 `unescape(encodeURIComponent())`
        // 那套老写法会在这里产出错误的字节。
        expect(toHex(utf8("🖋"))).toBe("f09f968b");
    });
});

describe("hmacSha256（RFC 4231）", () => {
    it("用例 1：20 字节密钥 + 短数据", () => {
        const key = new Uint8Array(20).fill(0x0b);
        expect(toHex(hmacSha256(key, utf8("Hi There")))).toBe(
            "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"
        );
    });

    it("用例 2：短密钥（要右侧补零到分组长度）", () => {
        expect(toHex(hmacSha256(utf8("Jefe"), utf8("what do ya want for nothing?")))).toBe(
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
    });

    it("用例 6：131 字节密钥（超过分组，要先摘要）", () => {
        const key = new Uint8Array(131).fill(0xaa);
        expect(
            toHex(
                hmacSha256(key, utf8("Test Using Larger Than Block-Size Key - Hash Key First"))
            )
        ).toBe("60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54");
    });

    it("用例 7：密钥与数据都超过分组", () => {
        const key = new Uint8Array(131).fill(0xaa);
        const data = utf8(
            "This is a test using a larger than block-size key and a larger than block-size data. " +
                "The key needs to be hashed before being used by the HMAC algorithm."
        );
        expect(toHex(hmacSha256(key, data))).toBe(
            "9b09ffa71b942fcb27635fbcd5b0e944bfdc63644f0713938a7f51535c3a35e2"
        );
    });
});

describe("formatAmzDate", () => {
    it("输出 YYYYMMDDTHHMMSSZ，按月/日/时/分/秒补零", () => {
        // 用 UTC 构造，避免本机时区影响 —— 这个字符串会直接进签名。
        expect(formatAmzDate(new Date(Date.UTC(2013, 4, 24, 0, 0, 0)))).toBe("20130524T000000Z");
        expect(formatAmzDate(new Date(Date.UTC(2026, 8, 2, 3, 4, 5)))).toBe("20260902T030405Z");
    });
});
