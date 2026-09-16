import { afterEach, describe, expect, it } from "vitest";
import { __setRequestUrlHandler } from "../stubs/obsidian";
import {
    encodePathSegments,
    extractServerMessage,
    getHeader,
    httpJson,
    httpRequest,
    setHttpDebugLogger,
} from "../../src/host/http";
import { NetworkError } from "../../src/host/errors";

/**
 * HTTP 封装的**重试与超时**策略。
 *
 * ## 为什么单独测这一层
 *
 * 每次网络请求都经过这里，而它的策略是**刻意的取舍**，不是默认行为：
 *
 * - 传输层失败（超时 / DNS / 连接被拒）**不重试** —— 那些是确定性的，
 *   重试只是把「等 20 秒」变成「等 62 秒」，而调用方的降级路径往往立刻就能成功；
 * - 5xx / 408 才重试（服务端临时故障，会很快返回状态码）；
 * - **429 不重试** —— 重试只会浪费本就很低的配额。
 *
 * 这些性质靠读代码容易看漏（尤其「不重试」看起来像漏了 `continue`），
 * 而且退避会让用例变慢，所以更需要用「请求了几次」这种可数的断言锁住。
 *
 * 下面每个重试用例都把 `retries` 压到 1，让退避只付一次 400ms。
 */

interface RecordedRequest {
    url: string;
    method?: string;
}

let requests: RecordedRequest[] = [];

afterEach(() => {
    __setRequestUrlHandler(undefined);
    requests = [];
});

/** 按顺序给出每次响应的行为；用完后一直重复最后一个。 */
function respondWith(
    steps: Array<
        | { status: number; text?: string; headers?: Record<string, string> }
        | { throws: string }
    >
): void {
    let index = 0;
    __setRequestUrlHandler(async (request) => {
        requests.push({ url: request.url, method: request.method });
        const step = steps[Math.min(index, steps.length - 1)]!;
        index += 1;
        if ("throws" in step) throw new Error(step.throws);
        return {
            status: step.status,
            text: step.text ?? "",
            headers: step.headers ?? {},
        };
    });
}

describe("httpRequest 的重试策略", () => {
    it("**传输层失败不重试** —— 只发一次请求", async () => {
        respondWith([{ throws: "fetch failed" }]);

        await expect(
            httpRequest({ url: "https://example.invalid/a", retries: 1 })
        ).rejects.toBeInstanceOf(NetworkError);

        // 关键：不是 2 次、不是 3 次。重试确定性失败只是把等待时间翻倍。
        expect(requests).toHaveLength(1);
    });

    it("5xx 会重试，恢复后返回成功响应", async () => {
        respondWith([
            { status: 500 },
            { status: 200, text: '{"ok":true}' },
        ]);

        const response = await httpRequest({ url: "https://example.invalid/a", retries: 1 });

        expect(response.status).toBe(200);
        expect(requests).toHaveLength(2);
    });

    it("重试用尽后**返回响应而不是抛错**（状态码由调用方解释）", async () => {
        respondWith([{ status: 503 }]);

        const response = await httpRequest({ url: "https://example.invalid/a", retries: 1 });

        expect(response.status).toBe(503);
        expect(requests).toHaveLength(2);
    });

    it("**429 不重试** —— 重试只会浪费配额", async () => {
        respondWith([{ status: 429, headers: { "X-RateLimit-Reset": "1700000000" } }]);

        const response = await httpRequest({ url: "https://example.invalid/a", retries: 2 });

        expect(response.status).toBe(429);
        expect(requests).toHaveLength(1);
    });

    it("4xx（如 404）不重试", async () => {
        respondWith([{ status: 404 }]);

        const response = await httpRequest({ url: "https://example.invalid/a", retries: 2 });

        expect(response.status).toBe(404);
        expect(requests).toHaveLength(1);
    });

    it("超时抛 NetworkError 并说明超时（不是笼统的失败）", async () => {
        // 处理器永不返回 —— 只能靠超时结束。
        __setRequestUrlHandler(() => new Promise(() => {}));

        await expect(
            httpRequest({ url: "https://example.invalid/slow", retries: 0, timeoutMs: 30 })
        ).rejects.toThrow(/timed out after 30ms/);
    });

    it("**错误消息里的尝试次数与实际相符**", async () => {
        // 传输层失败只发一次，所以消息必须说 1 次。
        // 曾经这里用的是 `retries + 1` —— 于是日志里写着「failed after 3 attempt(s)」，
        // 而实际只发了 1 次。排查网络问题时这会把人带偏（去找那两次不存在的重试）。
        respondWith([{ throws: "fetch failed" }]);

        await expect(
            httpRequest({ url: "https://example.invalid/a", retries: 2 })
        ).rejects.toThrow(/after 1 attempt\(s\)/);
    });

    it("先重试过、再遇到传输层失败时，次数也如实反映", async () => {
        // 这条是上面那条的补角：次数既不是 1（发过重试），也不是 `retries + 1`
        // （重试没用完就断了）。只有真的数着发出去几次才对得上。
        respondWith([{ status: 500 }, { throws: "fetch failed" }]);

        await expect(
            httpRequest({ url: "https://example.invalid/a", retries: 2, timeoutMs: 1000 })
        ).rejects.toThrow(/after 2 attempt\(s\)/);

        expect(requests).toHaveLength(2);
    });
});

describe("httpRequest 的响应处理", () => {
    it("响应头统一小写，取值大小写不敏感", async () => {
        respondWith([
            {
                status: 200,
                headers: { "X-RateLimit-Reset": "1700000000", "Content-Type": "text/plain" },
            },
        ]);

        const response = await httpRequest({ url: "https://example.invalid/a" });

        expect(getHeader(response.headers, "x-ratelimit-reset")).toBe("1700000000");
        // 调用方按小写取 —— 平台之间大小写不一致，不归一会取不到值
        expect(getHeader(response.headers, "X-RateLimit-Reset")).toBe("1700000000");
    });

    it("httpJson 对非 JSON 响应**不抛错**，把 data 留成 undefined", async () => {
        // 服务端出错时经常返回 HTML，直接 JSON.parse 会抛出与真实原因无关的异常。
        respondWith([{ status: 200, text: "<html>not json</html>" }]);

        const response = await httpJson<{ ok: boolean }>({ url: "https://example.invalid/a" });

        expect(response.data).toBeUndefined();
        expect(response.text).toBe("<html>not json</html>");
    });

    it("空响应体不会被当成解析失败", async () => {
        respondWith([{ status: 204 }]);

        const response = await httpJson({ url: "https://example.invalid/a" });

        expect(response.data).toBeUndefined();
        expect(response.text).toBe("");
    });
});

describe("extractServerMessage", () => {
    it("按 message / error / error_description 依次找", () => {
        expect(extractServerMessage('{"message":"Not Found"}')).toBe("Not Found");
        expect(extractServerMessage('{"error":"invalid_grant"}')).toBe("invalid_grant");
        expect(extractServerMessage('{"error_description":"token expired"}')).toBe(
            "token expired"
        );
    });

    it("空字符串的字段不算数，继续找下一个", () => {
        expect(extractServerMessage('{"message":"   ","error":"real reason"}')).toBe(
            "real reason"
        );
    });

    it("不是 JSON 时当纯文本用，并压平空白", () => {
        expect(extractServerMessage("  line one\n  line two  ")).toBe("line one line two");
    });

    it("超长文本截断（错误提示里塞整页 HTML 没有意义）", () => {
        const message = extractServerMessage("x".repeat(500));

        expect(message).toHaveLength(201); // 200 + 省略号
        expect(message.endsWith("…")).toBe(true);
    });

    it("空输入返回空串", () => {
        expect(extractServerMessage("")).toBe("");
    });
});

describe("encodePathSegments", () => {
    it("保留斜杠（分支名和文件路径都要用）", () => {
        expect(encodePathSegments("feature/new-ui/readme.md")).toBe(
            "feature/new-ui/readme.md"
        );
    });

    it("编码各段里的特殊字符", () => {
        expect(encodePathSegments("docs/我的 笔记.md")).toBe(
            `docs/${encodeURIComponent("我的 笔记.md")}`
        );
    });

    it("丢掉空段与前导斜杠", () => {
        expect(encodePathSegments("/a//b/")).toBe("a/b");
    });
});

describe("错误消息与日志里的凭据", () => {
    /**
     * 这一组守的是**令牌不出门**。
     *
     * Gitee 的鉴权只能放查询串（见 `IRepoHost.applyAuth`），所以带令牌的地址
     * 会一路流到 `http.ts` 的错误消息里。而那条消息有两个出口：
     * `Notifier.describeError` 把它弹到**屏幕上**，`logger.error` 把它写进控制台 ——
     * 而用户在 issue 里贴的正是后者。等于 `core/secretStore` 那套白做。
     *
     * 所以这里既断言「没有令牌」，也断言「地址本身还在」：整段删掉虽然安全，
     * 但排查时就不知道请求打的是哪个地址了。
     */
    const TOKEN = "ghp_THIS_MUST_NOT_LEAK_0000";
    const TOKENIZED = `https://gitee.com/api/v5/repos/o/r?access_token=${TOKEN}`;

    it("传输层失败：消息里没有令牌，但地址与参数名还在", async () => {
        respondWith([{ throws: "fetch failed" }]);

        const err = await httpRequest({ url: TOKENIZED, retries: 0 }).catch((e) => e);

        expect(err).toBeInstanceOf(NetworkError);
        const message = (err as Error).message;
        expect(message).not.toContain(TOKEN);
        expect(message).toContain("access_token=***");
        expect(message).toContain("https://gitee.com/api/v5/repos/o/r");
    });

    it("超时的消息里也没有令牌", async () => {
        __setRequestUrlHandler(() => new Promise(() => {}));

        const err = await httpRequest({
            url: TOKENIZED,
            retries: 0,
            timeoutMs: 30,
        }).catch((e) => e);

        const message = (err as Error).message;
        expect(message).toContain("timed out after 30ms");
        expect(message).not.toContain(TOKEN);
    });

    it("**脱敏只作用于消息 —— 实际请求仍然带真令牌**", async () => {
        // 缺这条的话，最容易犯的错是「把地址里的令牌删掉再发出去」——
        // 那会从「日志泄漏」变成「Gitee 全部 401」，而且症状完全不指向这里。
        respondWith([{ status: 200, text: "{}" }]);

        await httpRequest({ url: TOKENIZED, retries: 0 });

        expect(requests).toHaveLength(1);
        expect(requests[0]!.url).toBe(TOKENIZED);
    });

    it("调试日志里也没有令牌", async () => {
        // 「输出调试日志」恰恰是用户排查问题时打开的开关 ——
        // 那时候日志里的令牌会直接进 issue。
        const lines: string[] = [];
        setHttpDebugLogger((line) => lines.push(line));
        try {
            respondWith([{ throws: "fetch failed" }]);
            await httpRequest({ url: TOKENIZED, retries: 0 }).catch(() => undefined);

            respondWith([{ status: 200, text: "{}" }]);
            await httpRequest({ url: TOKENIZED, retries: 0 });
        } finally {
            setHttpDebugLogger(undefined);
        }

        expect(lines.length).toBeGreaterThan(0);
        expect(lines.join("\n")).not.toContain(TOKEN);
    });
});
