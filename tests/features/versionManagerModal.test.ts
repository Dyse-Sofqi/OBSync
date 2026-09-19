import { beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import {
    createdSettings,
    resetCreatedSettings,
    type ButtonComponent,
    type DropdownComponent,
    type Setting,
} from "../stubs/obsidian";
import { zhCN } from "../../src/core/i18n/locales/zh-cn";
import { Notifier } from "../../src/core/notice";
import type { InstallerService, VersionOption } from "../../src/features/installer/installerService";
import {
    VersionManagerModal,
    type VersionSubject,
} from "../../src/features/installer/ui/VersionManagerModal";

/**
 * 「版本管理」弹窗的交互契约。
 *
 * 这个弹窗存在的理由是 `requestedVersion`（「用户要求的版本」）在界面上
 * **没有别的入口**：它以前只被「添加插件仓库」弹窗写过一次，之后既改不了、
 * 也看不见。所以这里要钉住三件事：
 *
 * 1. **认得出当前版本**：一串 tag 里，磁盘上装的那一版必须有标记 ——
 *    没有它，「退回上一版」这个动作无从下手（而且 tag 与 manifest 里的 version
 *    经常不同形：`v1.2.3` ↔ `1.2.3`，字符串相等在那里是不够的）；
 * 2. **默认选中记录里的选择**，而不是「最新版本」—— 否则每次打开都在把用户往
 *    最新版拽，而他要确认的恰恰是「我钉在哪一版」；
 * 3. **「没有版本可切」与「这次没拉到」必须分开说**。前者是仓库的事实
 *    （Gitee 上「只有源码、不发 release」是常态），后者是请求失败可以重试。
 *    混成一句，用户就会去重试一件永远不会成的事。
 */

function latest(): VersionOption {
    return { value: "latest", label: zhCN.installer.versionLatest, prerelease: false };
}

function release(tag: string, publishedAt?: string): VersionOption {
    return { value: tag, label: tag, publishedAt, prerelease: false };
}

function notifier(): Notifier {
    return new Notifier({ getShowNotices: () => false, getT: () => zhCN });
}

/** 只实现这个弹窗真正会碰的两件事：拉版本列表、翻译错误。 */
function makeService(
    options: { versions?: VersionOption[]; fail?: Error } = {}
): InstallerService {
    return {
        listVersions: async () => {
            if (options.fail) throw options.fail;
            return options.versions ?? [latest(), release("1.2.0"), release("1.0.0")];
        },
        deps: { notifier: notifier() },
    } as unknown as InstallerService;
}

function subject(overrides: Partial<VersionSubject> = {}): VersionSubject {
    return {
        name: "Demo Plugin",
        repoRef: { host: "github", owner: "owner", repo: "demo" },
        installedVersion: "1.0.0",
        requestedVersion: "latest",
        ...overrides,
    };
}

function open(
    service: InstallerService,
    chosen: VersionOption[],
    overrides: Partial<VersionSubject> = {}
): VersionManagerModal {
    const modal = new VersionManagerModal(
        {} as App,
        service,
        zhCN,
        subject(overrides),
        (option) => chosen.push(option)
    );
    modal.open();
    return modal;
}

/** 弹窗内容区里所有文本（含 Setting 的名字与描述）。 */
function modalTexts(modal: VersionManagerModal): string[] {
    const walk = (node: unknown): string[] => {
        const el = node as { text?: string; children?: unknown[] };
        return [...(el.text ? [el.text] : []), ...(el.children ?? []).flatMap(walk)];
    };
    return ((modal.contentEl.children as unknown) as unknown[]).flatMap(walk);
}

/** 「安装版本」那一行 —— 弹窗里唯一有下拉框的行。 */
function versionRow(): Setting {
    const row = [...createdSettings].reverse().find((setting) => setting.dropdowns.length > 0);
    if (!row) throw new Error("还没有渲染出版本下拉框");
    return row;
}

function dropdown(): DropdownComponent {
    return versionRow().dropdowns[0]!;
}

function applyButton(): ButtonComponent {
    const row = [...createdSettings]
        .reverse()
        .find((setting) =>
            setting.buttons.some((button) => button.text === zhCN.installer.versionApply)
        );
    if (!row) throw new Error("还没有渲染出「切换到此版本」按钮");
    return row.buttons.find((button) => button.text === zhCN.installer.versionApply)!;
}

/** 下拉框里某个 value 对应的**显示标签**（标「当前」看的就是它）。 */
function labelOf(value: string): string {
    return dropdown().options.find((option) => option.value === value)?.label ?? "";
}

beforeEach(() => {
    resetCreatedSettings();
});

describe("VersionManagerModal 的列表状态", () => {
    it("还在拉列表时只说「正在获取」，不画一个空下拉框（空的看着像没有版本）", async () => {
        let resolveList: ((options: VersionOption[]) => void) | undefined;
        const service = {
            listVersions: () =>
                new Promise<VersionOption[]>((resolve) => {
                    resolveList = resolve;
                }),
            deps: { notifier: notifier() },
        } as unknown as InstallerService;

        const modal = open(service, []);

        expect(modalTexts(modal)).toContain(zhCN.installer.versionLoading);
        expect(createdSettings.some((setting) => setting.dropdowns.length > 0)).toBe(false);

        resolveList!([latest(), release("1.0.0")]);
        await vi.waitFor(() => expect(versionRow()).toBeDefined());
    });

    it("一个 release 都没有时说清「没有可切换的版本」，并把按钮置灰", async () => {
        const modal = open(makeService({ versions: [latest()] }), []);

        await vi.waitFor(() => expect(applyButton()).toBeDefined());
        expect(modalTexts(modal)).toContain(zhCN.installer.versionNoneAvailable);
        expect(applyButton().disabled).toBe(true);
    });

    it("拉列表失败时报失败原因（**不是**「没有版本」），并把按钮置灰", async () => {
        const modal = open(makeService({ fail: new Error("boom") }), []);

        await vi.waitFor(() => expect(applyButton()).toBeDefined());
        const texts = modalTexts(modal).join("\n");
        expect(texts).toContain(zhCN.installer.versionFetchFailed);
        expect(texts).toContain("boom");
        // 「拉不到」与「没有版本」给用户的下一步完全不同：前者可以重试。
        expect(texts).not.toContain(zhCN.installer.versionNoneAvailable);
        expect(applyButton().disabled).toBe(true);
    });

    it("拉不到列表时连可搜索列表那个按钮也置灰", async () => {
        open(makeService({ fail: new Error("boom") }), []);

        await vi.waitFor(() => expect(applyButton()).toBeDefined());
        expect(versionRow().buttons.map((button) => button.icon)).toEqual(["list"]);
        expect(versionRow().buttons[0]!.disabled).toBe(true);
    });
});

describe("VersionManagerModal 的当前版本标记", () => {
    it("把**磁盘上装的那一版**标成「当前」", async () => {
        open(makeService({ versions: [latest(), release("1.2.0"), release("1.0.0")] }), [], {
            installedVersion: "1.2.0",
        });

        await vi.waitFor(() => expect(versionRow()).toBeDefined());
        expect(labelOf("1.2.0")).toBe(`1.2.0 · ${zhCN.installer.versionCurrent}`);
        expect(labelOf("1.0.0")).toBe("1.0.0");
    });

    it("tag 与 manifest 里的版本不同形（`v1.2.0` ↔ `1.2.0`）时照样认得出", async () => {
        // 这是常态而不是边角：release tag 常常带 v 前缀，manifest 里的 version 不带。
        // 用字符串相等判断，「当前」这两个字就永远不会出现。
        open(makeService({ versions: [latest(), release("v1.2.0")] }), [], {
            installedVersion: "1.2.0",
        });

        await vi.waitFor(() => expect(versionRow()).toBeDefined());
        expect(labelOf("v1.2.0")).toContain(zhCN.installer.versionCurrent);
    });

    it("「最新版本」这一项永远不标「当前」（它说的是「跟着最新走」，不是版本号）", async () => {
        open(makeService({ versions: [latest(), release("1.0.0")] }), [], {
            installedVersion: "1.0.0",
        });

        await vi.waitFor(() => expect(versionRow()).toBeDefined());
        expect(labelOf("latest")).toBe(zhCN.installer.versionLatest);
        expect(labelOf("1.0.0")).toContain(zhCN.installer.versionCurrent);
    });

    it("已装版本读不到时不写空壳（手工装的目录可能读不出 manifest）", async () => {
        const modal = open(makeService(), [], { installedVersion: "" });

        await vi.waitFor(() => expect(versionRow()).toBeDefined());
        expect(modalTexts(modal)).toContain(zhCN.installer.versionInstalledUnknown);
    });

    it("读得到时把当前版本写在最前面（下面那串 tag 要靠它才有参照）", async () => {
        const modal = open(makeService(), [], { installedVersion: "1.0.0" });

        await vi.waitFor(() => expect(versionRow()).toBeDefined());
        expect(modalTexts(modal)).toContain(zhCN.installer.versionInstalled("1.0.0"));
    });
});

describe("VersionManagerModal 的默认选中与提交", () => {
    it("默认选中**记录里那个**选择，而不是「最新版本」", async () => {
        // 默认成「最新」会把这个控件变成一个不断把用户往最新版拽的东西，
        // 而用户再打开它想确认的是「我钉在哪一版」。
        open(makeService(), [], { requestedVersion: "1.0.0" });

        await vi.waitFor(() => expect(versionRow()).toBeDefined());
        expect(dropdown().value).toBe("1.0.0");
    });

    it("记录里的 tag 已经不在列表里时回落到第一项（否则下拉框显示一个不存在的值）", async () => {
        open(makeService({ versions: [latest(), release("1.2.0")] }), [], {
            requestedVersion: "9.9.9",
        });

        await vi.waitFor(() => expect(versionRow()).toBeDefined());
        expect(dropdown().value).toBe("latest");
    });

    it("点「切换到此版本」把选中的那个版本交出去", async () => {
        const chosen: VersionOption[] = [];
        open(makeService(), chosen, { requestedVersion: "latest" });

        await vi.waitFor(() => expect(versionRow()).toBeDefined());
        dropdown().select("1.0.0");
        applyButton().click();

        expect(chosen).toHaveLength(1);
        expect(chosen[0]!.value).toBe("1.0.0");
    });

    it("交出去的是**用户选的那个**，不是默认那个", async () => {
        const chosen: VersionOption[] = [];
        open(makeService(), chosen);

        await vi.waitFor(() => expect(versionRow()).toBeDefined());
        dropdown().select("1.2.0");
        applyButton().click();

        expect(chosen[0]!.value).toBe("1.2.0");
    });
});
