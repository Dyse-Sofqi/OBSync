import { describe, expect, it } from "vitest";
import { Notifier } from "../../../src/core/notice";
import { en } from "../../../src/core/i18n/locales/en";
import { zhCN } from "../../../src/core/i18n/locales/zh-cn";
import {
    ImageSyncError,
    describeImageSyncError,
    requireConfig,
    type ImageSyncErrorDetail,
    type ImageSyncErrorKind,
} from "../../../src/features/images/errors";

/**
 * 图片同步的错误类型与文案。
 *
 * ## 这里守的是那条分工
 *
 * > 逻辑层抛「类型码 + 参数」，展示层拼「用户能看懂的话」。
 *
 * 违反它的症状很具体：**英文界面下冒出一句中文错误**（逻辑层直接写了一句
 * 中文），或者**中文界面下看到一句英文技术描述**（展示层忘了接这一支）。
 * 编译期只能保证「locale 之间的结构一致」，管不住这两种，所以在这里测。
 *
 * ## 为什么要跑两遍 locale
 *
 * 只断言中文的话，一个「把中文硬写在 `describeImageSyncError` 里」的实现
 * 照样全绿。让同一个错误在两种语言下产出**不同**的文案，才证明它真的走了
 * locale。同理，`ImageSyncError.message` 必须**不含中文** —— 那是进日志的
 * 技术描述，中英混杂的日志在报 issue 时最难读。
 */

/** 每个类型码配一份合法的参数。新增类型码时这里会因缺项而编译报错。 */
const SAMPLES: { [K in ImageSyncErrorKind]: ImageSyncErrorDetail[K] } = {
    notConfigured: { missing: "bucket, accessKeyId" },
    noFolders: {},
    authFailed: { status: 403 },
    bucketNotFound: { bucket: "notes" },
    listFailed: { status: 500, detail: "InternalError" },
    uploadFailed: { path: "images/a.png", status: 400, detail: "EntityTooLarge" },
    downloadFailed: { path: "images/b.png", status: 404, detail: "NoSuchKey" },
    deleteFailed: { path: "images/c.png", status: 403, detail: "AccessDenied" },
    network: { detail: "ERR_CONNECTION_RESET" },
    localReadFailed: { path: "images/d.png", detail: "ENOENT" },
    localWriteFailed: { path: "images/e.png", detail: "EACCES" },
    decodeFailed: { path: "images/f.png" },
};

const KINDS = Object.keys(SAMPLES) as ImageSyncErrorKind[];

describe("ImageSyncError", () => {
    it("带上类型码与参数", () => {
        const error = new ImageSyncError("uploadFailed", {
            path: "images/a.png",
            status: 400,
            detail: "nope",
        });

        expect(error.kind).toBe("uploadFailed");
        expect(error.params).toEqual({ path: "images/a.png", status: 400, detail: "nope" });
    });

    it("message 是**英文技术描述**（进日志用，不含中文）", () => {
        // 中英混杂的日志在报 issue 时最难读 —— 而这条消息正是用户要贴出来的东西。
        for (const kind of KINDS) {
            const error = new ImageSyncError(kind, SAMPLES[kind] as never);
            expect(error.message).toMatch(/^Image sync failed: /);
            expect(error.message).not.toMatch(/[\u4e00-\u9fff]/);
        }
    });

    it("参数进 message（排查时能从日志看出是哪个文件）", () => {
        const error = new ImageSyncError("uploadFailed", {
            path: "images/a.png",
            status: 400,
            detail: "nope",
        });

        expect(error.message).toContain("images/a.png");
        expect(error.message).toContain("400");
    });

    it("保留 cause（原始异常不能丢）", () => {
        const cause = new Error("boom");
        const error = new ImageSyncError("network", { detail: "x" }, { cause });

        expect(error.cause).toBe(cause);
    });

    it("是无参类型码时可以只传 kind", () => {
        expect(new ImageSyncError("noFolders").params).toEqual({});
    });
});

describe("requireConfig", () => {
    it("全都有时返回 undefined", () => {
        expect(
            requireConfig({ a: "1", b: "2" }, ["a", "b"])
        ).toBeUndefined();
    });

    it("缺项时报出**缺了哪些**（不是笼统的「配置不全」）", () => {
        const error = requireConfig({ a: "1", b: "", c: "3" }, ["a", "b", "c"])!;

        expect(error.kind).toBe("notConfigured");
        expect((error.params as ImageSyncErrorDetail["notConfigured"]).missing).toBe("b");
    });

    it("缺多项时全部列出", () => {
        const error = requireConfig({ a: "", b: "", c: "3" }, ["a", "b", "c"])!;

        expect((error.params as ImageSyncErrorDetail["notConfigured"]).missing).toBe("a, b");
    });

    it("空串算没填", () => {
        expect(requireConfig({ a: "" }, ["a"])).toBeInstanceOf(ImageSyncError);
    });
});

describe("describeImageSyncError", () => {
    it("每一个类型码都产出一句非空文案（没有落进兜底）", () => {
        for (const kind of KINDS) {
            const error = new ImageSyncError(kind, SAMPLES[kind] as never);
            const text = describeImageSyncError(error, zhCN);

            expect(text, kind).toBeTruthy();
            expect(text!.length, kind).toBeGreaterThan(4);
        }
    });

    it("不是本模块的错误时返回 undefined（交给下一个翻译器 / 兜底逻辑）", () => {
        expect(describeImageSyncError(new Error("boom"), zhCN)).toBeUndefined();
        expect(describeImageSyncError("garbage", zhCN)).toBeUndefined();
        expect(describeImageSyncError(undefined, zhCN)).toBeUndefined();
    });

    /**
     * 同一个错误在两种语言下必须产出**不同**的文案。
     *
     * 这一条是「有没有真的走 locale」的判据：把中文硬写在
     * `describeImageSyncError` 里的实现能通过上面所有断言，但过不了这里。
     */
    it("跟随 locale（同一错误在两种语言下文案不同）", () => {
        for (const kind of KINDS) {
            const error = new ImageSyncError(kind, SAMPLES[kind] as never);
            expect(describeImageSyncError(error, zhCN), kind).not.toBe(
                describeImageSyncError(error, en)
            );
        }
    });

    it("英文下**不含中文**（否则英文界面会冒出中文错误）", () => {
        for (const kind of KINDS) {
            const error = new ImageSyncError(kind, SAMPLES[kind] as never);
            expect(describeImageSyncError(error, en)!, kind).not.toMatch(/[\u4e00-\u9fff]/);
        }
    });

    it("中文下**不含成句的英文技术描述**（路径与状态码除外）", () => {
        // 参数（路径、状态码、服务端说明）本来就可能是英文，所以这里只检查
        // 文案骨架 —— 拿一个参数里没有英文的类型码来验。
        const error = new ImageSyncError("authFailed", { status: 403 });
        const text = describeImageSyncError(error, zhCN)!;

        expect(text).toMatch(/[\u4e00-\u9fff]/);
        expect(text).not.toMatch(/authFailed/);
    });

    it("参数被填进文案（缺什么、哪个文件、哪个桶）", () => {
        const missing = new ImageSyncError("notConfigured", { missing: "bucket" });
        expect(describeImageSyncError(missing, zhCN)).toContain("bucket");

        const bucket = new ImageSyncError("bucketNotFound", { bucket: "my-notes" });
        expect(describeImageSyncError(bucket, zhCN)).toContain("my-notes");

        const upload = new ImageSyncError("uploadFailed", {
            path: "images/a.png",
            status: 400,
            detail: "EntityTooLarge",
        });
        const text = describeImageSyncError(upload, zhCN)!;
        expect(text).toContain("images/a.png");
        expect(text).toContain("400");
        expect(text).toContain("EntityTooLarge");
    });

    it("鉴权失败要同时点出「密钥不对」与「没权限」两种可能（用户分不清是哪一种）", () => {
        const text = describeImageSyncError(new ImageSyncError("authFailed", { status: 403 }), zhCN)!;

        expect(text).toContain("Secret Access Key");
        expect(text).toContain("权限");
    });
});

describe("与 Notifier 的接线", () => {
    function notifier(locale: typeof zhCN): Notifier {
        return new Notifier({ getShowNotices: () => false, getT: () => locale });
    }

    it("注册之后，图片模块的错误自动走它自己的文案", () => {
        const notifierInstance = notifier(zhCN);
        notifierInstance.registerErrorTranslator(describeImageSyncError);

        const text = notifierInstance.describeError(
            new ImageSyncError("authFailed", { status: 403 })
        );

        expect(text).toContain("Secret Access Key");
    });

    it("没注册时落到通用兜底（**这条守的是「注册」这一步不能被忘掉**）", () => {
        const text = notifier(zhCN).describeError(new ImageSyncError("authFailed", { status: 403 }));

        // 兜底是 ObsyncError 的 message，也就是那句英文技术描述 ——
        // 中文界面上出现它，就说明翻译器没注册。
        expect(text).toMatch(/Image sync failed/);
    });

    it("注册多个模块的翻译器时互不干扰（不认识的返回 undefined 就往下走）", () => {
        const notifierInstance = notifier(zhCN);
        notifierInstance.registerErrorTranslator(() => undefined);
        notifierInstance.registerErrorTranslator(describeImageSyncError);

        expect(
            notifierInstance.describeError(new ImageSyncError("noFolders"))
        ).toBe(zhCN.images.errors.noFolders);
    });

    it("fallback 只在完全认不出时使用", () => {
        const notifierInstance = notifier(zhCN);
        notifierInstance.registerErrorTranslator(describeImageSyncError);

        expect(notifierInstance.describeError(new Error("boom"), "兜底")).toBe("兜底：boom");
        expect(
            notifierInstance.describeError(new ImageSyncError("noFolders"), "兜底")
        ).toBe(zhCN.images.errors.noFolders);
    });
});
