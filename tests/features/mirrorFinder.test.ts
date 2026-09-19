import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __setRequestUrlHandler } from "../stubs/obsidian";
import {
    findGiteeMirror,
    findGiteeMirrorForTheme,
} from "../../src/features/installer/mirrorFinder";

/**
 * 镜像发现的核心安全约束：**宁可找不到，不可装错**。
 *
 * 同名仓库在 Gitee 上很常见，唯一可信的判据是两边 manifest 的 `id` 一致。
 * 所以这里的每个用例都在验证：任何一步证据不足，都必须返回 undefined。
 */

const GITHUB_MANIFEST = JSON.stringify({
    id: "demo",
    name: "Demo",
    version: "1.0.0",
    minAppVersion: "1.5.0",
});

const GITEE_SAME_ID = JSON.stringify({
    id: "demo",
    name: "Demo（Gitee 镜像）",
    version: "1.0.0",
    minAppVersion: "1.5.0",
});

const GITEE_DIFFERENT_ID = JSON.stringify({
    id: "totally-other-plugin",
    name: "同名但不同项目",
    version: "9.9.9",
    minAppVersion: "1.5.0",
});

beforeEach(() => {
    __setRequestUrlHandler(async (request) => {
        // GitHub 匿名读文件走 raw 域名，Gitee 走网页 raw 通道（见 host 层文档）。
        if (/^https:\/\/raw\.githubusercontent\.com\/owner\/demo\/HEAD\/manifest\.json$/.test(request.url)) {
            return { status: 200, text: GITHUB_MANIFEST };
        }
        if (/^https:\/\/gitee\.com\/owner\/demo\/raw\/HEAD\/manifest\.json$/.test(request.url)) {
            return { status: 200, text: GITEE_SAME_ID };
        }
        throw new Error(`no route for ${request.url}`);
    });
});

afterEach(() => {
    __setRequestUrlHandler(undefined);
});

describe("findGiteeMirror", () => {
    it("Gitee 有同名仓库且 manifest id 一致时命中", async () => {
        const mirror = await findGiteeMirror({ host: "github", owner: "owner", repo: "demo" }, undefined, ["owner"]);
        expect(mirror).toEqual({ host: "gitee", owner: "owner", repo: "demo" });
    });

    it("Gitee 仓库不存在时返回 undefined", async () => {
        __setRequestUrlHandler(async (request) => {
            if (/raw\.githubusercontent\.com/.test(request.url)) {
                return { status: 200, text: GITHUB_MANIFEST };
            }
            // 网页 raw 通道对不存在的仓库返回 404
            return { status: 404, text: "not found" };
        });

        const mirror = await findGiteeMirror({ host: "github", owner: "owner", repo: "demo" }, undefined, ["owner"]);
        expect(mirror).toBeUndefined();
    });

    it("同名但 manifest id 不同（装错插件风险）时返回 undefined", async () => {
        __setRequestUrlHandler(async (request) => {
            if (/raw\.githubusercontent\.com/.test(request.url)) {
                return { status: 200, text: GITHUB_MANIFEST };
            }
            return { status: 200, text: GITEE_DIFFERENT_ID };
        });

        const mirror = await findGiteeMirror({ host: "github", owner: "owner", repo: "demo" }, undefined, ["owner"]);
        expect(mirror).toBeUndefined();
    });

    it("Gitee 的 manifest 不合法时返回 undefined", async () => {
        __setRequestUrlHandler(async (request) => {
            if (/raw\.githubusercontent\.com/.test(request.url)) {
                return { status: 200, text: GITHUB_MANIFEST };
            }
            // 同名仓库存在，但内容根本不是插件
            return { status: 200, text: "<html>这不是插件</html>" };
        });

        const mirror = await findGiteeMirror({ host: "github", owner: "owner", repo: "demo" }, undefined, ["owner"]);
        expect(mirror).toBeUndefined();
    });

    it("GitHub 侧 manifest 拿不到时不切换 —— 没法校验就不冒险", async () => {
        // 源仓库的 manifest 读不到（比如被限流）就无法确认两边是同一个插件，
        // 此时切换镜像等于盲装，必须放弃。
        __setRequestUrlHandler(async (request) => {
            if (/raw\.githubusercontent\.com/.test(request.url)) {
                return { status: 404, text: "not found" };
            }
            return { status: 200, text: GITEE_SAME_ID };
        });

        const mirror = await findGiteeMirror(
            { host: "github", owner: "owner", repo: "demo" },
            undefined,
            ["owner"]
        );
        expect(mirror).toBeUndefined();
    });
});

/**
 * **镜像挂在别的账号下** —— 这条是真实踩到的，不是设想出来的。
 *
 * 实测：`github.com/Dyse-Sofqi/MDRazor` 的镜像是 `gitee.com/sofqi/MDRazor`
 * （作者自己的 Gitee 账号，名字与 GitHub 上的 owner 不同）。只探同名 owner 的
 * 旧实现永远发现不了它 —— 用户看到的是「明明有镜像，却一直走 GitHub」，
 * 而 GitHub 不通时（实测 `net::ERR_CONNECTION_RESET`）就只能降级到源码通道。
 */
describe("findGiteeMirror · 候选 owner", () => {
    /** 同名 owner 在 Gitee 上不存在，镜像在 `sofqi` 名下（就是实测的那个形状）。 */
    const route = (url: string): { status: number; text: string } => {
        if (/raw\.githubusercontent\.com\/dyse-sofqi\/MDRazor\/HEAD\/manifest\.json$/.test(url)) {
            return { status: 200, text: GITHUB_MANIFEST };
        }
        if (/gitee\.com\/sofqi\/MDRazor\/raw\/HEAD\/manifest\.json$/.test(url)) {
            return { status: 200, text: GITEE_SAME_ID };
        }
        if (/gitee\.com\/dyse-sofqi\/MDRazor\/raw\/HEAD\/manifest\.json$/.test(url)) {
            return { status: 404, text: "not found" };
        }
        throw new Error(`no route for ${url}`);
    };
    beforeEach(() => {
        __setRequestUrlHandler(async (request) => route(request.url));
    });

    it("同名探不到、Gitee 账号名能探到时命中后者", async () => {
        const mirror = await findGiteeMirror(
            { host: "github", owner: "dyse-sofqi", repo: "MDRazor" },
            undefined,
            ["dyse-sofqi", "sofqi"]
        );

        expect(mirror).toEqual({ host: "gitee", owner: "sofqi", repo: "MDRazor" });
    });

    it("同名 owner 命中时**不**再探后面的候选（顺序即优先：同名最可信）", async () => {
        const probed: string[] = [];
        __setRequestUrlHandler(async (request) => {
            if (request.url.includes("gitee.com")) probed.push(request.url);
            if (/gitee\.com\/dyse-sofqi\//.test(request.url)) {
                return { status: 200, text: GITEE_SAME_ID };
            }
            return route(request.url);
        });

        const mirror = await findGiteeMirror(
            { host: "github", owner: "dyse-sofqi", repo: "MDRazor" },
            undefined,
            ["dyse-sofqi", "sofqi"]
        );

        expect(mirror).toEqual({ host: "gitee", owner: "dyse-sofqi", repo: "MDRazor" });
        expect(probed).toHaveLength(1);
    });

    it("候选里没有那个账号时仍然找不到（不能靠猜）", async () => {
        const mirror = await findGiteeMirror(
            { host: "github", owner: "dyse-sofqi", repo: "MDRazor" },
            undefined,
            ["dyse-sofqi"]
        );

        expect(mirror).toBeUndefined();
    });
});

/**
 * 主题的镜像探测：判据与插件**不同**（主题 manifest 没有 `id`）。
 *
 * 两条条件缺一不可：`name` 一致（同一个主题）+ 版本不比源旧（换到更旧的镜像
 * 等于让用户静默失去更新）。而且它同样只是**提议** —— 采用要经确认弹窗。
 */
describe("findGiteeMirrorForTheme", () => {
    const THEME = (name: string, version: string) =>
        JSON.stringify({ name, version, minAppVersion: "1.0.0" });
    const GITHUB_REF = { host: "github" as const, owner: "dyse-sofqi", repo: "Ethereal" };

    /** 源仓库（GitHub）与一个候选（Gitee）的 manifest。 */
    function route(source: string, candidate: string | undefined, owner = "sofqi"): void {
        __setRequestUrlHandler(async (request) => {
            if (request.url.includes("raw.githubusercontent.com")) {
                return { status: 200, text: source };
            }
            if (request.url.includes(`gitee.com/${owner}/`)) {
                return candidate === undefined
                    ? { status: 404, text: "not found" }
                    : { status: 200, text: candidate };
            }
            throw new Error(`no route for ${request.url}`);
        });
    }

    it("同名主题 + 版本不落后 → 命中", async () => {
        route(THEME("Ethereal", "1.4.2"), THEME("Ethereal", "1.4.2"));

        const mirror = await findGiteeMirrorForTheme(GITHUB_REF, undefined, ["sofqi"], {
            name: "Ethereal",
            version: "1.4.2",
        });

        expect(mirror).toEqual({ host: "gitee", owner: "sofqi", repo: "Ethereal" });
    });

    it("**名字不同的主题**（同名仓库但是另一个主题）→ 不认", async () => {
        route(THEME("Ethereal", "1.4.2"), THEME("Silence", "9.9.9"));

        const mirror = await findGiteeMirrorForTheme(GITHUB_REF, undefined, ["sofqi"], {
            name: "Ethereal",
            version: "1.4.2",
        });

        expect(mirror).toBeUndefined();
    });

    it("**版本比源旧**的镜像 → 不认（换过去等于失去更新）", async () => {
        route(THEME("Ethereal", "1.4.2"), THEME("Ethereal", "1.3.0"));

        const mirror = await findGiteeMirrorForTheme(GITHUB_REF, undefined, ["sofqi"], {
            name: "Ethereal",
            version: "1.4.2",
        });

        expect(mirror).toBeUndefined();
    });

    it("候选仓库不存在 → 不认", async () => {
        route(THEME("Ethereal", "1.4.2"), undefined);

        const mirror = await findGiteeMirrorForTheme(GITHUB_REF, undefined, ["sofqi"], {
            name: "Ethereal",
            version: "1.4.2",
        });

        expect(mirror).toBeUndefined();
    });
});
