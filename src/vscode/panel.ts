import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import {
  readBase,
  snapshotAdapter,
  updateCell,
  addRow,
  deleteRow,
  saveViews,
  setField,
  renameField,
  addField,
  duplicateField,
  reorderFields,
  moveRow,
  moveRowTo,
  replaceAll,
  deleteField,
} from "./fsStore";
import type { OutMsg as InMsg } from "../../webview/src/host";
import { SnapshotStore } from "../core/snapshots";

/** 一个 .base 文件就是一个 JSON 文本文档,用自定义编辑器把它渲染成多维表格 */
export class BaseEditorProvider implements vscode.CustomTextEditorProvider {
  static readonly viewType = "baseTable.editor";

  static register(context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      BaseEditorProvider.viewType,
      new BaseEditorProvider(context),
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      }
    );
  }

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel
  ): void {
    new BaseTableController(this.context, document, webviewPanel);
  }
}

/** 宿主 → webview 的快捷键命令 */
export type HostCommand = "undo" | "redo" | "addRow" | "export";

export class BaseTableController {
  /** 当前激活的表格编辑器,供快捷键命令定位 */
  static active: BaseTableController | undefined;

  private readonly file: string;
  /** 记录「自己最近一次写盘」的时刻,用来忽略由此触发的 document 变化,避免破坏乐观更新的丝滑 */
  private expectedContent: string;
  private writing = false;
  private revision = 0;
  private messageQueue: Promise<void> = Promise.resolve();
  private readonly snapshots: SnapshotStore;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly document: vscode.TextDocument,
    private readonly panel: vscode.WebviewPanel
  ) {
    this.file = document.uri.fsPath;
    this.expectedContent = document.getText();
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    this.snapshots = new SnapshotStore(snapshotAdapter(folder?.uri.fsPath ?? path.dirname(this.file)));
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, "out", "webview"))],
    };
    panel.webview.html = this.getHtml();

    const subs: vscode.Disposable[] = [];
    panel.webview.onDidReceiveMessage((m: InMsg) => {
      this.messageQueue = this.messageQueue.then(() => this.onMessage(m)).catch(error => {
        vscode.window.showErrorMessage(`多维表格操作失败: ${(error as Error).message}`);
      });
    }, null, subs);

    // 文件被外部改动(或我们自己写盘)时:只有「非自己写」的变化才刷新,否则会打断乐观更新
    vscode.workspace.onDidChangeTextDocument(
      (e) => {
        if (e.document.uri.toString() !== document.uri.toString()) return;
        if (this.writing || e.document.getText() === this.expectedContent) return;
        this.pushTable(true);
      },
      null,
      subs
    );
    vscode.workspace.onDidChangeConfiguration(
      (e) => {
        if (e.affectsConfiguration("baseTable")) this.pushTable();
      },
      null,
      subs
    );

    if (panel.active) BaseTableController.active = this;
    panel.onDidChangeViewState(
      (e) => {
        if (e.webviewPanel.active) BaseTableController.active = this;
        else if (BaseTableController.active === this) BaseTableController.active = undefined;
      },
      null,
      subs
    );

    panel.onDidDispose(() => {
      if (BaseTableController.active === this) BaseTableController.active = undefined;
      subs.forEach((d) => d.dispose());
    });
  }

  private async onMessage(m: InMsg) {
    try {
      switch (m.type) {
        case "ready":
          this.pushTable();
          break;
        // 高频操作:webview 已乐观更新,只静默写文件,不回推整表(避免闪烁/重渲染)
        case "updateCell":
          this.write(() => updateCell(this.file, m.id, m.field, m.value));
          break;
        case "deleteRow":
          this.write(() => deleteRow(this.file, m.id));
          break;
        case "saveViews":
          this.write(() => saveViews(this.file, m.views));
          break;
        case "setField":
          this.write(() => setField(this.file, m.name, m.patch));
          break;
        case "reorderFields":
          this.write(() => reorderFields(this.file, m.names));
          break;
        case "moveRow":
          this.write(() => moveRow(this.file, m.id, m.targetId));
          break;
        case "moveRowTo":
          this.write(() => moveRowTo(this.file, m.id, m.targetId, m.before));
          break;
        case "replaceAll":
          if (m.baseRevision !== undefined && m.baseRevision !== this.revision) {
            throw new Error("文件已在外部更改，请重新载入后重试");
          }
          this.write(() => replaceAll(this.file, m.doc));
          if (m.requestId) this.panel.webview.postMessage({ type: "operationResult", requestId: m.requestId, revision: this.revision });
          break;
        case "snapshotCreate":
          await this.snapshots.create(m.documentId, m.label, m.doc);
          this.panel.webview.postMessage({ type: "operationResult", requestId: m.requestId, snapshots: await this.snapshots.list(m.documentId) });
          break;
        case "snapshotList":
          this.panel.webview.postMessage({ type: "operationResult", requestId: m.requestId, snapshots: await this.snapshots.list(m.documentId) });
          break;
        case "snapshotRead":
          this.panel.webview.postMessage({ type: "operationResult", requestId: m.requestId, snapshot: await this.snapshots.read(m.documentId, m.id) });
          break;
        // 需要主进程生成数据(新 id / 连带改动)的操作:写完回推一次
        case "addRow":
          this.write(() => addRow(this.file));
          this.pushTable();
          break;
        // 改名已在 webview 乐观更新(含记录键),静默写盘即可,不回推以免闪烁/覆盖同批的 setField
        case "renameField":
          this.write(() => renameField(this.file, m.oldName, m.newName));
          break;
        case "addField":
          this.write(() => addField(this.file, m.name, m.def, m.after));
          this.pushTable();
          break;
        case "duplicateField":
          this.write(() => duplicateField(this.file, m.name));
          this.pushTable();
          break;
        case "deleteField":
          this.write(() => deleteField(this.file, m.name));
          this.pushTable();
          break;
        case "export":
          this.handleExport(m.defaultName, m.content);
          break;
        case "openLink":
          this.openWikiLink(m.target);
          break;
      }
    } catch (err) {
      vscode.window.showErrorMessage(`多维表格操作失败: ${(err as Error).message}`);
      if ("requestId" in m && m.requestId) {
        this.panel.webview.postMessage({ type: "operationResult", requestId: m.requestId, error: (err as Error).message, revision: this.revision });
      } else this.pushTable(); // Legacy optimistic operations need the committed state.
    }
  }

  /** 把快捷键命令转给 webview 执行 */
  runCommand(command: HostCommand) {
    this.panel.webview.postMessage({ type: "command", command });
  }

  /** 包裹写操作:标记写盘时刻,让紧随其后的 document 变化被忽略 */
  private write(fn: () => void) {
    this.writing = true;
    try {
      fn();
      this.expectedContent = fs.readFileSync(this.file, "utf8");
      this.revision++;
    } finally {
      this.writing = false;
    }
  }

  /** [[笔记]]:在工作区里找同名 .md(忽略 #标题),找到就打开 */
  private async openWikiLink(target: string) {
    const name = target.split("#")[0].trim();
    if (!name) return;
    const glob = `**/${name.replace(/[\[\]{}*?]/g, "?")}.md`;
    const hits = await vscode.workspace.findFiles(glob, "**/node_modules/**", 5);
    if (hits.length === 0) {
      vscode.window.showInformationMessage(`工作区里没有找到笔记「${name}.md」`);
      return;
    }
    await vscode.window.showTextDocument(hits[0], { preview: false });
  }

  private async handleExport(defaultName: string, content: string) {
    const dir = path.dirname(this.file);
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(dir, defaultName)),
      title: "导出多维表格",
    });
    if (!target) return;
    try {
      await vscode.workspace.fs.writeFile(target, Buffer.from(content, "utf8"));
      const open = await vscode.window.showInformationMessage(`已导出到 ${path.basename(target.fsPath)}`, "打开");
      if (open === "打开") vscode.commands.executeCommand("revealFileInOS", target);
    } catch (err) {
      vscode.window.showErrorMessage(`导出失败: ${(err as Error).message}`);
    }
  }

  private getConfig() {
    const c = vscode.workspace.getConfiguration("baseTable");
    return {
      rowHeight: c.get<string>("rowHeight", "medium"),
      showRowNumbers: c.get<boolean>("showRowNumbers", true),
      fontSize: c.get<number>("fontSize", 0),
      colorfulTags: c.get<boolean>("colorfulTags", true),
      wrapText: c.get<boolean>("wrapText", false),
    };
  }

  private pushTable(external = false) {
    try {
      const table = readBase(this.file);
      if (external) this.revision++;
      this.panel.webview.postMessage({ type: "tableData", table, config: this.getConfig(), revision: this.revision, external });
    } catch (error) {
      vscode.window.showErrorMessage(`读取多维表格失败: ${(error as Error).message}`);
    }
  }

  private getHtml(): string {
    const dist = path.join(this.context.extensionPath, "out", "webview");
    const indexPath = path.join(dist, "index.html");
    if (!fs.existsSync(indexPath)) {
      return `<html><body style="font-family:sans-serif;padding:2rem">Webview 未构建,请先运行 <code>npm run build:web</code></body></html>`;
    }
    let html = fs.readFileSync(indexPath, "utf8");
    const webview = this.panel.webview;
    // 把 vite 产出的相对资源路径(./assets/..)换成 webview URI
    html = html.replace(/(href|src)="(\.\/[^"]+)"/g, (_all, attr, rel) => {
      const uri = webview.asWebviewUri(vscode.Uri.file(path.join(dist, rel)));
      return `${attr}="${uri}"`;
    });
    return html;
  }
}
