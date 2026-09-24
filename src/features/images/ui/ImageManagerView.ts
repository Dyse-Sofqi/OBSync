import { ItemView, TFile, type App } from "obsidian";
import type { WorkspaceLeaf } from "obsidian";
import type { LocaleStrings } from "../../../core/i18n";
import type { Notifier } from "../../../core/notice";
import { formatBytes } from "../../sync/repoSize";
import { countRenameable, type RenamePlanEntry } from "../batchRename";
import { isEditableImage } from "../imageScan";
import {
    applyImageFilter,
    EMPTY_IMAGE_FILTER,
    isFilterActive,
    imageSizeOf,
    loadImageLibrary,
    sortImageRecords,
    type ImageFilter,
    type ImageLibrary,
    type ImageRecord,
    type ImageSort,
    type StateFilter,
} from "../imageLibrary";
import type { ImageSyncService } from "../imageSyncService";
import type { DeleteImagesResult } from "../types";
import { BatchRenameModal } from "./BatchRenameModal";
import { compressImageBuffer } from "./batchCompress";
import { ConfirmBatchDeleteModal } from "./ConfirmBatchDeleteModal";

/**
 * 图片管理面板（主工作区标签页）。
 *
 * ## 它回答的问题
 *
 * 「我库里这些图，哪些在本地、哪些在云端、哪些根本没人用了？」——
 * 这三件事分别由三个模块回答（`scanLocalImages` / `listRemoteImages` /
 * `collectImageReferences`），而它们的**交集**才是用户要处理的东西：
 * 「本地有、云端没有」要上传，「本地没有、云端有」要么拉回来要么删掉，
 * 「本地有、没人引用」是失联图片。
 *
 * 所以这里不做「分类」，只把三条轴摊平成一个可筛选的列表 —— 见
 * `imageLibrary.ts` 里关于「三个状态是三条轴、不是三个桶」的说明。
 *
 * ## 为什么是主工作区标签页（2026-09-23 从弹窗改来）
 *
 * 原来是 `Modal`。改成标签页的理由很直接：整理图片时用户要**一边看着笔记
 * 一边决定哪张能删**，而弹窗把整个库盖住，只能二选一。标签页可以并排在
 * 笔记旁边，关掉了也不会丢状态之外的任何东西。
 *
 * 注册用的是 `IMAGE_VIEW_TYPE` —— 它一旦发布就不能改：视图类型持久化在
 * 用户的 `workspace.json` 里，改了会让已经打开的标签页失效。
 *
 * 打开路径（命令面板 / 侧栏图标 / 设置页按钮）都走 `openImageManager()`：
 * 已经开着就把它显示出来，而不是再开一个 —— 两个标签页扫的是同一批图，
 * 而每扫一遍要好几秒。
 *
 * ## 性能上的两个上限
 *
 * 1. 列表最多渲染 `MAX_ROWS` 行。几千张图全渲染会让打开动作卡住好几秒，
 *    而用户看到的只是「滚动条很长」。超出时明确说明并让他用筛选缩小范围。
 * 2. 缩略图带 `loading="lazy"` —— 不这样的话浏览器会立刻解码几百张图。
 */

/** 视图类型。**发布后不可改** —— 用户的 `workspace.json` 里存着它。 */
export const IMAGE_VIEW_TYPE = "obsync-image-view";

/** 一次最多渲染多少行。见文件头的说明。 */
const MAX_ROWS = 300;

/** 大图的默认阈值（KB）。用户点「大图」快捷筛选时用它。 */
const DEFAULT_MIN_SIZE_KB = 500;

export interface ImageManagerViewDeps {
    app: App;
    getT(): LocaleStrings;
    notifier: Notifier;
    service: ImageSyncService;
    /** 批量删除 —— 走模块（它会抑制重复询问），见 `ImageSyncModule.deleteImages`。 */
    deleteImages(paths: string[], options: { remote: boolean }): Promise<DeleteImagesResult>;
}

export class ImageManagerView extends ItemView {
    private library: ImageLibrary | undefined;
    private filter: ImageFilter = { ...EMPTY_IMAGE_FILTER };
    private sort: ImageSort = "path";
    private readonly selected = new Set<string>();
    private busy = false;

    private statsEl!: HTMLElement;
    private noteEl!: HTMLElement;
    private filtersEl!: HTMLElement;
    private listEl!: HTMLElement;
    private selectEl!: HTMLElement;
    private actionEl!: HTMLElement;
    private actionButtons: HTMLButtonElement[] = [];

    constructor(
        leaf: WorkspaceLeaf,
        private readonly deps: ImageManagerViewDeps
    ) {
        super(leaf);
    }

    getViewType(): string {
        return IMAGE_VIEW_TYPE;
    }

    /** 标签页标题。`getT` 而不是快照：标签页常驻，切换语言后要跟着变。 */
    getDisplayText(): string {
        return this.deps.getT().images.manager.title;
    }

    getIcon(): string {
        return "images";
    }

    async onOpen(): Promise<void> {
        this.contentEl.addClass("obsync-image-manager");

        this.statsEl = this.contentEl.createDiv({ cls: "obsync-image-stats" });
        this.noteEl = this.contentEl.createDiv({ cls: "obsync-image-note" });
        this.filtersEl = this.contentEl.createDiv({ cls: "obsync-image-filters" });
        this.selectEl = this.contentEl.createDiv({ cls: "obsync-image-selectbar" });
        this.listEl = this.contentEl.createDiv({ cls: "obsync-image-table-wrap" });

        this.renderFilters();
        this.renderActions();

        this.renderList();
        void this.reload();
    }

    async onClose(): Promise<void> {
        this.contentEl.empty();
    }

    private get t(): LocaleStrings {
        return this.deps.getT();
    }

    // ── 数据 ──────────────────────────────────────────────────────────────

    /** 重新扫一遍三方状态。删除 / 重命名 / 同步之后都要走它。 */
    private async reload(): Promise<void> {
        if (this.busy) return;
        this.busy = true;
        const t = this.t.images.manager;

        // 扫描是秒级的（要读遍库里所有文本载体），必须给个「在跑」的信号 ——
        // 否则打开后先是空白，用户会以为坏了。
        const progress = this.deps.notifier.progress(t.scanning);
        try {
            this.library = await loadImageLibrary(this.deps.app, this.deps.service, {
                onProgress: (done, total) => progress.update(t.scanningOf(done, total)),
            });
        } catch (error) {
            progress.done();
            this.busy = false;
            this.deps.notifier.reportError(error, t.scanFailed);
            return;
        }
        progress.done();
        this.busy = false;

        // 选中的路径可能已经不存在了（上一次操作删掉了它）—— 清掉，否则
        // 按钮上的计数会包含幽灵条目。
        const alive = new Set(this.library.records.map((record) => record.path));
        for (const path of [...this.selected]) {
            if (!alive.has(path)) this.selected.delete(path);
        }

        this.renderStats();
        this.renderList();
    }

    private visibleRecords(): ImageRecord[] {
        if (!this.library) return [];
        return sortImageRecords(
            applyImageFilter(this.library.records, this.filter),
            this.sort
        );
    }

    // ── 渲染 ──────────────────────────────────────────────────────────────

    private renderStats(): void {
        const t = this.t.images.manager;
        const library = this.library;
        this.statsEl.empty();
        if (!library) return;

        const { counts } = library;
        const entries: Array<[string, string]> = [
            [t.statLocal, String(counts.local)],
            [t.statRemote, String(counts.remote)],
            [t.statLinked, String(counts.linked)],
            [t.statOrphan, String(counts.orphans)],
            [t.statTotal, String(counts.total)],
            [t.statLocalBytes, formatBytes(counts.localBytes)],
        ];
        for (const [label, value] of entries) {
            const item = this.statsEl.createDiv({ cls: "obsync-image-stat" });
            item.createDiv({ cls: "obsync-image-stat-value", text: value });
            item.createDiv({ cls: "obsync-image-stat-label", text: label });
        }

        this.renderNotes();
    }

    /**
     * 顶部那几行「有件事你必须知道」。
     *
     * 三件事都必须说出来，而且都必须是**可见的文字**而不是颜色或图标：
     * 云端列举失败（否则「云端一张都没有」会被当真）、列举被截断、
     * 引用扫描没跑成（否则整库的图都会被当成失联）。
     */
    private renderNotes(): void {
        const t = this.t.images.manager;
        const library = this.library;
        this.noteEl.empty();
        if (!library) return;

        if (library.remoteError) {
            this.noteEl.createDiv({
                cls: "obsync-image-note-warn",
                text: t.remoteFailed(this.deps.notifier.describeError(library.remoteError)),
            });
        } else if (!this.deps.service.isConfigured()) {
            this.noteEl.createDiv({ cls: "obsync-image-note-warn", text: t.notConfigured });
        } else if (library.truncated) {
            this.noteEl.createDiv({ cls: "obsync-image-note-warn", text: t.truncated });
        }
    }

    private renderFilters(): void {
        const t = this.t.images.manager;
        this.filtersEl.empty();
        const container = this.filtersEl;

        const stateSelect = (
            label: string,
            current: StateFilter,
            onChange: (value: StateFilter) => void
        ): void => {
            const wrapper = container.createDiv({ cls: "obsync-image-filter" });
            wrapper.createSpan({ text: label });
            const select = wrapper.createEl("select");
            for (const value of ["any", "yes", "no"] as const) {
                select.createEl("option", { value, text: t.filterState[value] });
            }
            select.value = current;
            select.addEventListener("change", () => {
                onChange(select.value as StateFilter);
                this.refresh();
            });
        };

        stateSelect(t.filterLocal, this.filter.local, (value) => {
            this.filter.local = value;
        });
        stateSelect(t.filterRemote, this.filter.remote, (value) => {
            this.filter.remote = value;
        });
        stateSelect(t.filterLinked, this.filter.linked, (value) => {
            this.filter.linked = value;
        });

        const sizeWrapper = container.createDiv({ cls: "obsync-image-filter" });
        sizeWrapper.createSpan({ text: t.minSize });
        const sizeInput = sizeWrapper.createEl("input", { type: "number" });
        sizeInput.min = "0";
        sizeInput.value = String(this.filter.minSizeKB);
        sizeInput.addEventListener("change", () => {
            const parsed = Number.parseInt(sizeInput.value, 10);
            this.filter.minSizeKB = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
            this.refresh();
        });
        sizeWrapper.createSpan({ text: t.minSizeUnit });

        const sortWrapper = container.createDiv({ cls: "obsync-image-filter" });
        sortWrapper.createSpan({ text: t.sort });
        const sortSelect = sortWrapper.createEl("select");
        for (const value of ["path", "size-desc", "size-asc"] as const) {
            sortSelect.createEl("option", { value, text: t.sortOption[value] });
        }
        sortSelect.value = this.sort;
        sortSelect.addEventListener("change", () => {
            this.sort = sortSelect.value as ImageSort;
            this.refresh();
        });

        const searchWrapper = container.createDiv({ cls: "obsync-image-filter" });
        searchWrapper.createSpan({ text: t.search });
        const searchInput = searchWrapper.createEl("input", { type: "search" });
        searchInput.placeholder = t.searchPlaceholder;
        searchInput.value = this.filter.search;
        searchInput.addEventListener("input", () => {
            this.filter.search = searchInput.value;
            // 搜索时**不重建**筛选区，否则输入框会失去焦点 —— `refresh()`
            // 只重画计数、列表与按钮。
            this.refresh();
        });

        // 快捷筛选：把最常用的几个组合做成一键。它们只是替用户改上面那几个
        // 下拉的值，然后重画整个筛选区（让下拉的显示跟着变）。
        const presets = container.createDiv({ cls: "obsync-image-presets" });
        const preset = (label: string, apply: () => void): void => {
            const button = presets.createEl("button", { text: label });
            button.addEventListener("click", () => {
                apply();
                this.renderFilters();
                this.refresh();
            });
        };
        preset(t.presetOrphans, () => {
            this.filter = { ...EMPTY_IMAGE_FILTER, local: "yes", linked: "no" };
        });
        preset(t.presetPendingUpload, () => {
            this.filter = { ...EMPTY_IMAGE_FILTER, local: "yes", remote: "no" };
        });
        preset(t.presetRemoteOnly, () => {
            this.filter = { ...EMPTY_IMAGE_FILTER, local: "no", remote: "yes" };
        });
        preset(t.presetLarge, () => {
            this.filter = { ...EMPTY_IMAGE_FILTER, minSizeKB: DEFAULT_MIN_SIZE_KB };
        });
        preset(t.presetReset, () => {
            this.filter = { ...EMPTY_IMAGE_FILTER };
        });
    }

    private renderList(): void {
        const t = this.t.images.manager;
        const records = this.visibleRecords();

        this.listEl.empty();

        if (!this.library) {
            this.listEl.createDiv({ cls: "obsync-image-empty", text: t.loading });
            return;
        }
        if (records.length === 0) {
            this.listEl.createDiv({
                cls: "obsync-image-empty",
                text: isFilterActive(this.filter) ? t.emptyFiltered : t.empty,
            });
            this.renderSelectionBar(records);
            return;
        }

        const table = this.listEl.createEl("table", { cls: "obsync-image-table" });
        const head = table.createEl("thead").createEl("tr");
        head.createEl("th", { cls: "obsync-image-cell-check" });
        head.createEl("th", { cls: "obsync-image-cell-thumb" });
        head.createEl("th", { text: t.columnPath });
        head.createEl("th", { text: t.columnSize });
        head.createEl("th", { text: t.columnState });

        const body = table.createEl("tbody");
        for (const record of records.slice(0, MAX_ROWS)) {
            this.renderRow(body, record);
        }

        if (records.length > MAX_ROWS) {
            this.listEl.createDiv({
                cls: "obsync-image-note-warn",
                text: t.capped(records.length - MAX_ROWS),
            });
        }

        this.renderSelectionBar(records);
    }

    private renderRow(body: HTMLElement, record: ImageRecord): void {
        const t = this.t.images.manager;
        const row = body.createEl("tr", { cls: "obsync-image-row" });
        row.toggleClass("obsync-image-row-selected", this.selected.has(record.path));

        const checkCell = row.createEl("td", { cls: "obsync-image-cell-check" });
        const checkbox = checkCell.createEl("input", { type: "checkbox" });
        checkbox.checked = this.selected.has(record.path);

        const thumbCell = row.createEl("td", { cls: "obsync-image-cell-thumb" });
        const file = this.deps.app.vault.getAbstractFileByPath(record.path);
        if (file instanceof TFile) {
            const image = thumbCell.createEl("img", { cls: "obsync-image-thumb" });
            image.setAttribute("src", this.deps.app.vault.getResourcePath(file));
            image.setAttribute("alt", "");
            // 尺寸必须写成 **HTML 属性**，不能只靠 CSS —— Obsidian 的 app.css 里有
            // 一条 `.workspace-leaf-content img:not([width]) { max-width: 100% }`。
            // 弹窗不在 leaf 里，从来不中招；标签页在。表格是自动布局，路径那一列
            // 带着 `max-width: 0`（要靠省略号收尾），窄标签页里单元格会被挤到接近
            // 0 宽，这条 max-width 让缩略图跟着缩到 0 —— 整列消失。
            // 有 width 属性就不匹配那条选择器；实际尺寸仍由 `.obsync-image-thumb`
            // 的 em 值决定（author CSS 优先于呈现属性），属性值只是兜底。
            image.setAttribute("width", "30");
            image.setAttribute("height", "30");
            // 不 lazy 的话，几百张图会在打开的瞬间一起解码。
            image.setAttribute("loading", "lazy");
        }

        row.createEl("td", { cls: "obsync-image-path", text: record.path });
        row.createEl("td", { cls: "obsync-image-size", text: formatBytes(imageSizeOf(record)) });

        const badges = row.createEl("td", { cls: "obsync-image-badges" });
        if (record.local) badges.createSpan({ cls: "obsync-image-badge obsync-image-badge-local", text: t.badgeLocal });
        if (record.remote) badges.createSpan({ cls: "obsync-image-badge obsync-image-badge-remote", text: t.badgeRemote });
        if (record.refs.length > 0) {
            const badge = badges.createSpan({
                cls: "obsync-image-badge obsync-image-badge-linked",
                text: t.badgeLinked(record.refs.length),
            });
            // 悬停能看到是谁在引用 —— 判断「这张图能不能删」时这是决定性信息，
            // 而列表里放不下它。
            badge.title = record.refs.join("\n");
        } else {
            badges.createSpan({ cls: "obsync-image-badge obsync-image-badge-orphan", text: t.badgeOrphan });
        }

        const toggle = (): void => {
            if (this.selected.has(record.path)) this.selected.delete(record.path);
            else this.selected.add(record.path);
            checkbox.checked = this.selected.has(record.path);
            row.toggleClass("obsync-image-row-selected", checkbox.checked);
            this.refresh();
        };
        checkbox.addEventListener("change", toggle);
        // 点行任意处也能勾选（勾选框自己不重复触发）。
        row.addEventListener("click", (event) => {
            if ((event.target as HTMLElement).closest("input")) return;
            toggle();
        });
    }

    private renderSelectionBar(records: ImageRecord[]): void {
        const t = this.t.images.manager;
        this.selectEl.empty();

        const allSelected = records.length > 0 && records.every((record) => this.selected.has(record.path));

        const selectAll = this.selectEl.createEl("button", {
            text: allSelected ? t.clearSelection : t.selectAll,
        });
        selectAll.addEventListener("click", () => {
            if (allSelected) {
                for (const record of records) this.selected.delete(record.path);
            } else {
                for (const record of records) this.selected.add(record.path);
            }
            this.refresh();
        });

        this.selectEl.createSpan({ cls: "obsync-image-count", text: t.selectedCount(this.selected.size) });
        this.selectEl.createSpan({
            cls: "obsync-image-count",
            text: t.shown(records.length, this.library?.records.length ?? 0),
        });
    }

    private renderActions(): void {
        const t = this.t.images.manager;
        this.actionEl = this.contentEl.createDiv({ cls: "obsync-image-actions" });
        this.actionButtons = [];

        const add = (
            label: string,
            cls: string | undefined,
            run: () => void | Promise<void>
        ): void => {
            const button = this.actionEl.createEl("button", { text: label });
            if (cls) button.addClass(cls);
            button.addEventListener("click", () => void run());
            this.actionButtons.push(button);
        };

        add(t.actionSync, undefined, () => this.runSync());
        add(t.actionCompress, undefined, () => this.runCompress());
        add(t.actionRename, undefined, () => this.openRename());
        add(t.actionDeleteLocal, undefined, () => this.confirmDelete(false));
        add(t.actionDeleteBoth, "mod-warning", () => this.confirmDelete(true));

        this.actionEl.createDiv({ cls: "obsync-image-hint", text: t.compressHint(this.compressHintText()) });

        // 按钮的可用性完全由「选中了几个」决定 —— 在 `refresh()` 里统一算。
        this.refresh();
    }

    private compressHintText(): string {
        const settings = this.deps.service.getImageSettings();
        const maxEdge = settings.compressMaxEdge > 0 ? String(settings.compressMaxEdge) : "—";
        return `${settings.compressQuality} / ${maxEdge}`;
    }

    /** 选中集或筛选变了之后，只重画会变的那几块。 */
    private refresh(): void {
        const count = this.selected.size;
        // 一个都没选时所有批量动作都不可点 —— 让用户点了才收到「先选」的提示
        // 是把可用性交给运气；直接灰掉才是「现在还不能用」的准确表达。
        for (const button of this.actionButtons) button.disabled = count === 0;
        this.renderList();
    }

    private guardSelection(): string[] | undefined {
        if (this.selected.size === 0) {
            this.deps.notifier.warn(this.t.images.manager.noSelection);
            return undefined;
        }
        return [...this.selected];
    }

    // ── 动作 ──────────────────────────────────────────────────────────────

    private async runSync(): Promise<void> {
        const paths = this.guardSelection();
        if (!paths || this.busy) return;

        const t = this.t.images.manager;
        const problem = this.deps.service.configProblem();
        if (problem) {
            this.deps.notifier.error(this.deps.notifier.describeError(problem, t.notConfigured));
            return;
        }

        this.busy = true;
        const progress = this.deps.notifier.progress(t.syncing);
        try {
            const summary = await this.deps.service.syncSelection(paths);
            this.deps.notifier.success(
                t.syncDone(summary.uploaded, summary.downloaded, summary.failed)
            );
            if (summary.failed > 0) {
                // 逐条原因进日志已经由服务做了；这里给用户一个能行动的总数。
                this.deps.notifier.warn(t.syncFailedMany(summary.failed));
            }
        } catch (error) {
            this.deps.notifier.reportError(error, t.syncFailed);
        } finally {
            progress.done();
            this.busy = false;
        }
        await this.reload();
    }

    private async runCompress(): Promise<void> {
        const paths = this.guardSelection();
        if (!paths || this.busy) return;

        const t = this.t.images.manager;
        const settings = this.deps.service.getImageSettings();
        this.busy = true;
        const progress = this.deps.notifier.progress(t.compressing);

        let compressed = 0;
        let savedBytes = 0;
        let skipped = 0;
        const errors: Array<{ path: string; message: string }> = [];

        try {
            for (let index = 0; index < paths.length; index++) {
                const path = paths[index]!;
                progress.update(t.compressingOf(index + 1, paths.length));

                const file = this.deps.app.vault.getAbstractFileByPath(path);
                // 云端独有 / 不支持重编码（svg、gif）的一律跳过并计数 ——
                // 静默跳过会让用户以为「压过了」。
                if (!(file instanceof TFile) || !isEditableImage(path)) {
                    skipped += 1;
                    continue;
                }

                try {
                    const buffer = await this.deps.app.vault.readBinary(file);
                    const outcome = await compressImageBuffer(buffer, path, {
                        quality: settings.compressQuality,
                        maxEdge: settings.compressMaxEdge,
                    });

                    // **只在更小时才写回去**：重编码后更大的情况真实存在
                    // （已经压过的 jpeg 再压一次、或质量设得比原图还高），
                    // 写回去是纯粹的损失。
                    if (outcome.after >= outcome.before) {
                        skipped += 1;
                        continue;
                    }

                    await this.deps.app.vault.modifyBinary(file, outcome.buffer);
                    compressed += 1;
                    savedBytes += outcome.before - outcome.after;

                    // 顺手把新的一份推到云端（失败不打断：下一轮完整同步会补上）。
                    await this.deps.service.syncPath(path);
                } catch (error) {
                    errors.push({ path, message: this.deps.notifier.describeError(error) });
                }
            }
        } finally {
            progress.done();
            this.busy = false;
        }

        if (compressed === 0) {
            this.deps.notifier.info(t.compressNothing(skipped));
        } else {
            this.deps.notifier.success(t.compressDone(compressed, formatBytes(savedBytes), skipped));
        }
        if (errors.length > 0) {
            this.deps.notifier.warn(t.compressFailed(errors.length, errors[0]!.path));
        }
        await this.reload();
    }

    private openRename(): void {
        const paths = this.guardSelection();
        if (!paths) return;

        new BatchRenameModal(this.deps.app, this.t, paths, {
            exists: (path) => this.deps.app.vault.getAbstractFileByPath(path) !== null,
            onConfirm: (entries) => this.runRename(entries),
        }).open();
    }

    private async runRename(entries: RenamePlanEntry[]): Promise<void> {
        if (this.busy || entries.length === 0) return;
        const t = this.t.images.manager;

        this.busy = true;
        const progress = this.deps.notifier.progress(t.renaming);
        let renamed = 0;
        const errors: Array<{ path: string; message: string }> = [];

        try {
            for (const entry of entries) {
                const file = this.deps.app.vault.getAbstractFileByPath(entry.from);
                if (!(file instanceof TFile)) {
                    errors.push({ path: entry.from, message: t.renameMissing });
                    continue;
                }
                try {
                    // 必须走 `FileManager.renameFile`：它会**顺带更新库里所有指向
                    // 这个文件的链接**。用 adapter 直接改名会让笔记里的链接全断，
                    // 而那种破坏在界面上完全看不出来。
                    await this.deps.app.fileManager.renameFile(file, entry.to);
                    renamed += 1;

                    // 云端那一份跟着搬（旧键删掉、新键上传）。
                    await this.deps.service.renameRemoteBackup(entry.from, entry.to);
                } catch (error) {
                    errors.push({ path: entry.from, message: this.deps.notifier.describeError(error) });
                }
            }
        } finally {
            progress.done();
            this.busy = false;
        }

        this.deps.notifier.success(t.renameDone(renamed, countRenameable(entries)));
        if (errors.length > 0) {
            this.deps.notifier.warn(t.renameFailedMany(errors.length, errors[0]!.path));
        }
        this.selected.clear();
        await this.reload();
    }

    private confirmDelete(remote: boolean): void {
        const paths = this.guardSelection();
        if (!paths) return;

        new ConfirmBatchDeleteModal({
            app: this.deps.app,
            getT: () => this.t,
            count: paths.length,
            remote,
            onConfirm: () => this.runDelete(paths, remote),
        }).open();
    }

    private async runDelete(paths: string[], remote: boolean): Promise<void> {
        if (this.busy) return;
        const t = this.t.images.manager;

        this.busy = true;
        const progress = this.deps.notifier.progress(t.deleting);
        let result: DeleteImagesResult | undefined;
        try {
            result = await this.deps.deleteImages(paths, { remote });
        } catch (error) {
            this.deps.notifier.reportError(error, t.deleteFailed);
        } finally {
            progress.done();
            this.busy = false;
        }

        if (result) {
            this.deps.notifier.success(
                t.deleteDone(result.localDeleted, result.remoteDeleted, result.errors.length)
            );
            if (result.errors.length > 0) {
                // 逐条原因在服务里报过了，这里给一句总数与第一条 —— 用户据此
                // 知道是「全都失败」还是「个别失败」。
                this.deps.notifier.warn(
                    t.deleteFailedMany(result.errors.length, result.errors[0]!.path)
                );
            }
        }

        this.selected.clear();
        await this.reload();
    }
}
