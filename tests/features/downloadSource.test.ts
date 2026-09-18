import { describe, expect, it } from "vitest";
import { en } from "../../src/core/i18n/locales/en";
import { zhCN } from "../../src/core/i18n/locales/zh-cn";
import {
    downloadSourceLabel,
    hostLabel,
} from "../../src/features/installer/downloadSource";
import type { RepoRef } from "../../src/host/types";

/**
 * 完成提示里那个「来源」是怎么来的。
 *
 * 它要回答的是用户问过的那句话：**到底有没有用镜像**。而跟踪列表给不出答案 ——
 * 那行镜像文案只在命中时才出现，「没出现」既可能是没探测到、也可能是根本没探测
 * （绑进来的条目从不做镜像探测）。所以这个字符串必须是「服务实际用的地址」，
 * 不能从跟踪条目推（更新时才发现镜像的话，条目里的 `host` 还是旧的）。
 */

const GITHUB: RepoRef = { host: "github", owner: "owner", repo: "demo" };
const GITEE: RepoRef = { host: "gitee", owner: "owner", repo: "demo" };

describe("hostLabel", () => {
    it("平台名取自 locale（代码里不许再写一份平台名）", () => {
        expect(hostLabel(zhCN, "github")).toBe(zhCN.host.github);
        expect(hostLabel(zhCN, "gitee")).toBe(zhCN.host.gitee);
        expect(hostLabel(en, "gitee")).toBe(en.host.gitee);
    });
});

describe("downloadSourceLabel", () => {
    it("没走镜像：报平台名", () => {
        expect(downloadSourceLabel(zhCN, { repoRef: GITHUB })).toBe("GitHub");
        expect(downloadSourceLabel(zhCN, { repoRef: GITEE })).toBe("Gitee");
    });

    it("命中镜像：报「Gitee 镜像」，不是光秃秃的「Gitee」", () => {
        // 只写「Gitee」的话，用户跟踪的是 GitHub 地址，会以为跟踪的地址被换掉了 ——
        // 那是另一个仓库，不是镜像。
        expect(downloadSourceLabel(zhCN, { repoRef: GITEE, origin: GITHUB })).toBe("Gitee 镜像");
    });

    it("报的是**实际用**的地址：跟踪 GitHub、这趟才发现镜像 → Gitee 镜像", () => {
        // 关键：这两个用例的输入完全一样，只是「有没有 origin」—— 说明判据是结果
        // 里的地址对，而不是跟踪条目（更新时才发现镜像的话条目里还是旧的 host）。
        expect(downloadSourceLabel(zhCN, { repoRef: GITEE, origin: GITHUB })).toBe("Gitee 镜像");
        expect(downloadSourceLabel(zhCN, { repoRef: GITHUB })).toBe("GitHub");
    });

    it("英文界面给英文文案（不是中文硬编码）", () => {
        expect(downloadSourceLabel(en, { repoRef: GITEE, origin: GITHUB })).toBe("Gitee mirror");
    });
});
