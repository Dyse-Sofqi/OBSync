import { PluginSettingTab, Setting, type App } from "obsidian";
import { LANGUAGE_OPTIONS, type LanguageSetting } from "./core/i18n";
import type ObsyncPlugin from "./main";
import { getHost } from "./host/hostRegistry";
import type { HostKind } from "./host/types";

/**
 * 设置页。
 *
 * 与参考项目 BRAT 的一个明显不同：BRAT 的 `SettingsTab.ts` 有 30KB，
 * 并且**新旧两套渲染方式并存**（声明式的 `getSettingDefinitions()` 与
 * 手写的 `display()`），因为要兼容不同 Obsidian 版本。这里只用后者 ——
 * 兼容包袱不值得背。
 */
export class ObsyncSettingsTab extends PluginSettingTab {
    constructor(private readonly obsync: ObsyncPlugin) {
        super(obsync.app, obsync);
    }

    display(): void {
        const { containerEl } = this;
        const t = this.obsync.t;
        containerEl.empty();

        this.renderLanguage();
        this.renderTokens();
        this.renderGeneral();
        this.renderInstaller();
        this.renderSync();

        void t; // t 在各 render 方法里按需取，这里只是保持引用一致
    }

    /** 设置改完后统一走这里：落盘 + 重算派生状态 + 重绘。 */
    private async commit(redraw = false): Promise<void> {
        await this.obsync.saveSettings();
        this.obsync.applyDerivedSettings();
        if (redraw) this.display();
    }

    private renderLanguage(): void {
        const t = this.obsync.t;

        new Setting(this.containerEl)
            .setName(t.settings.language.name)
            .setDesc(t.settings.language.desc)
            .addDropdown((dropdown) => {
                for (const option of LANGUAGE_OPTIONS) {
                    dropdown.addOption(
                        option.value,
                        option.value === "auto" ? t.settings.language.auto : option.label
                    );
                }
                dropdown.setValue(this.obsync.settings.language);
                dropdown.onChange(async (value) => {
                    this.obsync.settings.language = value as LanguageSetting;
                    // 语言变了，整页文案都要换，所以重绘。
                    await this.commit(true);
                });
            });
    }

    private renderTokens(): void {
        const t = this.obsync.t;

        new Setting(this.containerEl).setName(t.settings.token.heading).setHeading();
        this.containerEl.createEl("p", {
            cls: "setting-item-description",
            text: t.settings.token.desc,
        });

        this.renderTokenField("github");
        this.renderTokenField("gitee");
    }

    private renderTokenField(host: HostKind): void {
        const t = this.obsync.t;
        const name =
            host === "github" ? t.settings.token.githubName : t.settings.token.giteeName;
        const desc =
            host === "github" ? t.settings.token.githubDesc : t.settings.token.giteeDesc;

        let pending = this.obsync.secretStore.getToken(host) ?? "";
        let dirty = false;

        const setting = new Setting(this.containerEl)
            .setName(name)
            .setDesc(desc)
            .addText((text) => {
                text.inputEl.type = "password";
                text.inputEl.autocomplete = "off";
                text.inputEl.spellcheck = false;
                text.setPlaceholder(t.settings.token.placeholder);
                text.setValue(pending);
                // 每次按键都写密钥存储太浪费，改成内存暂存 + 失焦落盘。
                text.onChange((value) => {
                    pending = value;
                    dirty = true;
                });
                text.inputEl.addEventListener("blur", () => {
                    if (!dirty) return;
                    dirty = false;
                    this.obsync.secretStore.setToken(host, pending);
                });
            })
            .addButton((button) =>
                button.setButtonText(t.settings.token.test).onClick(async () => {
                    const token = pending.trim();
                    if (!token) {
                        this.obsync.secretStore.clearToken(host);
                        this.obsync.notifier.info(t.settings.token.cleared);
                        return;
                    }

                    this.obsync.secretStore.setToken(host, token);
                    dirty = false;

                    button.setDisabled(true);
                    button.setButtonText(t.settings.token.testing);
                    try {
                        const info = await getHost(host).validateToken(token);
                        if (info.valid) {
                            this.obsync.notifier.success(
                                t.settings.token.valid(
                                    getHost(host).displayName,
                                    info.account ?? t.common.unknown
                                )
                            );
                        } else {
                            this.obsync.notifier.error(
                                t.settings.token.invalid(getHost(host).displayName)
                            );
                        }
                    } catch (err) {
                        this.obsync.notifier.reportError(
                            err,
                            t.settings.token.invalid(getHost(host).displayName)
                        );
                    } finally {
                        button.setDisabled(false);
                        button.setButtonText(t.settings.token.test);
                    }
                })
            )
            .addExtraButton((button) =>
                button
                    .setIcon("trash")
                    .setTooltip(t.common.delete)
                    .onClick(async () => {
                        this.obsync.secretStore.clearToken(host);
                        pending = "";
                        dirty = false;
                        setting.settingEl.empty();
                        this.display();
                        this.obsync.notifier.info(t.settings.token.cleared);
                    })
            );

        void setting;
    }

    private renderGeneral(): void {
        const t = this.obsync.t;

        new Setting(this.containerEl).setName(t.settings.general.heading).setHeading();

        new Setting(this.containerEl)
            .setName(t.settings.general.showNotices)
            .setDesc(t.settings.general.showNoticesDesc)
            .addToggle((toggle) =>
                toggle.setValue(this.obsync.settings.showNotices).onChange(async (value) => {
                    this.obsync.settings.showNotices = value;
                    await this.commit();
                })
            );

        new Setting(this.containerEl)
            .setName(t.settings.general.debugLogging)
            .setDesc(t.settings.general.debugLoggingDesc)
            .addToggle((toggle) =>
                toggle.setValue(this.obsync.settings.debugLogging).onChange(async (value) => {
                    this.obsync.settings.debugLogging = value;
                    await this.commit();
                })
            );
    }

    private renderInstaller(): void {
        const t = this.obsync.t;
        const settings = this.obsync.settings.installer;

        new Setting(this.containerEl).setName(t.settings.installer.heading).setHeading();

        new Setting(this.containerEl)
            .setName(t.settings.installer.enabled)
            .setDesc(t.settings.installer.enabledDesc)
            .addToggle((toggle) =>
                toggle.setValue(settings.enabled).onChange(async (value) => {
                    settings.enabled = value;
                    await this.commit();
                })
            );

        new Setting(this.containerEl)
            .setName(t.settings.installer.autoCheck)
            .setDesc(t.settings.installer.autoCheckDesc)
            .addToggle((toggle) =>
                toggle.setValue(settings.autoCheckOnStartup).onChange(async (value) => {
                    settings.autoCheckOnStartup = value;
                    await this.commit();
                })
            );

        new Setting(this.containerEl)
            .setName(t.settings.installer.autoCheckDelay)
            .setDesc(t.settings.installer.autoCheckDelayDesc)
            .addText((text) => {
                text.inputEl.type = "number";
                text.inputEl.min = "0";
                text.inputEl.max = "3600";
                text.setValue(String(settings.autoCheckDelaySeconds));
                text.onChange(async (value) => {
                    const parsed = Number.parseInt(value, 10);
                    if (!Number.isFinite(parsed)) return;
                    settings.autoCheckDelaySeconds = parsed;
                    await this.commit();
                });
            });

        new Setting(this.containerEl)
            .setName(t.settings.installer.mirrorDiscovery)
            .setDesc(t.settings.installer.mirrorDiscoveryDesc)
            .addToggle((toggle) =>
                toggle.setValue(settings.discoverGiteeMirrors).onChange(async (value) => {
                    settings.discoverGiteeMirrors = value;
                    await this.commit();
                })
            );
    }

    private renderSync(): void {
        const t = this.obsync.t;

        new Setting(this.containerEl).setName(t.settings.sync.heading).setHeading();

        // 移动端没有系统 git，直接说明原因，而不是给一堆点了没用的控件。
        if (!this.obsync.isSyncAvailable) {
            this.containerEl.createEl("p", {
                cls: "setting-item-description",
                text: t.settings.sync.desktopOnly,
            });
            return;
        }

        const settings = this.obsync.settings.sync;

        new Setting(this.containerEl)
            .setName(t.settings.sync.enabled)
            .setDesc(t.settings.sync.enabledDesc)
            .addToggle((toggle) =>
                toggle.setValue(settings.enabled).onChange(async (value) => {
                    settings.enabled = value;
                    await this.commit();
                })
            );

        const intervals: Array<{
            name: string;
            desc: string;
            get: () => number;
            set: (value: number) => void;
        }> = [
            {
                name: t.settings.sync.autoCommit,
                desc: t.settings.sync.autoCommitDesc,
                get: () => settings.autoCommitMinutes,
                set: (value) => (settings.autoCommitMinutes = value),
            },
            {
                name: t.settings.sync.autoPush,
                desc: t.settings.sync.autoPushDesc,
                get: () => settings.autoPushMinutes,
                set: (value) => (settings.autoPushMinutes = value),
            },
            {
                name: t.settings.sync.autoPull,
                desc: t.settings.sync.autoPullDesc,
                get: () => settings.autoPullMinutes,
                set: (value) => (settings.autoPullMinutes = value),
            },
        ];

        for (const interval of intervals) {
            new Setting(this.containerEl)
                .setName(interval.name)
                .setDesc(interval.desc)
                .addText((text) => {
                    text.inputEl.type = "number";
                    text.inputEl.min = "0";
                    text.setValue(String(interval.get()));
                    text.onChange(async (value) => {
                        const parsed = Number.parseInt(value, 10);
                        if (!Number.isFinite(parsed)) return;
                        interval.set(parsed);
                        await this.commit();
                    });
                });
        }

        new Setting(this.containerEl)
            .setName(t.settings.sync.commitMessage)
            .setDesc(t.settings.sync.commitMessageDesc)
            .addText((text) =>
                text.setValue(settings.commitMessage).onChange(async (value) => {
                    settings.commitMessage = value;
                    await this.commit();
                })
            );

        new Setting(this.containerEl)
            .setName("git 可执行文件路径")
            .setDesc("留空则使用系统 PATH 中的 git。Windows 上 git 未加入 PATH 时需要填写。")
            .addText((text) =>
                text
                    .setPlaceholder("C:\\Program Files\\Git\\cmd\\git.exe")
                    .setValue(settings.gitPath)
                    .onChange(async (value) => {
                        settings.gitPath = value.trim();
                        await this.commit();
                    })
            );
    }
}

/** 供测试与将来复用：从 app 构造设置页。 */
export function createSettingsTab(app: App, plugin: ObsyncPlugin): ObsyncSettingsTab {
    void app;
    return new ObsyncSettingsTab(plugin);
}
