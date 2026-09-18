import { beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { createdSettings, resetCreatedSettings, type ButtonComponent, type TextComponent } from "../stubs/obsidian";
import { AddRepoModal } from "../../src/features/installer/ui/AddRepoModal";
import { zhCN } from "../../src/core/i18n/locales/zh-cn";
import { Notifier } from "../../src/core/notice";
import type { CommunityPluginIndex } from "../../src/features/installer/communityPlugins";
import type { InstallerService } from "../../src/features/installer/installerService";
import type { InstallResult } from "../../src/features/installer/types";

/**
 * 「添加插件仓库」弹窗的交互契约。
 *
 * 这个文件专门守住一类**逻辑测试看不见的缺陷**：`render()` 会把 `contentEl` 清空重建，
 * 因此「渲染一次算出来的状态」如果在输入变化后没有就地更新，界面就会永久停在初始态。
 * 曾经的实际表现是：「识别」按钮在填了地址之后依然是灰的 ——
 * 因为它的 `setDisabled` 只在 render 时算过一次，而打字不会触发 render。
 *
 * 关键点：断言取「当前渲染出来的那一行」而不是缓存引用，这样即便将来有人改用重建
 * 内容区的方式实现（另一条错误路径），测试也能给出正确判断。
 */

/** 记录被识别过的地址，用于断言按钮点击真的把输入交了出去。 */
let resolvedInputs: string[] = [];

function makeService(): InstallerService {
    const notifier = new Notifier({ getShowNotices: () => false, getT: () => zhCN });
    const result: InstallResult = {
        manifest: {
            id: "trefoil",
            name: "Trefoil",
            version: "1.2.0",
            minAppVersion: "1.0.0",
        },
        channel: "release",
        version: "1.2.0",
        replaced: false,
        enabled: true,
        repoRef: { host: "gitee", owner: "sofqi", repo: "Trefoil" },
    };
    return {
        resolveRepo: async (input: string) => {
            resolvedInputs.push(input);
            return { ref: { host: "gitee", owner: "sofqi", repo: "Trefoil" } };
        },
        listVersions: async () => [{ value: "latest", label: zhCN.installer.versionLatest, prerelease: false }],
        install: async () => result,
        deps: { notifier },
    } as unknown as InstallerService;
}

function openModal(
    onInstalled?: (result: InstallResult) => void,
    service: InstallerService = makeService()
): AddRepoModal {
    const modal = new AddRepoModal(
        {} as App,
        service,
        {} as CommunityPluginIndex,
        zhCN,
        onInstalled
    );
    modal.open();
    return modal;
}

/** 当前渲染出来的仓库地址行（render 会重建内容区，所以取最后一条匹配项）。 */
function repoRow() {
    const row = [...createdSettings]
        .reverse()
        .find((setting) => setting.buttons.some((button) => button.text === zhCN.installer.resolve));
    if (!row) throw new Error("当前内容区里找不到「仓库地址」这一行");
    return row;
}

function resolveButton(): ButtonComponent {
    return repoRow().buttons.find((button) => button.text === zhCN.installer.resolve)!;
}

function repoInput(): TextComponent {
    return repoRow().texts[0];
}

describe("AddRepoModal 的「识别」按钮", () => {
    beforeEach(() => {
        resetCreatedSettings();
        resolvedInputs = [];
    });

    it("地址为空时置灰", () => {
        openModal();
        expect(resolveButton().disabled).toBe(true);
    });

    it("填入地址后立即变为可用", () => {
        openModal();
        repoInput().type("sofqi/Trefoil");
        expect(resolveButton().disabled).toBe(false);
    });

    it("粘贴完整 Gitee 链接后同样可用", () => {
        openModal();
        repoInput().type("https://gitee.com/sofqi/Trefoil");
        expect(resolveButton().disabled).toBe(false);
    });

    it("清空地址后重新置灰", () => {
        openModal();
        repoInput().type("sofqi/Trefoil");
        expect(resolveButton().disabled).toBe(false);

        repoInput().type("");
        expect(resolveButton().disabled).toBe(true);
    });

    it("只输入空白字符仍然置灰", () => {
        openModal();
        repoInput().type("   ");
        expect(resolveButton().disabled).toBe(true);
    });

    it("输入只更新按钮状态，不重建内容区（否则会丢焦点与光标）", () => {
        openModal();
        const before = createdSettings.length;

        repoInput().type("sofqi/Trefoil");

        expect(createdSettings.length).toBe(before);
    });

    it("点击后把地址原样交给服务去识别", async () => {
        openModal();
        repoInput().type("sofqi/Trefoil");

        resolveButton().click();

        await vi.waitFor(() => expect(resolvedInputs).toEqual(["sofqi/Trefoil"]));
    });
});

/**
 * 安装成功后的回调。
 *
 * 设置页靠它重绘「已跟踪」列表（见 `settingsTabRefresh.test.ts`）—— 弹窗自己不
 * 碰界面，要是这里不发通知，列表就只能等下一次「检查全部更新」顺带那次重绘。
 */
describe("AddRepoModal 的安装回调", () => {
    beforeEach(() => {
        resetCreatedSettings();
        resolvedInputs = [];
    });

    /** 当前渲染出来的「安装」按钮（识别 → 选版本之后才有这一行）。 */
    function installButton(): ButtonComponent {
        const row = [...createdSettings]
            .reverse()
            .find((setting) =>
                setting.buttons.some((button) => button.text === zhCN.installer.install)
            );
        if (!row) throw new Error("当前内容区里找不到「安装」按钮");
        return row.buttons.find((button) => button.text === zhCN.installer.install)!;
    }

    async function resolveRepo(): Promise<void> {
        repoInput().type("sofqi/Trefoil");
        resolveButton().click();
        await vi.waitFor(() => installButton());
    }

    it("安装成功后把结果交给回调", async () => {
        const results: InstallResult[] = [];
        openModal((result) => results.push(result));

        await resolveRepo();
        installButton().click();

        await vi.waitFor(() => expect(results).toHaveLength(1));
        expect(results[0]!.manifest.name).toBe("Trefoil");
        expect(results[0]!.version).toBe("1.2.0");
    });

    it("提示里报出实际来源（用户看不出「没走镜像」与「没探测」的区别）", async () => {
        const service = makeService();
        const notices: string[] = [];
        (
            service as unknown as { deps: { notifier: { success(message: string): void } } }
        ).deps.notifier.success = (message: string) => notices.push(message);
        openModal(undefined, service);

        await resolveRepo();
        installButton().click();

        await vi.waitFor(() => expect(notices).toHaveLength(1));
        expect(notices[0]).toBe(zhCN.installer.installed("Trefoil", "1.2.0", "Gitee"));
    });

    it("安装失败时不调回调（设置页不该重绘出一个并不存在的条目）", async () => {
        const service = makeService();
        (service as unknown as { install: () => Promise<never> }).install = async () => {
            throw new Error("boom");
        };
        const results: InstallResult[] = [];
        openModal((result) => results.push(result), service);

        await resolveRepo();
        installButton().click();

        // 失败路径把弹窗重绘回可重试状态，而不是通知调用方「装好了」
        await vi.waitFor(() => expect(installButton().disabled).toBe(false));
        expect(results).toEqual([]);
    });
});
