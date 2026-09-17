import { beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { createdSettings, resetCreatedSettings, type ButtonComponent, type TextComponent } from "../stubs/obsidian";
import { AddRepoModal } from "../../src/features/installer/ui/AddRepoModal";
import { zhCN } from "../../src/core/i18n/locales/zh-cn";
import { Notifier } from "../../src/core/notice";
import type { CommunityPluginIndex } from "../../src/features/installer/communityPlugins";
import type { InstallerService } from "../../src/features/installer/installerService";

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
    return {
        resolveRepo: async (input: string) => {
            resolvedInputs.push(input);
            return { ref: { host: "gitee", owner: "sofqi", repo: "Trefoil" } };
        },
        listVersions: async () => [{ value: "latest", label: zhCN.installer.versionLatest, prerelease: false }],
        deps: { notifier },
    } as unknown as InstallerService;
}

function openModal(): AddRepoModal {
    const modal = new AddRepoModal(
        {} as App,
        makeService(),
        {} as CommunityPluginIndex,
        zhCN
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
