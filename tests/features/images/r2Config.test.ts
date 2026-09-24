import { describe, expect, it } from "vitest";
import {
    buildR2Config,
    normalizeEndpoint,
    normalizePrefix,
} from "../../../src/features/images/imageSyncService";
import { R2Client } from "../../../src/features/images/r2Client";

/**
 * 从设置拼出 R2 配置。
 *
 * 这两段归一化看着琐碎，但它们决定「用户写的字能不能用」——
 * `accountId` 的三种写法与 `prefix` 的斜杠形态都是**用户凭直觉写**的东西，
 * 而归一化错了的表现是「拼出一个不存在的地址 / 一个多了一层空目录的键」，
 * 界面不会有任何异常提示。
 */

describe("normalizeEndpoint", () => {
    it("纯账号 ID → 补成 R2 的存储域名", () => {
        expect(normalizeEndpoint("abc123")).toEqual({
            url: "https://abc123.r2.cloudflarestorage.com",
            host: "abc123.r2.cloudflarestorage.com",
        });
    });

    it("带点的当主机名用（用户可能填 r2.dev 或自定义域名）", () => {
        expect(normalizeEndpoint("abc123.r2.cloudflarestorage.com")).toEqual({
            url: "https://abc123.r2.cloudflarestorage.com",
            host: "abc123.r2.cloudflarestorage.com",
        });
        expect(normalizeEndpoint("storage.example.com")).toEqual({
            url: "https://storage.example.com",
            host: "storage.example.com",
        });
    });

    it("完整 URL 原样采用（含 scheme）", () => {
        expect(normalizeEndpoint("https://abc123.r2.cloudflarestorage.com")).toEqual({
            url: "https://abc123.r2.cloudflarestorage.com",
            host: "abc123.r2.cloudflarestorage.com",
        });
        expect(normalizeEndpoint("http://localhost:9000")).toEqual({
            url: "http://localhost:9000",
            host: "localhost:9000",
        });
    });

    it("剥掉尾斜杠与路径（用户可能粘了带 /bucket 的地址）", () => {
        expect(normalizeEndpoint("abc123.r2.cloudflarestorage.com/notes/")).toEqual({
            url: "https://abc123.r2.cloudflarestorage.com",
            host: "abc123.r2.cloudflarestorage.com",
        });
    });

    it("去掉前后空白", () => {
        expect(normalizeEndpoint("  abc123  ").host).toBe("abc123.r2.cloudflarestorage.com");
    });

    /**
     * `url` 与 `host` **必须出自同一处解析**。
     *
     * 签名里用的是 `host`，而请求发往 `url` —— 两者一旦分家（比如一处用
     * `new URL()` 规范化过、另一处没有），对端算出的签名就不一样，
     * 表现是一个没有任何解释的 403。
     */
    it("url 与 host 始终自洽（url = scheme + host）", () => {
        for (const input of [
            "abc123",
            "abc123.r2.cloudflarestorage.com",
            "https://abc123.r2.cloudflarestorage.com",
            "http://localhost:9000",
            "abc123.r2.cloudflarestorage.com/notes",
        ]) {
            const { url, host } = normalizeEndpoint(input);
            expect(url.endsWith(host)).toBe(true);
            expect(url.startsWith("http")).toBe(true);
        }
    });
});

describe("normalizePrefix", () => {
    it("两端无斜杠、结尾带一个斜杠", () => {
        expect(normalizePrefix("sync")).toBe("sync/");
        expect(normalizePrefix("/sync/")).toBe("sync/");
        expect(normalizePrefix("sync/")).toBe("sync/");
    });

    it("多层前缀保留内部斜杠", () => {
        expect(normalizePrefix("/a/b/")).toBe("a/b/");
    });

    it("空 / 只有斜杠 → 空串（桶根）", () => {
        expect(normalizePrefix("")).toBe("");
        expect(normalizePrefix("/")).toBe("");
        expect(normalizePrefix("//")).toBe("");
    });

    /**
     * 归一成「结尾带一个斜杠」而不是「结尾不带」，是为了让 `keyFor` 直接拼接 ——
     * 不带斜杠的话 `sync` + `a.png` 会拼出 `synca.png`，那会悄悄把文件
     * 传到另一个键上（而且**看着像成功了**）。
     */
    it("拼出来的键不会粘连（`synca.png` 那种）", () => {
        expect(normalizePrefix("sync") + "images/a.png").toBe("sync/images/a.png");
    });
});

describe("buildR2Config", () => {
    it("从设置拼出完整配置，并归一前缀", () => {
        expect(
            buildR2Config({
                accountId: "abc123",
                bucket: "notes",
                accessKeyId: "AKIA",
                secretAccessKey: "secret",
                prefix: "/sync/",
            })
        ).toEqual({
            endpoint: "https://abc123.r2.cloudflarestorage.com",
            host: "abc123.r2.cloudflarestorage.com",
            bucket: "notes",
            accessKeyId: "AKIA",
            secretAccessKey: "secret",
            prefix: "sync/",
        });
    });

    it("桶名与 Access Key 去空白", () => {
        const config = buildR2Config({
            accountId: "abc123",
            bucket: "  notes  ",
            accessKeyId: "  AKIA  ",
            secretAccessKey: "secret",
            prefix: "",
        });

        expect(config.bucket).toBe("notes");
        expect(config.accessKeyId).toBe("AKIA");
    });

    /**
     * **密钥不做 trim。**
     *
     * 它是从 SecretStore 读出来的原文，而 R2 的 Secret Access Key 是
     * Base64 形态的随机串 —— 万一将来出现带空格的形态，`trim()` 会把一个
     * 合法的密钥改坏，而症状是「明明填对了却 403」。桶名与 Access Key 是
     * 用户手输的、容易带空格，两者判据不同是对的。
     */
    it("密钥原样透传（不 trim）", () => {
        const config = buildR2Config({
            accountId: "abc123",
            bucket: "notes",
            accessKeyId: "AKIA",
            secretAccessKey: "  secret  ",
            prefix: "",
        });

        expect(config.secretAccessKey).toBe("  secret  ");
    });

    it("拼出来的配置能直接交给 R2Client（键带上归一后的前缀）", () => {
        const client = new R2Client(
            buildR2Config({
                accountId: "abc123",
                bucket: "notes",
                accessKeyId: "AKIA",
                secretAccessKey: "secret",
                prefix: "/sync/",
            })
        );

        expect(client.prefix).toBe("sync/");
        expect(client.keyFor("images/a.png")).toBe("sync/images/a.png");
    });
});
