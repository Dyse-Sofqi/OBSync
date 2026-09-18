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
/** 记录安装请求，用于断言「用的是源仓库还是镜像」。 */
let installRequests: Array<{ repo: string; origin?: { host: string } }> = [];

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
            // 识别到的是源仓库，另外**提出**一个疑似镜像（默认不采用）
            return {
                ref: { host: "github", owner: "sofqi", repo: "Trefoil" },
                mirror: { host: "gitee", owner: "sofqi", repo: "Trefoil" },
            };
        },
        listVersions: async () => [{ value: "latest", label: zhCN.installer.versionLatest, prerelease: false }],
        install: async (request: { repo: string; origin?: { host: string } }) => {
            installRequests.push(request);
            return result;
        },
        deps: { notifier },
    } as unknown as InstallerService;
}

/** 最近一次打开的弹窗（弹窗的渲染都挂在 contentEl 上，断言要读它）。 */
let openedModal: AddRepoModal | undefined;

function currentModal(): AddRepoModal {
    if (!openedModal) throw new Error("还没有打开过弹窗");
    return openedModal;
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
    openedModal = modal;
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
        installRequests = [];
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
        installRequests = [];
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

/**
 * 「疑似镜像」在安装弹窗里的样子：**默认不用镜像，勾了才用**。
 *
 * 判据只是「两边 manifest 的 id 相同」—— 那只证明是同一个插件，证明不了是同一份
 * 代码/同一个作者（详见 ConfirmMirrorModal 的警告）。所以采用必须由用户明示，
 * 而且界面要同时说清「检测到了什么」与「现在会用哪个地址」。
 */
describe("AddRepoModal 的镜像开关", () => {
    beforeEach(() => {
        resetCreatedSettings();
        resolvedInputs = [];
        installRequests = [];
    });

    async function resolveRepoTarget(): Promise<void> {
        repoInput().type("sofqi/Trefoil");
        resolveButton().click();
        await vi.waitFor(() => expect(installButton()).toBeDefined());
    }

    function installButton(): ButtonComponent {
        const row = [...createdSettings]
            .reverse()
            .find((setting) =>
                setting.buttons.some((button) => button.text === zhCN.installer.install)
            );
        if (!row) throw new Error("当前内容区里找不到「安装」按钮");
        return row.buttons.find((button) => button.text === zhCN.installer.install)!;
    }

    /** 弹窗内容区里所有文本（含 Setting 的名字与描述）。 */
    function modalTexts(): string[] {
        const walk = (node: unknown): string[] => {
            const el = node as { text?: string; children?: unknown[] };
            const own = el.text ? [el.text] : [];
            return [...own, ...(el.children ?? []).flatMap(walk)];
        };
        return ((currentModal().contentEl.children as unknown) as unknown[]).flatMap(walk);
    }

    /** 镜像开关所在那一行（名字是「疑似镜像：Gitee · sofqi/Trefoil」）。 */
    function mirrorToggle() {
        const row = [...createdSettings]
            .reverse()
            .find(
                (setting) =>
                    setting.toggles.length > 0 &&
                    setting.name === zhCN.installer.mirrorConfirmCandidate("Gitee", "sofqi/Trefoil")
            );
        if (!row) throw new Error("找不到镜像开关");
        return row.toggles[0]!;
    }

    it("检测到镜像就把地址说出来，并且**默认不勾**", async () => {
        openModal();
        await resolveRepoTarget();

        expect(mirrorToggle().value).toBe(false);
        // 「已识别为」那行报的是**实际会用**的地址 —— 默认就是源仓库；
        // 同时必须说明「检测到了镜像但没用」，否则用户分不清「没探测到」与「探测到没用」
        const statuses = modalTexts().join("\n");
        expect(statuses).toContain(zhCN.installer.resolved("GitHub", "sofqi/Trefoil"));
        expect(statuses).toContain(zhCN.installer.mirrorUnused("Gitee", "sofqi/Trefoil"));
    });

    it("不勾就装源仓库（不给 origin）", async () => {
        openModal();
        await resolveRepoTarget();
        installButton().click();

        await vi.waitFor(() => expect(installRequests).toHaveLength(1));
        expect(installRequests[0]!.repo).toBe("sofqi/Trefoil");
        expect(installRequests[0]!.origin).toBeUndefined();
    });

    it("勾上之后装镜像，并把源地址交出去", async () => {
        openModal();
        await resolveRepoTarget();

        mirrorToggle().toggle(true);
        installButton().click();

        await vi.waitFor(() => expect(installRequests).toHaveLength(1));
        expect(installRequests[0]!.repo).toBe("sofqi/Trefoil");
        expect(installRequests[0]!.origin).toEqual({
            host: "github",
            owner: "sofqi",
            repo: "Trefoil",
        });
    });

    it("重新识别时勾选作废（换了地址就是另一件事）", async () => {
        openModal();
        await resolveRepoTarget();
        mirrorToggle().toggle(true);

        resolveButton().click();
        await vi.waitFor(() => expect(mirrorToggle().value).toBe(false));
    });
});
