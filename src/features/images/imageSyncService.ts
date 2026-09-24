import type { App } from "obsidian";
import { TFile } from "obsidian";
import type { LocaleStrings } from "../../core/i18n";
import type { Notifier } from "../../core/notice";
import type { ImageSyncSettings, ObsyncSettings } from "../../core/settings";
import type { SecretStore } from "../../core/secretStore";
import { ImageSyncError, requireConfig } from "./errors";
import { isInsideFolders, normalizeFolders, scanLocalImages } from "./imageScan";
import { R2Client, type R2Config } from "./r2Client";
import {
    forget,
    hasEntry,
    loadState,
    markRemoteOnly,
    markRemoteOnlyForced,
    pruneState,
    recordSynced,
    saveState,
    type ImageSyncState,
    type SyncedEntry,
} from "./syncState";
import type {
    LocalImage,
    RemoteObject,
    SyncPlan,
    SyncPlanEntry,
    SyncReason,
    SyncSummary,
} from "./types";

/**
 * 图片同步引擎。
 *
 * ## 双副本架构
 *
 * 「本地一份、云端一份」不是「上传」也不是「备份」，而是**镜像**：
 * 每一轮都把两边的差异算出来，然后把缺的那一边补齐。所以下载与上传
 * 走的是同一段代码，只有方向不同 —— 这也意味着**首次使用时云端已有的图片
 * 会被拉到本地**，而不是被忽略。
 *
 * ## 删除不在这套流程里（2026-09-23 改）
 *
 * 这里曾经实现「双向删除同步」：一边删了，另一边跟着删。它被去掉了，
 * 原因是那个判断**本质上无法做准**：同一个「本地有、云端没有」既可能是
 * 「用户删了云端那份」也可能是「本地新增」，而清单丢失、或者用户在两台设备上
 * 各删一边时，判断就会错 —— 代价是删掉一份用户没打算删的东西。
 *
 * 现在 `run()` **只会复制，不会删除**。删除只有一条路径，而且是用户主动发起的：
 *
 * - 用户在本机删掉一张图片 → 主类把它交到这里（`noteDeleted`）；
 * - 若那一份在云端有备份，弹一次确认（`ui/ConfirmDeleteRemoteModal`），
 *   问「要不要连云端一起删」；
 * - 答「删」→ `deleteRemoteBackup()`；答「留」→ `markLocalDeleted()`（墓碑已在，无需额外动作）
 *   （记一条墓碑，免得下一轮又把它下载回来 —— 那看起来像「删除没生效」）。
 *
 * 于是这个模块**从不删本地文件**，`run()` 里不可逆的操作只剩「覆盖」，
 * 而覆盖的是有备份的那一侧。
 *
 * ## 与 git 同步的关系
 *
 * 互不相干。图片文件夹通常**同时**在 git 仓库里，两条链路各管各的：
 * git 管版本历史，R2 管「图片不占仓库体积、且能被外链引用」。
 * 所以这里刻意不去动 `.gitignore`，也不假设图片没有被 git 跟踪。
 */

export interface ImageSyncDeps {
    app: App;
    notifier: Notifier;
    getT(): LocaleStrings;
    getSettings(): ObsyncSettings;
    secretStore: SecretStore;
    /** 一轮同步结束后通知外部（状态栏 / 设置页重绘）。 */
    onFinished?(summary: SyncSummary): void;
}

/** 内部的动作计划：带着执行需要的本地/远端数据。 */
interface PlannedAction {
    kind: "upload" | "download" | "skip";
    path: string;
    reason: SyncReason;
    local?: LocalImage;
    remote?: RemoteObject;
}

interface PlanResult {
    plan: SyncPlan;
    actions: PlannedAction[];
    state: ImageSyncState;
    truncated: boolean;
}

/** 扩展名 → Content-Type。上传时给对，云端取回来时浏览器才知道怎么显示。 */
const CONTENT_TYPES: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    avif: "image/avif",
    bmp: "image/bmp",
    svg: "image/svg+xml",
    heic: "image/heic",
    tif: "image/tiff",
    tiff: "image/tiff",
};

export function contentTypeFor(path: string): string {
    const index = path.lastIndexOf(".");
    const extension = index < 0 ? "" : path.slice(index + 1).toLowerCase();
    return CONTENT_TYPES[extension] ?? "application/octet-stream";
}

/**
 * 对象键 → vault 路径。
 *
 * 前缀之外的对象返回 undefined —— 那些是**别人的东西**（同一个桶里可能还放着
 * 别的应用的数据）。把它们当成本地文件处理会导致「云端新增 → 下载到库里」
 * 这种莫名其妙的副作用。
 */
export function pathFromKey(key: string, prefix: string): string | undefined {
    if (prefix && !key.startsWith(prefix)) return undefined;
    const path = prefix ? key.slice(prefix.length) : key;
    return path.length > 0 ? path : undefined;
}

export class ImageSyncService {
    private running = false;

    constructor(private readonly deps: ImageSyncDeps) {}

    get isBusy(): boolean {
        return this.running;
    }

    /**
     * 当前的图片同步设置。
     *
     * 存在的理由是**图片管理面板**：它要知道受管文件夹（决定哪些能删）与
     * 压缩默认值（决定批量压缩的参数），而这些只有服务拿得到。
     * 面板自己去读设置也行，但那会让「边界只有一处」这条约定出现第二个读点。
     */
    getImageSettings(): ImageSyncSettings {
        return this.deps.getSettings().images;
    }

    /** 配置齐不齐。设置页用它决定按钮的可用性。 */
    configProblem(): ImageSyncError | undefined {
        const settings = this.deps.getSettings().images;
        const secret = this.deps.secretStore.getSecretValue("r2") ?? "";

        const problem = requireConfig(
            {
                accountId: settings.accountId.trim(),
                bucket: settings.bucket.trim(),
                accessKeyId: settings.accessKeyId.trim(),
                secretAccessKey: secret.trim(),
            },
            ["accountId", "bucket", "accessKeyId", "secretAccessKey"]
        );
        if (problem) return problem;

        if (normalizeFolders(settings.folders).length === 0) {
            return new ImageSyncError("noFolders", {});
        }
        return undefined;
    }

    isConfigured(): boolean {
        return this.configProblem() === undefined;
    }

    /**
     * 只算不做：把这一轮会发生的动作列出来。
     *
     * 存在的理由是**删除**。同步本身是安全的（复制），但删除不是，
     * 所以用户需要一个「先让我看一眼」的入口 —— 设置页上的「预览变更」
     * 就是它，`run({ dryRun: true })` 也复用它。
     */
    async plan(): Promise<SyncPlan> {
        return (await this.planInternal()).plan;
    }

    /** 真正执行一轮。`dryRun` 时只算不做。 */
    async run(options: { dryRun?: boolean } = {}): Promise<SyncSummary> {
        if (this.running) {
            throw new ImageSyncError("listFailed", { status: 0, detail: "already running" });
        }

        this.running = true;
        try {
            return await this.runInternal(options);
        } finally {
            this.running = false;
        }
    }

    /**
     * 只同步选中的这些路径（图片管理面板的「同步选中」）。
     *
     * ## 为什么复用 `planInternal` 而不是逐条 `syncPath`
     *
     * 逐条上传只能处理「本地有」那一半：「云端有、本地没有」的图片根本没有
     * 本地文件可传，而在面板上「把云端那份拉下来」正是常见动作。走一遍完整
     * 计划就自然拿到了上传与下载两个方向，而且用的是**已经被单测覆盖过的
     * `decide()`** —— 面板不该另写一套「谁该传」的判断。
     *
     * 代价是要列举一次桶（`syncPath` 不用）。面板是用户主动打开、主动点按钮的
     * 场景，那点延迟换「方向正确」是值得的。
     */
    async syncSelection(paths: string[]): Promise<SyncSummary> {
        if (this.running) {
            throw new ImageSyncError("listFailed", { status: 0, detail: "already running" });
        }

        this.running = true;
        try {
            const wanted = new Set(paths);
            const { actions, state, truncated } = await this.planInternal();
            const selected = actions.filter((action) => wanted.has(action.path));
            return await this.executeActions(selected, state, truncated, {});
        } finally {
            this.running = false;
        }
    }

    /**
     * 云端的一份从旧路径搬到新路径 —— 本地重命名之后调用。
     *
     * 顺序是「先删旧键、再传新键」：反过来会在一瞬间出现两份，而删除旧键
     * 失败时至少新键是好的（用户看得见新名字的那一份在云端）。旧键不存在时
     * S3 的 DELETE 也是成功的（幂等），所以不需要先探测。
     *
     * 失败不抛错 —— 与 `syncPath` 同一个理由：它挂在一次用户交互后面，
     * 抛出去只会让调用方半路中断。
     */
    async renameRemoteBackup(from: string, to: string): Promise<boolean> {
        if (this.configProblem()) return false;

        const folders = normalizeFolders(this.getImageSettings().folders);
        if (!isInsideFolders(to, folders)) return false;

        try {
            const client = this.createClient();
            await client.deleteObject(client.keyFor(from));

            const state = loadState(this.deps.app);
            forget(state, from);
            saveState(this.deps.app, state);

            return await this.syncPath(to);
        } catch (error) {
            this.deps.notifier.reportError(error, this.deps.getT().images.notice.renameFailed);
            return false;
        }
    }

    /**
     * 云端列举结果（受管文件夹里的那些），按 vault 路径索引。
     *
     * `planInternal` 也走它 —— 两处口径必须是同一个，否则面板上显示的
     * 「云端有」与同步时看到的「云端有」会对不上，而那种不一致最难查。
     */
    async listRemoteImages(): Promise<{ remote: Map<string, RemoteObject>; truncated: boolean }> {
        const problem = this.configProblem();
        if (problem) throw problem;

        const folders = normalizeFolders(this.getImageSettings().folders);
        const client = this.createClient();
        const { objects, truncated } = await client.listAll();

        const remote = new Map<string, RemoteObject>();
        for (const object of objects) {
            const path = pathFromKey(object.key, client.prefix);
            if (!path) continue;
            // 前缀之下但不在受管文件夹里的对象同样跳过：前缀是「放哪儿」，
            // 文件夹是「管哪些」—— 两者都成立才归我们处理。
            if (!isInsideFolders(path, folders)) continue;
            remote.set(path, object);
        }
        return { remote, truncated };
    }

    /**
     * 单独上传一个文件（裁剪 / 压缩保存后调用）。
     *
     * **失败不抛错**：它挂在「保存图片」这个动作后面，是一个附带的优化 ——
     * 因为云端不可达而让用户存不下图，是本末倒置。失败只记日志，
     * 下一轮完整同步会把它补上。
     */
    async syncPath(path: string): Promise<boolean> {
        if (this.configProblem()) return false;

        const settings = this.deps.getSettings().images;
        const folders = normalizeFolders(settings.folders);
        if (!isInsideFolders(path, folders)) return false;

        try {
            const client = this.createClient();
            const file = this.deps.app.vault.getAbstractFileByPath(path);
            if (!(file instanceof TFile)) return false;

            const body = await this.deps.app.vault.readBinary(file);
            const etag = await client.putObject(client.keyFor(path), body, contentTypeFor(path));

            const state = loadState(this.deps.app);
            recordSynced(state, path, { size: file.stat.size, mtime: file.stat.mtime }, etag);
            saveState(this.deps.app, state);
            return true;
        } catch (error) {
            this.deps.notifier.reportError(error, this.deps.getT().images.notice.singleUploadFailed);
            return false;
        }
    }

    /** 打一次最小代价的请求，回答「这套配置到底能不能用」。 */
    async testConnection(): Promise<{ ok: boolean; error?: unknown }> {
        const problem = this.configProblem();
        if (problem) return { ok: false, error: problem };

        const result = await this.createClient().testConnection();
        return result.ok ? { ok: true } : { ok: false, error: result.error };
    }

    /**
     * 拼出这个图片的公网地址。
     *
     * 没有配 `publicBaseUrl` 时返回 undefined —— R2 的存储端点需要签名才能读，
     * 不能直接拿来当外链。要让图片能被笔记之外的地方引用，必须配一个
     * 自定义域名或 r2.dev 公开域名。这里**不猜**，猜出来的地址只会 403。
     */
    publicUrlFor(path: string): string | undefined {
        const base = this.deps.getSettings().images.publicBaseUrl.trim();
        if (!base) return undefined;
        const problem = this.configProblem();
        if (problem) return undefined;

        const key = this.createClient().keyFor(path);
        const encoded = key
            .split("/")
            .filter((segment) => segment.length > 0)
            .map(encodeURIComponent)
            .join("/");
        return `${base.replace(/\/+$/g, "")}/${encoded}`;
    }

    // ── 本地删除时的云端处置（都由用户拍板） ──────────────────────────────

    /**
     * 这个路径在云端有备份吗。
     *
     * 读的是状态清单，**不发网络请求** —— 用户删一张图时我们要立刻决定
     * 「要不要问他一句」，而为了这个问题去列举一次桶完全不成比例。
     *
     * 边界说清楚：清单是**按设备**记的。这台设备从没同步过、而别的设备传过
     * 同一张图时，这里会说「没有备份」。代价是**少问一次**（用户想在云端也
     * 删掉时得手动去删），而不是误删 —— 可以接受。
     */
    hasRemoteBackup(path: string): boolean {
        return hasEntry(loadState(this.deps.app), path);
    }

    /**
     * 用户确认「连云端一起删」。
     *
     * 与 `syncPath` 一样**失败不抛错**：它挂在一次用户交互后面，抛出去会让
     * 调用方（弹窗）在半路中断，而失败原因对用户也没有额外信息量。
     * 失败报一次错并返回 false。
     *
     * 删除成功之后**忘掉那条记录** —— 云端已经没有了，留着它会让
     * `hasRemoteBackup` 一直说「有备份」，下次删同名文件时白问一次。
     */
    async deleteRemoteBackup(path: string): Promise<boolean> {
        if (this.configProblem()) return false;

        const folders = normalizeFolders(this.deps.getSettings().images.folders);
        if (!isInsideFolders(path, folders)) return false;

        try {
            const client = this.createClient();
            await client.deleteObject(client.keyFor(path));

            const state = loadState(this.deps.app);
            forget(state, path);
            saveState(this.deps.app, state);
            return true;
        } catch (error) {
            // 失败时**刻意不清墓碑**：云端那一份还在，而本地已经没有了 ——
            // 正是墓碑要描述的处境（不会再被下载回来）。清掉反而会让下一轮
            // 同步把它拿回本地，而用户明明选了「删除」。
            this.deps.notifier.reportError(
                error,
                this.deps.getT().images.notice.deleteBackupFailed
            );
            return false;
        }
    }

    /**
     * 记下「这个路径的本地副本已经没了」——**在问用户之前就记**。
     *
     * ## 为什么不等回答之后再记（这里有一个真实的竞态）
     *
     * 弹窗要等一小会儿才出现（攒批，见 `features/images/index.ts`），而这几百
     * 毫秒里可能正好有一轮同步在跑。那一轮看到「云端有、本地没有」只会想到
     * 「补齐」—— 于是**把用户刚删掉的图下载回来**。用户接着选「删除云端」，
     * 下一次同步又因为「本地有、云端没有」把它传回云端：删除被静默撤销。
     *
     * 从本地消失的那一刻就记下来，这个窗口就不存在了。
     *
     * ## 与「保留」的关系
     *
     * 用户答「保留云端副本」时不需要做任何事 —— 墓碑已经在。答「删除云端」
     * 时由 `deleteRemoteBackup` 连墓碑一起清掉。而用户**没答**（Esc、关掉
     * Obsidian）时墓碑留着，正是最保守的那一档：云端那份不动，也不再回来。
     *
     * ## `remote` 这个可选参数
     *
     * 图片管理面板知道云端那一份的确切形状（它刚列举过桶），于是能在
     * 「清单里本来没有这条」时也建一条墓碑。理由见 `markRemoteOnlyForced`。
     */
    markLocalDeleted(path: string, remote?: { size: number; etag: string }): void {
        const state = loadState(this.deps.app);
        if (remote && !state.entries[path]) {
            markRemoteOnlyForced(state, path, remote);
        } else {
            markRemoteOnly(state, path);
        }
        saveState(this.deps.app, state);
    }

    // ── 计划 ──────────────────────────────────────────────────────────────

    private async planInternal(): Promise<PlanResult> {
        const problem = this.configProblem();
        if (problem) throw problem;

        const settings = this.getImageSettings();
        const folders = normalizeFolders(settings.folders);

        const localImages = scanLocalImages(this.deps.app, folders);
        const localByPath = new Map(localImages.map((image) => [image.path, image]));

        const { remote: remoteByPath, truncated } = await this.listRemoteImages();

        const state = loadState(this.deps.app);
        const actions: PlannedAction[] = [];

        for (const path of sortedUnion(localByPath.keys(), remoteByPath.keys())) {
            const local = localByPath.get(path);
            const remote = remoteByPath.get(path);
            const tracked = state.entries[path];

            actions.push(
                this.decide({ path, local, remote, tracked, settings })
            );
        }

        const entries: SyncPlanEntry[] = actions.map((action) => ({
            path: action.path,
            // 冲突在执行时就是「上传」或「下载」，但**预览里必须显示成冲突**。
            //
            // 这一页的用途是让用户在执行前看清「有哪些东西会被覆盖」，而冲突
            // 正是那种「有一边的改动要消失」的情况。写成 upload/download 会让它
            // 混进普通的上传里、还带上「安全」的绿色 —— 而它恰恰是这一页上
            // 第二需要被看见的东西（第一是删除）。
            action: action.reason === "conflict" ? "conflict" : action.kind,
            reason: action.reason,
            size: action.local?.size ?? action.remote?.size,
        }));

        return {
            plan: {
                entries,
                truncated,
                remoteCount: remoteByPath.size,
                localCount: localByPath.size,
            },
            actions,
            state,
            truncated,
        };
    }

    /**
     * 单个路径的判定。
     *
     * 这段逻辑是整套设计的核心，所以写成独立方法并配了穷尽的单测
     * （`tests/features/images/planSync.test.ts`）—— 它的每一种分支组合
     * 都对应「传一份文件」或「不传」。
     *
     * **它不产生任何删除动作**：删除只在用户明确要求时发生，见文件头。
     */
    private decide(input: {
        path: string;
        local?: LocalImage;
        remote?: RemoteObject;
        tracked?: SyncedEntry;
        settings: ImageSyncSettings;
    }): PlannedAction {
        const { path, local, remote, tracked, settings } = input;

        // ── 两边都有 ──
        if (local && remote) {
            // 没有记录时只能比大小：相等就当一致（并借这一轮把它记下来），
            // 不等就是冲突。**不能**当成「新增」—— 那会无条件用某一边覆盖另一边。
            const localChanged = tracked
                ? local.size !== tracked.size || local.mtime > tracked.mtime
                : local.size !== remote.size;
            const remoteChanged = tracked
                ? remote.etag !== tracked.etag
                : local.size !== remote.size;

            if (!localChanged && !remoteChanged) {
                return { kind: "skip", path, reason: "in-sync", local, remote };
            }
            if (localChanged && !remoteChanged) {
                return { kind: "upload", path, reason: "local-changed", local, remote };
            }
            if (!localChanged && remoteChanged) {
                return { kind: "download", path, reason: "remote-changed", local, remote };
            }

            return {
                ...this.resolveConflict(local, remote, settings),
                path,
                reason: "conflict",
            };
        }

        // ── 只有本地 ──
        if (local && !remote) {
            // 云端缺这一份（从没传过，或者云端那份被删了）→ 补上去。
            // 这里**不删本地**：那个方向的动作已经整个去掉了。
            return { kind: "upload", path, reason: "local-new", local };
        }

        // ── 只有云端 ──
        if (!local && remote) {
            // 本地删过、而用户选择保留云端副本 → 别再拿回来。
            // 少了这一条，用户删掉的图下一轮就自己回来了 —— 看起来像「删除没生效」。
            if (tracked?.remoteOnly) {
                return { kind: "skip", path, reason: "local-deleted", remote };
            }
            return { kind: "download", path, reason: "remote-new", remote };
        }

        return { kind: "skip", path, reason: "in-sync" };
    }

    private resolveConflict(
        local: LocalImage,
        remote: RemoteObject,
        settings: ImageSyncSettings
    ): { kind: "upload" | "download"; local: LocalImage; remote: RemoteObject } {
        if (settings.conflictPolicy === "local") {
            return { kind: "upload", local, remote };
        }
        if (settings.conflictPolicy === "remote") {
            return { kind: "download", local, remote };
        }

        // `newer`：比时间戳。两台设备的系统时钟不一致时这个判据会偏 ——
        // 所以它是**默认**而不是唯一选项，设置里另外两个是明确的「以哪边为准」。
        return local.mtime >= remote.lastModified
            ? { kind: "upload", local, remote }
            : { kind: "download", local, remote };
    }

    // ── 执行 ──────────────────────────────────────────────────────────────

    private async runInternal(options: { dryRun?: boolean }): Promise<SyncSummary> {
        const { actions, state, truncated } = await this.planInternal();
        return await this.executeActions(actions, state, truncated, options);
    }

    /**
     * 执行一批已经算好的动作。
     *
     * 从 `runInternal` 里拆出来，是为了让「同步全部」与「同步选中」
     * （`syncSelection`）共用同一段执行逻辑 —— 只传进来不同的 `actions`。
     * 两份执行代码会让「选中同步」悄悄少做某件事（比如刷新记录），
     * 而那类差异在界面上完全看不出来。
     */
    private async executeActions(
        actions: PlannedAction[],
        state: ImageSyncState,
        truncated: boolean,
        options: { dryRun?: boolean }
    ): Promise<SyncSummary> {
        const client = this.createClient();

        const summary: SyncSummary = {
            uploaded: 0,
            downloaded: 0,
            conflicts: actions.filter((action) => action.reason === "conflict").length,
            skipped: actions.filter((action) => action.kind === "skip").length,
            failed: 0,
            errors: [],
            truncated,
        };

        const alive = new Set<string>();
        for (const action of actions) alive.add(action.path);

        for (const action of actions) {
            if (action.kind === "skip") {
                // 一致的文件也要刷新记录：这样「状态清单里没有它」这个状态
                // 会被补上 —— `hasEntry`（决定要不要问用户「云端也删吗」）
                // 与冲突判定都靠它。
                this.refreshRecord(state, action.path, action.local, action.remote);
                continue;
            }

            if (options.dryRun) {
                this.countDryRun(summary, action);
                continue;
            }

            try {
                await this.execute(client, action, state, summary);
            } catch (error) {
                summary.failed += 1;
                summary.errors.push({
                    path: action.path,
                    message: this.deps.notifier.describeError(error),
                });
            }
        }

        if (!options.dryRun) {
            // 两边都不存在的记录剪掉，避免清单无限增长（见 pruneState 的说明）。
            pruneState(state, alive);
            saveState(this.deps.app, state);
            this.deps.onFinished?.(summary);
        }

        return summary;
    }

    private async execute(
        client: R2Client,
        action: PlannedAction,
        state: ImageSyncState,
        summary: SyncSummary
    ): Promise<void> {
        const app = this.deps.app;

        switch (action.kind) {
            case "upload": {
                const file = app.vault.getAbstractFileByPath(action.path);
                if (!(file instanceof TFile)) return;

                const body = await this.readLocal(action.path, file);
                const etag = await client.putObject(
                    client.keyFor(action.path),
                    body,
                    contentTypeFor(action.path)
                );
                // 上传后用**新的** stat 记录：上传过程中文件可能又被改过，
                // 记旧值会让下一轮白传一次（方向是安全的，但没必要）。
                recordSynced(
                    state,
                    action.path,
                    { size: file.stat.size, mtime: file.stat.mtime },
                    etag
                );
                summary.uploaded += 1;
                return;
            }

            case "download": {
                const body = await client.getObject(client.keyFor(action.path));
                await this.writeLocal(action.path, body);

                const written = app.vault.getAbstractFileByPath(action.path);
                const stat =
                    written instanceof TFile
                        ? { size: written.stat.size, mtime: written.stat.mtime }
                        : { size: body.byteLength, mtime: Date.now() };
                // 取回本地之后这一份**不再**是「仅云端」了 —— 墓碑要清掉。
                // 用户之前选过「保留云端副本」，现在文件又在本地出现（比如他
                // 从回收站恢复了，或者别处同步过来一份），旧墓碑留着会把它
                // 永远跳过，而界面看不出为什么。
                const entry = state.entries[action.path];
                if (entry) delete entry.remoteOnly;

                recordSynced(state, action.path, stat, action.remote?.etag ?? "");
                summary.downloaded += 1;
                return;
            }

            case "skip":
                return;
        }
    }

    /** 读本地文件。失败时换成领域错误 —— 原始的适配器异常对用户没有意义。 */
    private async readLocal(path: string, file: TFile): Promise<ArrayBuffer> {
        try {
            return await this.deps.app.vault.readBinary(file);
        } catch (error) {
            throw new ImageSyncError(
                "localReadFailed",
                { path, detail: error instanceof Error ? error.message : String(error) },
                { cause: error }
            );
        }
    }

    /**
     * 写本地文件：存在就覆盖，不存在就创建（含中间目录）。
     *
     * 中间目录要显式建：`createBinary` 不会替你造父目录，而「云端有、本地没有」
     * 的路径完全可能落在一个本地还不存在的文件夹里（比如新设备上刚同步过来的
     * `attachments/2026/`）—— 那时它会以一个看不懂的 ENOENT 失败。
     */
    private async writeLocal(path: string, body: ArrayBuffer): Promise<void> {
        const app = this.deps.app;
        try {
            const existing = app.vault.getAbstractFileByPath(path);
            if (existing instanceof TFile) {
                await app.vault.modifyBinary(existing, body);
                return;
            }

            const slash = path.lastIndexOf("/");
            if (slash > 0) {
                const folder = path.slice(0, slash);
                if (!app.vault.getAbstractFileByPath(folder)) {
                    await app.vault.createFolder(folder).catch(() => {
                        // 并发创建 / 已存在 —— 交给下面的 createBinary 报错。
                    });
                }
            }
            await app.vault.createBinary(path, body);
        } catch (error) {
            throw new ImageSyncError(
                "localWriteFailed",
                { path, detail: error instanceof Error ? error.message : String(error) },
                { cause: error }
            );
        }
    }

    /** 「两边一致」时也刷新记录 —— 见 runInternal 里的说明。 */
    private refreshRecord(
        state: ImageSyncState,
        path: string,
        local?: LocalImage,
        remote?: RemoteObject
    ): void {
        if (!local || !remote) return;
        const existing = state.entries[path];

        // 两边都在的文件**不可能**是「仅云端」—— 顺手清掉可能残留的墓碑：
        // 用户把文件从回收站恢复回来、或者别的设备同步过来一份时，
        // 旧墓碑留着不会造成错误（`decide` 在两边都在时根本不看它），
        // 但会让清单里的状态与事实不符，下一个读它的人要重新推一遍。
        if (existing?.remoteOnly) delete existing.remoteOnly;

        if (existing && existing.mtime === local.mtime && existing.etag === remote.etag) return;
        recordSynced(state, path, { size: local.size, mtime: local.mtime }, remote.etag);
    }

    private countDryRun(summary: SyncSummary, action: PlannedAction): void {
        switch (action.kind) {
            case "upload":
                summary.uploaded += 1;
                return;
            case "download":
                summary.downloaded += 1;
                return;
            case "skip":
                summary.skipped += 1;
                return;
        }
    }

    private createClient(): R2Client {
        const problem = this.configProblem();
        if (problem) throw problem;

        const settings = this.deps.getSettings().images;
        const secret = this.deps.secretStore.getSecretValue("r2") ?? "";

        return new R2Client(
            buildR2Config({
                accountId: settings.accountId,
                bucket: settings.bucket,
                accessKeyId: settings.accessKeyId,
                secretAccessKey: secret,
                prefix: settings.prefix,
            })
        );
    }
}

function sortedUnion(left: Iterable<string>, right: Iterable<string>): string[] {
    return [...new Set([...left, ...right])].sort();
}

/**
 * 从设置拼出 R2 配置。
 *
 * `accountId` 的三种写法由 `normalizeEndpoint` 负责（规则说明在那里）。
 * 这里只做两件事：**去空白**与**归一前缀**。
 *
 * `prefix` 归一成「无前后斜杠 + 结尾一个斜杠」：用户写 `images/` 还是 `/images`
 * 都该等价，而 `//images` 会造出 `//images/a.png` 这种键，云端看着像多了一层
 * 空目录；结尾不带斜杠则会让 `keyFor` 拼出 `synca.png` 那种粘连的键。
 *
 * `secretAccessKey` **不 trim** —— 它是从 SecretStore 读出来的原文，
 * 而桶名与 Access Key 是用户手输的、容易带空格。两者判据不同是有意的。
 */
export function buildR2Config(input: {
    accountId: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    prefix: string;
}): R2Config {
    const endpoint = normalizeEndpoint(input.accountId);
    return {
        endpoint: endpoint.url,
        host: endpoint.host,
        bucket: input.bucket.trim(),
        accessKeyId: input.accessKeyId.trim(),
        secretAccessKey: input.secretAccessKey,
        prefix: normalizePrefix(input.prefix),
    };
}

export function normalizePrefix(prefix: string): string {
    const trimmed = prefix.trim().replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/");
    return trimmed.length > 0 ? `${trimmed}/` : "";
}

/**
 * 归一端点。
 *
 * `accountId` 允许三种写法，都是为了少让用户去查文档：
 * - 纯账号 ID（`abc123`）→ 补成 `abc123.r2.cloudflarestorage.com`；
 * - 一个主机名（含 `.`）→ 直接当端点；
 * - 完整 URL → 用它。
 *
 * 「要不要补 R2 的后缀」的判据是**用户有没有给出地址的形状**：含 `.`、带
 * scheme、或者带端口（`:`）。三者任一成立就当成地址原样用 —— 判据只留
 * 「含 `.`」的话，`http://localhost:9000` 会被补成
 * `http://localhost:9000.r2.cloudflarestorage.com`，而用户明明写的是一个
 * 完整的地址。账号 ID 里不可能出现 `.`、`:` 或 scheme，所以放宽判据不会误伤。
 *
 * 不用 `new URL()`：它会把畸形输入规范化（补尾斜杠、重排），
 * 而我们后面要拿 host 去签名 —— 签名用的 host 必须与实际请求的一致，
 * 任何「顺手规范化」都可能让两者悄悄分家（表现为 403，且看不出原因）。
 * 手工剥掉 scheme 与路径即可，规则简单到可以逐条测试。
 */
export function normalizeEndpoint(accountId: string): { url: string; host: string } {
    const raw = accountId.trim().replace(/\/+$/g, "");

    let rest = raw;
    let scheme = "https://";
    let hadScheme = false;
    const schemeMatch = /^(https?):\/\//i.exec(raw);
    if (schemeMatch) {
        scheme = `${schemeMatch[1].toLowerCase()}://`;
        rest = raw.slice(schemeMatch[0].length);
        hadScheme = true;
    }

    // 去掉路径部分（用户可能粘了带 `/bucket` 的地址）。
    const slash = rest.indexOf("/");
    const host = slash < 0 ? rest : rest.slice(0, slash);

    const looksLikeAddress = host.includes(".") || host.includes(":") || hadScheme;
    const resolvedHost = looksLikeAddress ? host : `${host}.r2.cloudflarestorage.com`;
    return { url: `${scheme}${resolvedHost}`, host: resolvedHost };
}
