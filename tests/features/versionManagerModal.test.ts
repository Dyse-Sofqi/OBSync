import { beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import {
    createdSettings,
    resetCreatedSettings,
    type ButtonComponent,
    type DropdownComponent,
    type Setting,
    type TextComponent,
} from "../stubs/obsidian";
import { zhCN } from "../../src/core/i18n/locales/zh-cn";
import { Notifier } from "../../src/core/notice";
import { InstallerError, describeInstallerError } from "../../src/features/installer/errors";
import type { InstallerService, VersionOption } from "../../src/features/installer/installerService";
import type { TrackedPlugin } from "../../src/features/installer/types";
import { VersionManagerModal } from "../../src/features/installer/ui/VersionManagerModal";
import type { RepoRef } from "../../src/host/types";

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
 *
 * 2026-09-19 追加的一组是**下载来源**：用户的原话是「我选了 1.0.2 旧版安装，
 * 但是他却不走 gitee 路线，也找不到选择 gitee 镜像下载的选择」。所以这里守的是
 * 「换来源的两条路都通」：探测到就给一键改用，探不到就手填地址（id 校验）。
 */

function latest(): VersionOption {
    return { value: "latest", label: zhCN.installer.versionLatest, prerelease: false };
}

function release(tag: string, publishedAt?: string): VersionOption {
    return { value: tag, label: tag, publishedAt, prerelease: false };
}

function notifier(): Notifier {
    const note = new Notifier({ getShowNotices: () => true, getT: () => zhCN });
    // 与真实装配一致（`createInstallerModule` 里注册）—— 不注册的话
    // `describeError` 拿不到安装器的类型码文案，只会回显技术性的 message。
    note.registerErrorTranslator(describeInstallerError);
    return note;
}

interface FakeServiceOptions {
    versions?: VersionOption[];
    /** 拉版本列表失败。 */
    listFail?: Error;
    /** 探测到的疑似镜像（不传 = 没探到）。 */
    mirror?: RepoRef;
    /** 手填地址时 `setMirror` 失败（例如 id 不一致）。 */
    setMirrorFail?: Error;
}

/**
 * 只实现这个弹窗真正会碰的东西：拉版本列表、探测镜像、换来源、翻译错误。
 *
 * `setMirror` 与真实实现一样**就地改记录**（测试里那个 `plugin` 对象就是记录），
 * 否则「换完来源之后弹窗显示的是新地址」这条根本验不到。
 */
function makeService(options: FakeServiceOptions = {}) {
    const successes: string[] = [];
    const note = notifier();
    note.success = (message: string) => successes.push(message);

    const calls = {
        listed: 0,
        probed: 0,
        /** 手填过的地址。 */
        manual: [] as string[],
        /** 采用过的镜像（探测路径）。 */
        confirmed: [] as RepoRef[],
    };

    const service = {
        listVersions: async () => {
            calls.listed += 1;
            if (options.listFail) throw options.listFail;
            return options.versions ?? [latest(), release("1.2.0"), release("1.0.0")];
        },
        probeMirror: async () => {
            calls.probed += 1;
            return options.mirror;
        },
        setMirror: async (plugin: TrackedPlugin, input: string) => {
            calls.manual.push(input);
            if (options.setMirrorFail) throw options.setMirrorFail;
            const ref: RepoRef = { host: "gitee", owner: "sofqi", repo: "Trefoil" };
            plugin.host = ref.host;
            plugin.owner = ref.owner;
            plugin.repo = ref.repo;
            return ref;
        },
        confirmMirror: async (_plugin: TrackedPlugin, ref: RepoRef) => {
            calls.confirmed.push(ref);
        },
        deps: { notifier: note },
    } as unknown as InstallerService;

    return { service, successes, calls };
}

function plugin(overrides: Partial<TrackedPlugin> = {}): TrackedPlugin {
    return {
        kind: "plugin",
        host: "github",
        owner: "owner",
        repo: "demo",
        id: "demo",
        name: "Demo Plugin",
        installedVersion: "1.0.0",
        requestedVersion: "latest",
        frozen: false,
        channel: "release",
        installedAt: 0,
        ...overrides,
    } as TrackedPlugin;
}

/** 切换来源通知了几次（调用方据此重绘列表）。 */
let sourceChanges = 0;

function open(
    service: InstallerService,
    target: TrackedPlugin = plugin(),
    chosen: VersionOption[] = []
): VersionManagerModal {
    const modal = new VersionManagerModal({} as App, service, zhCN, target, {
        onChoose: (option) => chosen.push(option),
        onSourceChanged: () => {
            sourceChanges += 1;
        },
    });
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

/** 内容区里有没有那个会转的圆环（用户要的「加载动画」）。 */
function hasSpinner(modal: VersionManagerModal): boolean {
    const walk = (node: unknown): boolean => {
        const el = node as { cls?: string; children?: unknown[] };
        if ((el.cls ?? "").includes("obsync-spinner")) return true;
        return (el.children ?? []).some(walk);
    };
    return ((modal.contentEl.children as unknown) as unknown[]).some(walk);
}

/**
 * 「下载来源」那一行额外创建的行。
 *
 * 替身里的 `setDesc` 只记字符串、不往 `descEl` 里写（真实 Obsidian 是写进去的），
 * 所以这里读到的 children 正好就是额外创建的那几行（与 `trackedItemsList.test.ts`
 * 里 `extraLines()` 同一手法）。每一行会把行内所有文本拼起来 —— 「前缀 + 可点开的
 * 链接」那种一行里有多段文本的也能断言。
 */
function sourceLines(): string[] {
    const row = [...createdSettings]
        .reverse()
        .find((setting) => setting.name === zhCN.installer.versionSourceLabel);
    if (!row) throw new Error("还没有渲染出「下载来源」那一行");
    const walk = (node: unknown): string[] => {
        const el = node as { text?: string; children?: unknown[] };
        return [...(el.text ? [el.text] : []), ...(el.children ?? []).flatMap(walk)];
    };
    return ((row.descEl.children as unknown) as unknown[]).map((child) => walk(child).join(""));
}

/** 「下载来源」那一行里的 `<a>`（可点开的地址）。 */
function sourceAnchors(): Array<{ text?: string; attrs: Record<string, string> }> {
    const row = [...createdSettings]
        .reverse()
        .find((setting) => setting.name === zhCN.installer.versionSourceLabel);
    if (!row) throw new Error("还没有渲染出「下载来源」那一行");
    const walk = (node: unknown): Array<{ text?: string; attrs: Record<string, string> }> => {
        const el = node as {
            tagName?: string;
            text?: string;
            attrs?: Record<string, string>;
            children?: unknown[];
        };
        const self = el.tagName === "A" ? [{ text: el.text, attrs: el.attrs ?? {} }] : [];
        return [...self, ...(el.children ?? []).flatMap(walk)];
    };
    return ((row.descEl.children as unknown) as unknown[]).flatMap(walk);
}

/** 「安装版本」那一行 —— 列表本身没有下拉框，按「有下拉框的那一行」找。 */
function versionRow(): Setting {
    const row = [...createdSettings].reverse().find((setting) => setting.dropdowns.length > 0);
    if (!row) throw new Error("还没有渲染出版本下拉框");
    return row;
}

function dropdown(): DropdownComponent {
    return versionRow().dropdowns[0]!;
}

function buttonWithText(text: string): ButtonComponent {
    const row = [...createdSettings]
        .reverse()
        .find((setting) => setting.buttons.some((button) => button.text === text));
    if (!row) throw new Error(`还没有渲染出「${text}」按钮`);
    return row.buttons.find((button) => button.text === text)!;
}

function applyButton(): ButtonComponent {
    return buttonWithText(zhCN.installer.versionApply);
}

/** 手填镜像地址的输入框。 */
function manualInput(): TextComponent {
    const row = [...createdSettings]
        .reverse()
        .find((setting) => setting.texts.length > 0);
    if (!row) throw new Error("还没有渲染出手填地址的输入框");
    return row.texts[0]!;
}

/** 下拉框里某个 value 对应的**显示标签**（标「当前」看的就是它）。 */
function labelOf(value: string): string {
    return dropdown().options.find((option) => option.value === value)?.label ?? "";
}

beforeEach(() => {
    resetCreatedSettings();
    sourceChanges = 0;
});

describe("VersionManagerModal 的列表状态", () => {
    it("还在拉列表时只说「正在获取」**并且真的在转**（不然用户不知道是不是卡住）", async () => {
        let resolveList: ((options: VersionOption[]) => void) | undefined;
        const service = {
            listVersions: () =>
                new Promise<VersionOption[]>((resolve) => {
                    resolveList = resolve;
                }),
            probeMirror: async () => undefined,
            deps: { notifier: notifier() },
        } as unknown as InstallerService;

        const modal = open(service, plugin(), []);

        expect(modalTexts(modal)).toContain(zhCN.installer.versionLoading);
        // 这一条是用户直接提的：「请显示加载动画」
        expect(hasSpinner(modal)).toBe(true);
        expect(createdSettings.some((setting) => setting.dropdowns.length > 0)).toBe(false);

        resolveList!([latest(), release("1.0.0")]);
        await vi.waitFor(() => expect(versionRow()).toBeDefined());
    });

    it("一个 release 都没有时说清「没有可切换的版本」，并把按钮置灰", async () => {
        const { service } = makeService({ versions: [latest()] });
        const modal = open(service);

        await vi.waitFor(() => expect(applyButton()).toBeDefined());
        expect(modalTexts(modal)).toContain(zhCN.installer.versionNoneAvailable);
        expect(applyButton().disabled).toBe(true);
    });

    it("拉列表失败时报失败原因（**不是**「没有版本」），并把按钮置灰", async () => {
        const { service } = makeService({ listFail: new Error("boom") });
        const modal = open(service);

        await vi.waitFor(() => expect(applyButton()).toBeDefined());
        const texts = modalTexts(modal).join("\n");
        expect(texts).toContain(zhCN.installer.versionFetchFailed);
        expect(texts).toContain("boom");
        // 「拉不到」与「没有版本」给用户的下一步完全不同：前者可以重试。
        expect(texts).not.toContain(zhCN.installer.versionNoneAvailable);
        expect(applyButton().disabled).toBe(true);
    });

    it("拉不到列表时连可搜索列表那个按钮也置灰", async () => {
        const { service } = makeService({ listFail: new Error("boom") });
        open(service);

        await vi.waitFor(() => expect(applyButton()).toBeDefined());
        expect(versionRow().buttons.map((button) => button.icon)).toEqual(["list"]);
        expect(versionRow().buttons[0]!.disabled).toBe(true);
    });
});

describe("VersionManagerModal 的当前版本标记", () => {
    it("把**磁盘上装的那一版**标成「当前」", async () => {
        const { service } = makeService({ versions: [latest(), release("1.2.0"), release("1.0.0")] });
        open(service, plugin({ installedVersion: "1.2.0" }));

        await vi.waitFor(() => expect(versionRow()).toBeDefined());
        expect(labelOf("1.2.0")).toBe(`1.2.0 · ${zhCN.installer.versionCurrent}`);
        expect(labelOf("1.0.0")).toBe("1.0.0");
    });

    it("tag 与 manifest 里的版本不同形（`v1.2.0` ↔ `1.2.0`）时照样认得出", async () => {
        // 这是常态而不是边角：release tag 常常带 v 前缀，manifest 里的 version 不带。
        // 用字符串相等判断，「当前」这两个字就永远不会出现。
        const { service } = makeService({ versions: [latest(), release("v1.2.0")] });
        open(service, plugin({ installedVersion: "1.2.0" }));

        await vi.waitFor(() => expect(versionRow()).toBeDefined());
        expect(labelOf("v1.2.0")).toContain(zhCN.installer.versionCurrent);
    });

    it("「最新版本」这一项永远不标「当前」（它说的是「跟着最新走」，不是版本号）", async () => {
        const { service } = makeService({ versions: [latest(), release("1.0.0")] });
        open(service, plugin({ installedVersion: "1.0.0" }));

        await vi.waitFor(() => expect(versionRow()).toBeDefined());
        expect(labelOf("latest")).toBe(zhCN.installer.versionLatest);
        expect(labelOf("1.0.0")).toContain(zhCN.installer.versionCurrent);
    });

    it("已装版本读不到时不写空壳（手工装的目录可能读不出 manifest）", async () => {
        const { service } = makeService();
        const modal = open(service, plugin({ installedVersion: "" }));

        await vi.waitFor(() => expect(versionRow()).toBeDefined());
        expect(modalTexts(modal)).toContain(zhCN.installer.versionInstalledUnknown);
    });

    it("读得到时把当前版本写在最前面（下面那串 tag 要靠它才有参照）", async () => {
        const { service } = makeService();
        const modal = open(service, plugin({ installedVersion: "1.0.0" }));

        await vi.waitFor(() => expect(versionRow()).toBeDefined());
        expect(modalTexts(modal)).toContain(zhCN.installer.versionInstalled("1.0.0"));
    });
});

describe("VersionManagerModal 的默认选中与提交", () => {
    it("默认选中**记录里那个**选择，而不是「最新版本」", async () => {
        // 默认成「最新」会把这个控件变成一个不断把用户往最新版拽的东西，
        // 而用户再打开它想确认的是「我钉在哪一版」。
        const { service } = makeService();
        open(service, plugin({ requestedVersion: "1.0.0" }));

        await vi.waitFor(() => expect(versionRow()).toBeDefined());
        expect(dropdown().value).toBe("1.0.0");
    });

    it("记录里的 tag 已经不在列表里时回落到第一项（否则下拉框显示一个不存在的值）", async () => {
        const { service } = makeService({ versions: [latest(), release("1.2.0")] });
        open(service, plugin({ requestedVersion: "9.9.9" }));

        await vi.waitFor(() => expect(versionRow()).toBeDefined());
        expect(dropdown().value).toBe("latest");
    });

    it("点「切换到此版本」把选中的那个版本交出去", async () => {
        const { service } = makeService();
        const chosen: VersionOption[] = [];
        open(service, plugin({ requestedVersion: "latest" }), chosen);

        await vi.waitFor(() => expect(versionRow()).toBeDefined());
        dropdown().select("1.0.0");
        applyButton().click();

        expect(chosen).toHaveLength(1);
        expect(chosen[0]!.value).toBe("1.0.0");
    });

    it("交出去的是**用户选的那个**，不是默认那个", async () => {
        const { service } = makeService();
        const chosen: VersionOption[] = [];
        open(service, plugin(), chosen);

        await vi.waitFor(() => expect(versionRow()).toBeDefined());
        dropdown().select("1.2.0");
        applyButton().click();

        expect(chosen[0]!.value).toBe("1.2.0");
    });
});

/**
 * 下载来源。
 *
 * 真机动因（2026-09-19）：用户想把 Trefoil 退回 1.0.2，但 GitHub 的 release 资产
 * 域名在国内经常连不上（实测第一次请求 17~25 秒，见 HANDOVER 第七节第 19 条），
 * 而它的 Gitee 镜像（`gitee.com/sofqi/Trefoil`）**有** 1.0.2，下载只要 3 秒。
 * 问题是：自动探测只猜「同名仓库」和「你 Gitee 账号下的同名仓库」，而 Trefoil 的
 * 镜像是 `sofqi/…`、GitHub owner 是 `Dyse-Sofqi`（Gitee 上没这个 owner）——
 * 两个候选都不成立，于是用户既看不到镜像、也没有入口能把它指出来。
 */
describe("VersionManagerModal 的下载来源", () => {
    const MIRROR: RepoRef = { host: "gitee", owner: "sofqi", repo: "Trefoil" };

    it("先说清现在下载走哪个地址", async () => {
        const { service } = makeService();
        open(service);

        await vi.waitFor(() => expect(versionRow()).toBeDefined());
        expect(sourceLines()).toContain(
            zhCN.installer.versionSourceCurrent("GitHub", "owner/demo")
        );
    });

    it("已经在走镜像时，把源仓库也列出来（用户才知道家在哪）", async () => {
        const { service } = makeService();
        open(
            service,
            plugin({
                host: "gitee",
                owner: "sofqi",
                repo: "Trefoil",
                origin: { host: "github", owner: "Dyse-Sofqi", repo: "Trefoil" },
            })
        );

        await vi.waitFor(() => expect(versionRow()).toBeDefined());
        expect(sourceLines()).toEqual([
            zhCN.installer.versionSourceCurrent("Gitee", "sofqi/Trefoil"),
            zhCN.installer.versionSourceOrigin("GitHub", "Dyse-Sofqi/Trefoil"),
        ]);
    });

    it("探测到镜像时给出「改用」按钮，点了就采用并重拉版本", async () => {
        const { service, successes, calls } = makeService({ mirror: MIRROR });
        open(service);

        await vi.waitFor(() => expect(versionRow()).toBeDefined());
        expect(sourceLines()).toContain(
            `${zhCN.installer.versionMirrorFoundPrefix}Gitee · sofqi/Trefoil`
        );
        // 地址要能点开去核对（用户决定「要不要换信任对象」的全部依据就在这里）
        expect(sourceAnchors()).toEqual([
            {
                text: "Gitee · sofqi/Trefoil",
                attrs: {
                    href: "https://gitee.com/sofqi/Trefoil",
                    target: "_blank",
                    rel: "noopener",
                    title: zhCN.installer.openRepo,
                },
            },
        ]);
        const listedBefore = calls.listed;

        buttonWithText(zhCN.installer.versionUseMirror("Gitee")).click();

        await vi.waitFor(() => expect(calls.confirmed).toHaveLength(1));
        expect(calls.confirmed[0]).toEqual(MIRROR);
        expect(successes).toEqual([zhCN.installer.mirrorConfirmed("Gitee", "sofqi/Trefoil")]);
        // 换了来源，这条记录要不要重绘、版本列表要不要重拉：都必须
        expect(sourceChanges).toBe(1);
        await vi.waitFor(() => expect(calls.listed).toBeGreaterThan(listedBefore));
    });

    it("探不到镜像时说清**为什么**（探测只会猜两个候选，不去猜账号）", async () => {
        const { service } = makeService();
        open(service);

        await vi.waitFor(() => expect(versionRow()).toBeDefined());
        expect(sourceLines()).toContain(zhCN.installer.versionMirrorNone);
    });

    it("手填地址：填之前按钮是灰的，填入后**立即**可用（不重绘、不丢焦点）", async () => {
        // 与 AddRepoModal 的「识别」按钮同一类缺陷：可用性只在渲染时算一次，
        // 而打字不会触发重绘 —— 症状是按钮永远是灰的。
        const { service } = makeService();
        open(service);

        await vi.waitFor(() => expect(versionRow()).toBeDefined());
        expect(buttonWithText(zhCN.installer.versionManualApply).disabled).toBe(true);

        const before = createdSettings.length;
        manualInput().type("sofqi/Trefoil");

        expect(buttonWithText(zhCN.installer.versionManualApply).disabled).toBe(false);
        // 就地改状态，不重建内容区（否则输入框会被销毁、光标丢失）
        expect(createdSettings.length).toBe(before);
    });

    it("手填地址成功后：记录换成镜像、提示、通知调用方，并按新来源重拉版本", async () => {
        const { service, successes, calls } = makeService();
        const target = plugin();
        open(service, target);

        await vi.waitFor(() => expect(versionRow()).toBeDefined());
        const listedBefore = calls.listed;
        manualInput().type("sofqi/Trefoil");
        buttonWithText(zhCN.installer.versionManualApply).click();

        await vi.waitFor(() => expect(calls.manual).toEqual(["sofqi/Trefoil"]));
        // 真实实现就地改记录 —— 这里验的是「弹窗跟着显示新地址」这条链
        expect(target.host).toBe("gitee");
        expect(target.repo).toBe("Trefoil");
        expect(successes).toEqual([zhCN.installer.mirrorConfirmed("Gitee", "sofqi/Trefoil")]);
        expect(sourceChanges).toBe(1);
        await vi.waitFor(() => expect(calls.listed).toBeGreaterThan(listedBefore));
        await vi.waitFor(() =>
            expect(sourceLines()).toContain(
                zhCN.installer.versionSourceCurrent("Gitee", "sofqi/Trefoil")
            )
        );
    });

    it("手填地址 id 不一致时把原因显示出来，且**不**改记录", async () => {
        const mismatch = new InstallerError({
            kind: "mirrorIdMismatch",
            repo: "sofqi/Trefoil",
            expected: "demo",
            found: "something-else",
        });
        const { service, calls } = makeService({ setMirrorFail: mismatch });
        const target = plugin();
        const modal = open(service, target);

        await vi.waitFor(() => expect(versionRow()).toBeDefined());
        manualInput().type("sofqi/Trefoil");
        buttonWithText(zhCN.installer.versionManualApply).click();

        await vi.waitFor(() => expect(calls.manual).toEqual(["sofqi/Trefoil"]));
        await vi.waitFor(() =>
            expect(modalTexts(modal).join("\n")).toContain(
                zhCN.installer.errors.mirrorIdMismatch("sofqi/Trefoil", "demo", "something-else")
            )
        );
        expect(target.host).toBe("github");
        expect(sourceChanges).toBe(0);
    });
});
