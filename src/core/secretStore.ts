import type { App } from "obsidian";
import { requireApiVersion } from "obsidian";
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
 *
 * ## 关于 `requireApiVersion` 的写法（社区审核踩坑，别改回去）
 *
 * `app.secretStorage` 与它的 `getSecret` / `setSecret` 都是 **`@since 1.11.4`**，
 * 而 manifest 的 `minAppVersion` 是 **1.8.7**。审核规则
 * `obsidianmd/no-unsupported-api` 要求这些调用被 `requireApiVersion` 守卫，
 * 但它对写法有三个硬性要求（0.1.4 逐条实测出来的）：
 *
 * 1. **版本号必须是字符串字面量**。`requireApiVersion("1.11.4")` 认；
 *    传 `SECRET_STORAGE_SINCE` 这类常量**不认** —— 规则源码里判的是
 *    `arguments[0].type === Literal`，拿到标识符就取不到版本，直接当没有守卫。
 *    所以下面三处调用点写的都是字面量，**别抽成常量**。
 * 2. **成员访问必须**在 `if (requireApiVersion(...))` 的**花括号里面**
 *    （或 `&&` 的右侧、三元的真分支）。
 * 3. **提前 return 型守卫不算数**：`if (!requireApiVersion(...)) return;`
 *    之后再去访问成员，语义完全正确，但成员访问是那个 `if` 的**兄弟语句**，
 *    规则沿父链找不到守卫，照样报错。所以这里一律用**正向 `if` 包住调用**。
 *
 * 也**不要**改用「结构类型」让它闭嘴：那样规则确实不报，但报不报就与守卫无关了
 * —— 把守卫整段删掉 lint 依然全绿（实测过），等于把闸门拆了。
 * 运行时那一侧由 `tests/core/secretStore.test.ts` 守着：把 API 版本调到 1.10.0，
 * **即使 SecretStorage 在场也不许碰**。
 */

const SECRET_ID_PREFIX = "obsync-token-";
const LOCAL_STORAGE_PREFIX = "obsync-token-";

export class SecretStore {
    constructor(private readonly app: App) {}

    /**
     * 当前是否走系统级密钥存储。设置页用它决定提示文案。
     *
     * 版本对了也真检查一遍对象在不在：类型上 `secretStorage` 永远在
     * （`node_modules/obsidian` 的类型是最新版），而真机上未必。
     */
    isUsingSecretStorage(): boolean {
        return requireApiVersion("1.11.4") && this.app.secretStorage !== undefined;
    }

    private secretId(host: HostKind): string {
        // SecretStorage 要求 id 为「小写字母数字 + 可选连字符」。
        return `${SECRET_ID_PREFIX}${host}`;
    }

    private localStorageKey(host: HostKind): string {
        return `${LOCAL_STORAGE_PREFIX}${host}`;
    }

    getToken(host: HostKind): string | undefined {
        // 两个条件缺一不可：
        // - `requireApiVersion` 是给审核看的（1.11.4 以下不许碰这个 API）；
        // - `this.app.secretStorage` 是**运行时兜底**：版本够新但对象缺失时
        //   （真机上出现过，测试替身里也常态）必须继续往下走 localStorage，
        //   否则 `?.` 会静默吞掉整次读写 —— 令牌存不进去，而没有任何报错。
        //   实测：去掉后半句，3 个测试文件（secretStore / hostRegistry / auth）
        //   共 4 条用例立刻变红，全是「令牌不见了」。
        if (requireApiVersion("1.11.4") && this.app.secretStorage) {
            const value = this.app.secretStorage.getSecret(this.secretId(host));
            // **空串算「没有」**，与下面 localStorage 那条分支的判据保持一致。
            // SecretStorage 没有 delete，`clearToken()` 只能写空串；若这里写成
            // `value ?? undefined`，清空之后本函数会返回 `""` —— 而
            // `syncService` 的鉴权诊断判的是 `getToken(...) !== undefined`，
            // 于是「令牌已清空」会被报成「令牌就绪」。两条分支对同一个问题
            // 给出相反答案，是最难查的那种不一致。
            return value ? value : undefined;
        }

        // `loadLocalStorage` 声明的返回类型是 `any`（Obsidian 的 d.ts 如此），
        // 所以先收进 unknown 再判类型 —— 直接比较会让这条 `any` 一路传出去。
        const value: unknown = this.app.loadLocalStorage(this.localStorageKey(host));
        return typeof value === "string" && value.length > 0 ? value : undefined;
    }

    setToken(host: HostKind, token: string): void {
        const trimmed = token.trim();

        if (requireApiVersion("1.11.4") && this.app.secretStorage) {
            // SecretStorage 没有 delete，用空串清除（`getToken` 会把空串当没有）。
            this.app.secretStorage.setSecret(this.secretId(host), trimmed);
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