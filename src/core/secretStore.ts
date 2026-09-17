import type { App, SecretStorage } from "obsidian";
import { SUPPORTED_HOSTS, type HostKind } from "../host/types";

/**
 * 访问令牌存储。
 *
 * 参考项目 obsidian-git 把凭据放进 `app.saveLocalStorage`（明文，但刻意不进
 * `data.json`，以便多设备同步配置时不带上凭据）。BRAT 则迁移到了
 * `app.secretStorage`（Obsidian 1.11.4+ 的系统级密钥存储）。
 *
 * 这里两者都支持：**能用 SecretStorage 就用**，老版本 Obsidian 回退到
 * localStorage。任何情况下令牌都不会写进 `data.json`。
 */

const SECRET_ID_PREFIX = "obsync-token-";
const LOCAL_STORAGE_PREFIX = "obsync-token-";

export class SecretStore {
    constructor(private readonly app: App) {}

    /** SecretStorage 是 Obsidian 1.11.4 才有的，老版本上不存在。 */
    private get secretStorage(): SecretStorage | undefined {
        const storage = (this.app as unknown as { secretStorage?: SecretStorage })
            .secretStorage;
        // 运行时不存在的 API 在类型上却存在，所以要真检查一遍。
        return typeof storage?.getSecret === "function" ? storage : undefined;
    }

    /** 当前是否走系统级密钥存储。设置页用它决定提示文案。 */
    isUsingSecretStorage(): boolean {
        return this.secretStorage !== undefined;
    }

    private secretId(host: HostKind): string {
        // SecretStorage 要求 id 为「小写字母数字 + 可选连字符」。
        return `${SECRET_ID_PREFIX}${host}`;
    }

    private localStorageKey(host: HostKind): string {
        return `${LOCAL_STORAGE_PREFIX}${host}`;
    }

    getToken(host: HostKind): string | undefined {
        const storage = this.secretStorage;
        if (storage) {
            const value = storage.getSecret(this.secretId(host));
            return value ?? undefined;
        }

        const value = this.app.loadLocalStorage(this.localStorageKey(host));
        return typeof value === "string" && value.length > 0 ? value : undefined;
    }

    setToken(host: HostKind, token: string): void {
        const trimmed = token.trim();
        const storage = this.secretStorage;
        if (storage) {
            if (!trimmed) {
                // SecretStorage 没有 delete，用空串清除。
                storage.setSecret(this.secretId(host), "");
                return;
            }
            storage.setSecret(this.secretId(host), trimmed);
            return;
        }

        this.app.saveLocalStorage(
            this.localStorageKey(host),
            trimmed.length > 0 ? trimmed : null
        );
    }

    clearToken(host: HostKind): void {
        this.setToken(host, "");
    }

    /** 一次性取出所有平台的令牌，供 host 层调用。 */
    snapshot(): Partial<Record<HostKind, string>> {
        const result: Partial<Record<HostKind, string>> = {};
        for (const host of SUPPORTED_HOSTS) {
            const token = this.getToken(host);
            if (token) result[host] = token;
        }
        return result;
    }
}
