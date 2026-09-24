import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ImageSyncError } from "../../../src/features/images/errors";
import { R2Client, parseListResponse, type R2Config } from "../../../src/features/images/r2Client";
import { EMPTY_PAYLOAD_SHA256 } from "../../../src/features/images/sigv4";
import { sha256Hex } from "../../../src/features/images/sha256";
import { createFakeR2, type FakeR2 } from "../../helpers/fakeR2";

/**
 * R2（S3 兼容）客户端。
 *
 * 这一层是「本地全绿、真机上 403」的高发区，所以断言尽量落在**协议细节**上：
 * 路径风格、查询串的编码、`x-amz-*` 头、ETag 的引号、翻页的 token。
 * 假服务端按 S3 的形状解释请求（见 `tests/helpers/fakeR2.ts`），
 * 于是这些断言验的是「真实对端会看到什么」，而不只是「函数返回了什么」。
 */

const CONFIG: R2Config = {
    endpoint: "https://abc123.r2.cloudflarestorage.com",
    host: "abc123.r2.cloudflarestorage.com",
    bucket: "notes",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    prefix: "images/",
};

let r2: FakeR2;

beforeEach(() => {
    r2 = createFakeR2();
    r2.install();
});

afterEach(() => {
    r2.restore();
});

function client(config: Partial<R2Config> = {}): R2Client {
    return new R2Client({ ...CONFIG, ...config });
}

function object(size: number, etag: string, lastModified = 1_700_000_000_000) {
    return { size, etag, lastModified };
}

describe("keyFor", () => {
    it("拼上前缀", () => {
        expect(client().keyFor("a/b.png")).toBe("images/a/b.png");
    });

    it("前缀为空时就是桶根", () => {
        expect(client({ prefix: "" }).keyFor("a.png")).toBe("a.png");
    });

    it("前缀里带尾斜杠（调用方负责归一）", () => {
        expect(client({ prefix: "images/" }).keyFor("a.png")).toBe("images/a.png");
    });
});

describe("listAll", () => {
    it("走路径风格 URL，并带上 ListObjectsV2 的三个参数", async () => {
        r2.objects.set("images/a.png", object(10, "e1"));

        await client().listAll();

        const request = r2.last();
        expect(request.method).toBe("GET");
        expect(request.url.startsWith("https://abc123.r2.cloudflarestorage.com/notes?")).toBe(
            true
        );
        // 键排序：list-type < max-keys < prefix
        expect(request.url).toContain("list-type=2");
        expect(request.url).toContain("max-keys=1000");
        // 前缀里的 `/` 必须编码 —— 不编码会被当成路径分隔符
        expect(request.url).toContain("prefix=images%2F");
    });

    it("**不自己设 host 头**（由 HTTP 层按 URL 填，签名里那个值只需与它一致）", async () => {
        await client().listAll();

        expect(r2.last().headers.host).toBeUndefined();
        expect(r2.last().headers.Host).toBeUndefined();
    });

    it("带上 x-amz-date、空请求体摘要与 Authorization", async () => {
        await client().listAll();

        const headers = r2.last().headers;
        expect(headers["x-amz-date"]).toMatch(/^\d{8}T\d{6}Z$/);
        expect(headers["x-amz-content-sha256"]).toBe(EMPTY_PAYLOAD_SHA256);
        expect(headers["authorization"]).toContain("AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/");
    });

    /**
     * `region` 必须是 `auto`、`service` 必须是 `s3`。
     *
     * R2 只认 `auto`：写成具体区域（`us-east-1`、`wnam`…）会让签名与对端
     * 算出来的不一致，表现是一个没有任何解释的 403 —— 排查时很难想到是区域。
     */
    it("签名作用域是 auto/s3（R2 只认这个）", async () => {
        await client().listAll();

        const authorization = r2.last().headers["authorization"]!;
        expect(authorization).toMatch(/Credential=[^/]+\/\d{8}\/auto\/s3\/aws4_request/);
        expect(authorization).toMatch(/SignedHeaders=host;x-amz-content-sha256;x-amz-date/);
    });

    it("把响应里的对象解析出来", async () => {
        r2.objects.set("images/a.png", object(10, "e1"));
        r2.objects.set("images/b.png", object(20, "e2"));

        const { objects, truncated } = await client().listAll();

        expect(truncated).toBe(false);
        expect(objects.map((item) => item.key)).toEqual(["images/a.png", "images/b.png"]);
        expect(objects[0]).toEqual({
            key: "images/a.png",
            size: 10,
            etag: "e1",
            lastModified: 1_700_000_000_000,
        });
    });

    it("按前缀过滤（服务端行为，本客户端不自己筛）", async () => {
        r2.objects.set("images/a.png", object(1, "e"));
        r2.objects.set("other/b.png", object(1, "e"));

        const { objects } = await client().listAll();

        expect(objects.map((item) => item.key)).toEqual(["images/a.png"]);
    });

    it("翻页：一路跟着 continuation-token 走到底", async () => {
        r2.pageSize = 2;
        for (const name of ["a", "b", "c", "d", "e"]) {
            r2.objects.set(`images/${name}.png`, object(1, name));
        }

        const { objects, truncated } = await client().listAll();

        expect(objects).toHaveLength(5);
        expect(truncated).toBe(false);
        // 3 页：2 + 2 + 1
        expect(r2.requests).toHaveLength(3);
        expect(r2.requests[0]!.query["continuation-token"]).toBeUndefined();
        expect(r2.requests[1]!.query["continuation-token"]).toBe("2");
        expect(r2.requests[2]!.query["continuation-token"]).toBe("4");
    });

    /**
     * 页数上限：桶里放了几万个对象时，无限翻页会把界面卡在一个转圈的按钮上。
     * 到上限就停下并**标记截断** —— 调用方据此拒绝执行删除动作。
     */
    it("到页数上限就停下并标记截断", async () => {
        r2.endlessPagination = true;
        r2.objects.set("images/a.png", object(1, "e"));

        const { truncated } = await client().listAll();

        expect(truncated).toBe(true);
        expect(r2.requests).toHaveLength(20);
    });

    /**
     * **截断但没给 token** 时仍然要报截断。
     *
     * 服务端说截断了却没给 token（畸形响应、代理改写）时，「没有下一页」
     * 不等于「列举完整」。把不完整的列举当成完整，会让「云端没有这个对象」
     * 这个前提成立 —— 而它的下游动作是**删掉本地文件**。
     */
    it("IsTruncated 为真却没有 token 时，仍报截断（宁可少做事）", async () => {
        r2.override = () => ({
            status: 200,
            text:
                '<?xml version="1.0"?><ListBucketResult>' +
                "<IsTruncated>true</IsTruncated>" +
                "<Contents><Key>images/a.png</Key><Size>1</Size><ETag>\"e\"</ETag></Contents>" +
                "</ListBucketResult>",
        });

        const { truncated } = await client().listAll();

        expect(truncated).toBe(true);
    });

    it("403 报鉴权失败（不是「列举失败」——两者对用户要做的事完全不同）", async () => {
        r2.override = () => ({ status: 403, text: "<Error><Code>SignatureDoesNotMatch</Code></Error>" });

        await expect(client().listAll()).rejects.toMatchObject({ kind: "authFailed" });
    });

    it("404 报桶不存在", async () => {
        r2.override = () => ({ status: 404 });

        await expect(client().listAll()).rejects.toMatchObject({
            kind: "bucketNotFound",
            params: { bucket: "notes" },
        });
    });

    it("400 报列举失败，并带上服务端的说明", async () => {
        r2.override = () => ({
            status: 400,
            text: '{"message":"InvalidArgument: bad prefix"}',
        });

        await expect(client().listAll()).rejects.toMatchObject({
            kind: "listFailed",
            params: { status: 400, detail: "InvalidArgument: bad prefix" },
        });
    });

    it("传输层失败换成 network 领域错误（不是原始的适配器异常）", async () => {
        r2.throwOn = () => new Error("net::ERR_CONNECTION_RESET");

        const error = await client()
            .listAll()
            .catch((err: unknown) => err);

        expect(error).toBeInstanceOf(ImageSyncError);
        expect((error as ImageSyncError).kind).toBe("network");
    });

    it("传输层失败**不重试**（确定性失败，重试只是把等待变成三倍）", async () => {
        r2.throwOn = () => new Error("timeout");

        await client()
            .listAll()
            .catch(() => undefined);

        expect(r2.requests).toHaveLength(1);
    });
});

describe("parseListResponse", () => {
    it("空结果", () => {
        expect(
            parseListResponse('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>')
        ).toEqual({ items: [], truncated: false });
    });

    it("去掉 ETag 的引号", () => {
        const { items } = parseListResponse(
            "<ListBucketResult><Contents>" +
                "<Key>a.png</Key><Size>5</Size><ETag>&quot;abc123&quot;</ETag>" +
                "</Contents></ListBucketResult>"
        );

        expect(items[0]!.etag).toBe("abc123");
    });

    it("没有 ETag 时给空串", () => {
        const { items } = parseListResponse(
            "<ListBucketResult><Contents><Key>a.png</Key><Size>5</Size></Contents></ListBucketResult>"
        );

        expect(items[0]!.etag).toBe("");
    });

    it("键里的 XML 实体被还原", () => {
        // 文件名里有 `&` 与 `'` 都很正常（`Bob & Co's photo.png`）。
        const { items } = parseListResponse(
            "<ListBucketResult><Contents>" +
                "<Key>images/Bob &amp; Co&apos;s photo.png</Key><Size>1</Size>" +
                "</Contents></ListBucketResult>"
        );

        expect(items[0]!.key).toBe("images/Bob & Co's photo.png");
    });

    /**
     * `&amp;` **必须最后**替换。
     *
     * 放前面的话 `&amp;lt;` 会先变成 `&lt;`，再被后面的 `&lt;` 规则换成 `<` ——
     * 双重转义的文件名被还原成第三层，得到一个不存在的键。
     */
    it("双重转义的实体只还原一层", () => {
        const { items } = parseListResponse(
            "<ListBucketResult><Contents>" +
                "<Key>a&amp;lt;b.png</Key><Size>1</Size>" +
                "</Contents></ListBucketResult>"
        );

        expect(items[0]!.key).toBe("a&lt;b.png");
    });

    it("数字实体被还原", () => {
        const { items } = parseListResponse(
            "<ListBucketResult><Contents><Key>a&#39;b.png</Key><Size>1</Size></Contents></ListBucketResult>"
        );

        expect(items[0]!.key).toBe("a'b.png");
    });

    it("时间戳解析不出来时给 0（比编一个当前时间安全）", () => {
        const { items } = parseListResponse(
            "<ListBucketResult><Contents>" +
                "<Key>a.png</Key><Size>1</Size><LastModified>not-a-date</LastModified>" +
                "</Contents></ListBucketResult>"
        );

        expect(items[0]!.lastModified).toBe(0);
    });

    it("Size 不是数字时给 0", () => {
        const { items } = parseListResponse(
            "<ListBucketResult><Contents><Key>a.png</Key><Size>x</Size></Contents></ListBucketResult>"
        );

        expect(items[0]!.size).toBe(0);
    });

    it("缺 Key 的 Contents 被跳过", () => {
        const { items } = parseListResponse(
            "<ListBucketResult><Contents><Size>5</Size></Contents></ListBucketResult>"
        );

        expect(items).toEqual([]);
    });

    it("截断时给出 next 与 truncated", () => {
        expect(
            parseListResponse(
                "<ListBucketResult><IsTruncated>true</IsTruncated>" +
                    "<NextContinuationToken>2</NextContinuationToken></ListBucketResult>"
            )
        ).toEqual({ items: [], next: "2", truncated: true });
    });

    it("未截断时不给出 next（即使是 true 以外的值）", () => {
        expect(
            parseListResponse(
                "<ListBucketResult><IsTruncated>false</IsTruncated>" +
                    "<NextContinuationToken>2</NextContinuationToken></ListBucketResult>"
            )
        ).toEqual({ items: [], truncated: false });
    });
});

describe("putObject", () => {
    it("PUT 到对象的完整路径，并把内容写上去", async () => {
        const body = new TextEncoder().encode("hello").buffer as ArrayBuffer;

        const etag = await client().putObject("images/a b.png", body, "image/png");

        expect(etag).toBe("put-1");
        const request = r2.last();
        expect(request.method).toBe("PUT");
        // 路径里的空格必须编成 %20（不是 `+`，也不是原样空格）
        expect(request.url).toBe(
            "https://abc123.r2.cloudflarestorage.com/notes/images/a%20b.png"
        );
        expect(request.headers["Content-Type"]).toBe("image/png");
        expect(r2.objects.get("images/a b.png")!.size).toBe(5);
    });

    it("x-amz-content-sha256 是**请求体**的摘要（不是空串的摘要）", async () => {
        const body = new TextEncoder().encode("hello").buffer as ArrayBuffer;

        await client().putObject("images/a.png", body, "image/png");

        expect(r2.last().headers["x-amz-content-sha256"]).toBe(
            sha256Hex(new Uint8Array(body))
        );
        expect(r2.last().headers["x-amz-content-sha256"]).not.toBe(EMPTY_PAYLOAD_SHA256);
    });

    it("ETag 的引号被去掉", async () => {
        // R2 返回 `"abc"`，有些实现不带引号 —— 两种都要兼容，
        // 否则状态清单里存的是带引号的值，与列举返回的（已去引号）对不上，
        // 于是每轮都判成「远端变了」，反复下载。
        r2.override = (request) =>
            request.method === "PUT" ? { status: 200, headers: { etag: '"plain-etag"' } } : undefined;

        expect(await client().putObject("images/a.png", new ArrayBuffer(1), "image/png")).toBe(
            "plain-etag"
        );
    });

    it("响应里没有 ETag 时退回内容摘要（而不是空串）", async () => {
        const body = new TextEncoder().encode("hello").buffer as ArrayBuffer;
        r2.override = (request) => (request.method === "PUT" ? { status: 200 } : undefined);

        expect(await client().putObject("images/a.png", body, "image/png")).toBe(
            sha256Hex(new Uint8Array(body))
        );
    });

    it("403 报鉴权失败", async () => {
        r2.override = () => ({ status: 403 });

        await expect(
            client().putObject("images/a.png", new ArrayBuffer(1), "image/png")
        ).rejects.toMatchObject({ kind: "authFailed" });
    });

    it("400 报上传失败，带上路径与状态码", async () => {
        r2.override = () => ({ status: 400, text: '{"message":"EntityTooLarge"}' });

        await expect(
            client().putObject("images/a.png", new ArrayBuffer(1), "image/png")
        ).rejects.toMatchObject({
            kind: "uploadFailed",
            params: { path: "images/a.png", status: 400, detail: "EntityTooLarge" },
        });
    });
});

describe("getObject", () => {
    it("取回内容", async () => {
        r2.objects.set("images/a.png", {
            size: 3,
            etag: "e",
            lastModified: 0,
            body: new Uint8Array([1, 2, 3]).buffer,
        });

        const body = await client().getObject("images/a.png");

        expect([...new Uint8Array(body)]).toEqual([1, 2, 3]);
    });

    it("GET 用空请求体摘要", async () => {
        r2.objects.set("images/a.png", object(1, "e"));

        await client().getObject("images/a.png");

        expect(r2.last().headers["x-amz-content-sha256"]).toBe(EMPTY_PAYLOAD_SHA256);
    });

    it("404 报下载失败（不是「不存在」——调用方按计划执行，缺对象是异常）", async () => {
        await expect(client().getObject("images/gone.png")).rejects.toMatchObject({
            kind: "downloadFailed",
            params: { path: "images/gone.png", status: 404 },
        });
    });

    it("403 报鉴权失败", async () => {
        r2.override = () => ({ status: 403 });

        await expect(client().getObject("images/a.png")).rejects.toMatchObject({
            kind: "authFailed",
        });
    });
});

describe("deleteObject", () => {
    it("204 视为成功", async () => {
        r2.objects.set("images/a.png", object(1, "e"));

        await expect(client().deleteObject("images/a.png")).resolves.toBeUndefined();
        expect(r2.objects.has("images/a.png")).toBe(false);
    });

    /**
     * **404 也视为成功。**
     *
     * S3 的 DELETE 本来就不保证幂等可见（同一秒内重复删同一个键会先 204 后 404），
     * 而我们真正的诉求是「它不在了」。把 404 当失败会让「双向删除」在重跑时
     * 反复报错 —— 而那个错误什么也说明不了。
     */
    it("404 也视为成功（真正的诉求是「它不在了」）", async () => {
        await expect(client().deleteObject("images/gone.png")).resolves.toBeUndefined();
    });

    it("403 报鉴权失败", async () => {
        r2.override = () => ({ status: 403 });

        await expect(client().deleteObject("images/a.png")).rejects.toMatchObject({
            kind: "authFailed",
        });
    });

    it("400 报删除失败", async () => {
        r2.override = () => ({ status: 400, text: '{"message":"AccessDenied"}' });

        await expect(client().deleteObject("images/a.png")).rejects.toMatchObject({
            kind: "deleteFailed",
            params: { path: "images/a.png", status: 400, detail: "AccessDenied" },
        });
    });
});

describe("testConnection", () => {
    it("列举成功就算通", async () => {
        await expect(client().testConnection()).resolves.toEqual({ ok: true });
    });

    it("失败时把领域错误交出来（让界面说人话）", async () => {
        r2.override = () => ({ status: 403 });

        const result = await client().testConnection();

        expect(result.ok).toBe(false);
        expect((result as { error: ImageSyncError }).error).toBeInstanceOf(ImageSyncError);
        expect(((result as { error: ImageSyncError }).error as ImageSyncError).kind).toBe(
            "authFailed"
        );
    });

    it("**用列举而不是 HEAD 桶**（HEAD 的响应体常被代理丢掉，出错时看不出原因）", async () => {
        await client().testConnection();

        expect(r2.last().method).toBe("GET");
        expect("list-type" in r2.last().query).toBe(true);
    });
});
