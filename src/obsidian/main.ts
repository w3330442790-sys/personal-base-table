// Weilanx Base Table · Obsidian 插件入口
import { App, FuzzySuggestModal, Plugin, PluginSettingTab, Setting, TAbstractFile, TFile, TFolder, Notice, normalizePath, moment } from "obsidian";
import { VIEW_TYPE, WbaseView, isWbase } from "./view";
import type { UIConfig } from "../../webview/src/config";
import { parseDoc, serializeDoc, starterDoc } from "../core/doc";
import { renameLinks } from "../core/links";

interface Settings {
  historyLimit: number;
  snapshotCount: number;
  snapshotMegabytes: number;
  rowHeight: UIConfig["rowHeight"];
  showRowNumbers: boolean;
  fontSize: number;
  colorfulTags: boolean;
  wrapText: boolean;
  /** 笔记改名时同步更新表格里的 [[链接]] */
  syncLinksOnRename: boolean;
  /** 首次写入前把原始文件备份到库内隐藏目录 */
  autoBackup: boolean;
}

const DEFAULTS: Settings = {
  historyLimit: 100,
  snapshotCount: 30,
  snapshotMegabytes: 100,
  rowHeight: "medium",
  showRowNumbers: true,
  fontSize: 0,
  colorfulTags: true,
  wrapText: false,
  syncLinksOnRename: true,
  autoBackup: true,
};

/** 命令名跟随 Obsidian 界面语言 */
const zh = () => moment.locale().toLowerCase().startsWith("zh");
const t = (cn: string, en: string) => (zh() ? cn : en);

export default class WeilanxBaseTablePlugin extends Plugin {
  settings: Settings = { ...DEFAULTS };

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerView(VIEW_TYPE, (leaf) => new WbaseView(leaf, this));
    this.registerExtensions(["wbase"], VIEW_TYPE);

    this.addRibbonIcon("table", t("新建多维表格", "New base table"), () => this.createTable());
    this.addCommand({ id: "create-table", name: t("新建多维表格", "Create new base table"), callback: () => this.createTable() });
    this.addCommand({ id: "quick-add-record", name: t("快速新增记录", "Quick add record"), callback: () => this.quickAddRecord() });

    // 作用于当前表格视图的命令:没有打开表格时在命令面板里不显示
    const viewCommand = (id: string, cn: string, en: string, c: "undo" | "redo" | "addRow" | "export") =>
      this.addCommand({
        id,
        name: t(cn, en),
        checkCallback: (checking) => {
          const view = this.app.workspace.getActiveViewOfType(WbaseView);
          if (!view) return false;
          if (!checking) view.command(c);
          return true;
        },
      });
    viewCommand("undo", "撤销", "Undo", "undo");
    viewCommand("redo", "重做", "Redo", "redo");
    viewCommand("add-record", "新增记录", "Add record", "addRow");
    viewCommand("export", "导出表格", "Export table", "export");

    // 文件列表右键文件夹:在这里新建
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFolder)) return;
        menu.addItem((item) =>
          item
            .setTitle(t("新建多维表格", "New base table"))
            .setIcon("table")
            .onClick(() => this.createTable(file))
        );
      })
    );

    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.onRename(file, oldPath)));
    this.addSettingTab(new SettingsTab(this.app, this));
    this.warnIfUpstreamEnabled();
  }

  /** 原版插件保存同一个 .wbase 时可能忽略 personal/personalGrid。 */
  private warnIfUpstreamEnabled(): void {
    try {
      const plugins = (this.app as unknown as { plugins?: { enabledPlugins?: Set<string> } }).plugins;
      if (plugins?.enabledPlugins?.has?.("weilanx-base-table")) {
        new Notice(t("检测到原版 Weilanx Base Table 已启用。请只保留个人版编辑扩展表格，避免扩展数据被原版覆盖。", "The upstream Weilanx Base Table is enabled. Keep only the personal edition enabled for extended tables to avoid dropping extension data."), 12000);
      }
    } catch {
      // app.plugins is internal API; a warning must never block plugin load.
    }
  }

  uiConfig(): UIConfig {
    const { rowHeight, showRowNumbers, fontSize, colorfulTags, wrapText } = this.settings;
    return { rowHeight, showRowNumbers, fontSize, colorfulTags, wrapText, historyLimit: this.settings.historyLimit };
  }

  async loadSettings(): Promise<void> {
    this.settings = { ...DEFAULTS, ...((await this.loadData()) as Partial<Settings> | null) };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    // 设置改动即时生效
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) (leaf.view as WbaseView).push();
  }

  /** 当前表格直接新增；没有表格打开时，选择库内一个 .wbase 后新增。 */
  private quickAddRecord(): void {
    const active = this.app.workspace.getActiveViewOfType(WbaseView);
    if (active) { active.command("addRow"); return; }
    const files = this.app.vault.getFiles().filter(isWbase).sort((a, b) => a.path.localeCompare(b.path));
    if (!files.length) { new Notice(t("库里还没有 .wbase 表格", "No .wbase tables in this vault")); return; }
    new TablePickerModal(this.app, files, async (file) => {
      const leaf = this.app.workspace.getLeaf(true);
      await leaf.openFile(file);
      if (!(leaf.view instanceof WbaseView)) { new Notice(t("无法打开这个表格", "Could not open this table")); return; }
      window.setTimeout(() => leaf.view instanceof WbaseView && leaf.view.command("addRow"), 0);
    });
  }

  /** 在指定目录(默认:当前文件所在目录)新建一张表并打开 */
  async createTable(folder?: TFolder): Promise<void> {
    const dir = folder?.path ?? this.app.workspace.getActiveFile()?.parent?.path ?? "";
    const base = t("新建表格", "Untitled table");
    let path = normalizePath(`${dir}/${base}.wbase`);
    for (let n = 2; this.app.vault.getAbstractFileByPath(path); n++) path = normalizePath(`${dir}/${base} ${n}.wbase`);
    const file = await this.app.vault.create(path, serializeDoc(starterDoc()));
    await this.app.workspace.getLeaf(true).openFile(file);
  }

  /** 笔记改名:把所有表格里的 [[旧名]] 换成新名。打开着的表格直接改内存,避免和未保存的编辑冲突 */
  private async onRename(file: TAbstractFile, oldPath: string): Promise<void> {
    if (!this.settings.syncLinksOnRename || !(file instanceof TFile) || file.extension !== "md") return;
    const oldName = oldPath.split("/").pop()!.replace(/\.md$/, "");
    const newName = file.basename;
    if (oldName === newName && oldPath === file.path) return;
    // Bare [[Note]] links are ambiguous when another note shares the basename.
    // Full-path links can still be updated safely in that case.
    const duplicateBasename = this.app.vault.getMarkdownFiles().some((candidate) => candidate.path !== file.path && candidate.basename === oldName);
    const replaceBare = oldName !== newName && !duplicateBasename;

    const open = new Map<string, WbaseView>();
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      const view = leaf.view as WbaseView;
      if (view.file) open.set(view.file.path, view);
    }
    let total = 0;
    for (const f of this.app.vault.getFiles()) {
      if (!isWbase(f)) continue;
      const view = open.get(f.path);
      if (view) {
        let n = 0;
        view.applyExternal((doc) => (n = renameLinks(doc, oldName, newName, { oldPath, newPath: file.path, replaceBare })));
        total += n;
        continue;
      }
      await this.app.vault.process(f, (text) => {
        let doc;
        try {
          doc = parseDoc(text, true);
        } catch {
          return text; // 坏文件不动
        }
        const n = renameLinks(doc, oldName, newName, { oldPath, newPath: file.path, replaceBare });
        total += n;
        return n ? serializeDoc(doc) : text;
      });
    }
    if (total) new Notice(t(`已更新 ${total} 处表格链接:[[${oldName}]] → [[${newName}]]`, `Updated ${total} table link(s) to [[${newName}]]`));
  }
}

class TablePickerModal extends FuzzySuggestModal<TFile> {
  constructor(
    app: App,
    private readonly files: TFile[],
    private readonly choose: (file: TFile) => void
  ) {
    super(app);
    this.setPlaceholder(t("选择要新增记录的表格", "Choose a table for the new record"));
  }
  getItems(): TFile[] { return this.files; }
  getItemText(file: TFile): string { return file.path; }
  onChooseItem(file: TFile): void { this.choose(file); }
}

class SettingsTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: WeilanxBaseTablePlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;
    const save = () => this.plugin.saveSettings();
    for (const option of [
      { key: "historyLimit" as const, name: "撤销历史步数", max: 1000 },
      { key: "snapshotCount" as const, name: "每文件保留快照数量", max: 1000 },
      { key: "snapshotMegabytes" as const, name: "每文件快照容量上限（MB）", max: 10000 },
    ]) new Setting(containerEl).setName(option.name).addText(input => input.setValue(String(s[option.key])).onChange(value => {
      const number = Number(value);
      if (Number.isSafeInteger(number) && number >= 1 && number <= option.max) { s[option.key] = number; void save(); }
    }));

    new Setting(containerEl)
      .setName(t("默认行高", "Default row height"))
      .addDropdown((d) =>
        d
          .addOptions({ compact: t("紧凑", "Compact"), medium: t("中等", "Medium"), tall: t("宽松", "Tall") })
          .setValue(s.rowHeight)
          .onChange((v) => {
            s.rowHeight = v as Settings["rowHeight"];
            void save();
          })
      );
    new Setting(containerEl).setName(t("显示行号列", "Show row numbers")).addToggle((tg) =>
      tg.setValue(s.showRowNumbers).onChange((v) => {
        s.showRowNumbers = v;
        void save();
      })
    );
    new Setting(containerEl)
      .setName(t("单元格字号", "Cell font size"))
      .setDesc(t("单位 px,0 表示跟随 Obsidian 界面字号", "In px. 0 follows the Obsidian UI font size"))
      .addText((tx) =>
        tx.setValue(String(s.fontSize)).onChange((v) => {
          const n = Number(v);
          if (Number.isFinite(n) && n >= 0) {
            s.fontSize = n;
            void save();
          }
        })
      );
    new Setting(containerEl).setName(t("彩色选项标签", "Colorful option tags")).addToggle((tg) =>
      tg.setValue(s.colorfulTags).onChange((v) => {
        s.colorfulTags = v;
        void save();
      })
    );
    new Setting(containerEl).setName(t("单元格文字换行", "Wrap text in cells")).addToggle((tg) =>
      tg.setValue(s.wrapText).onChange((v) => {
        s.wrapText = v;
        void save();
      })
    );
    new Setting(containerEl)
      .setName(t("笔记改名时同步更新链接", "Update links when notes are renamed"))
      .setDesc(t("笔记改名后,把所有表格里的 [[旧名]] 自动改成新名", "Rewrite [[old name]] in every table when a note is renamed"))
      .addToggle((tg) =>
        tg.setValue(s.syncLinksOnRename).onChange((v) => {
          s.syncLinksOnRename = v;
          void save();
        })
      );
    new Setting(containerEl)
      .setName(t("修改前自动备份", "Back up before first write"))
      .setDesc(t("每次打开或外部更新后，首次保存前把原文件备份到库内 .personal-base-table-backups；备份失败会停止保存", "Back up the original file to .personal-base-table-backups before the first save after opening or an external update. A failed backup blocks the save."))
      .addToggle((tg) =>
        tg.setValue(s.autoBackup).onChange((v) => {
          s.autoBackup = v;
          void save();
        })
      );
  }
}
