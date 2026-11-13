import { useEffect, useRef, useState } from "react";
import type { BaseDoc } from "../../src/core/types";
import { genId } from "../../src/core/types";
import { toTable } from "../../src/core/doc";
import { addSheet, clone, duplicateSheet, getSheet, listSheets, removeSheet, renameSheet, validateWorkbook, workbook, WorkbookSession } from "../../src/core/workbook";
import { applySheetMessage, type SheetMessage } from "../../src/core/messages";
import { readGridMeta, unmergeCells } from "../../src/core/features";
import { replaceAll } from "../../src/core/ops";
import type { SnapshotMetadata } from "../../src/core/snapshots";
import { App } from "./App";
import { ProjectedWorkbookGrid } from "./ProjectedWorkbookGrid";
import { FeaturePanels } from "./FeaturePanels";
import { defaultHost, type Host, type InMsg, type OutMsg } from "./host";
import { defaultConfig } from "./config";
import { WorkbookRibbon } from "./WorkbookRibbon";
import { rebaseFormulas } from "../../src/core/formulas";
import { formatCells } from "../../src/core/cell-style";
import { typedValue } from "../../src/core/features";
import { updateCell } from "../../src/core/ops";
import { useTabletViewport } from "./useTabletViewport";

type Result = Extract<InMsg, { type: "operationResult" }>;
type FeaturePanel = "search" | "format" | "details" | "templates" | "history" | "move" | "data" | null;

export function WorkbookApp({ host = defaultHost() }: { host?: Host }) {
  const session = useRef<WorkbookSession | null>(null);
  const revision = useRef(0);
  const identityPersisted = useRef(false);
  const path = useRef("");
  const config = useRef(defaultConfig);
  const listeners = useRef(new Set<(message: InMsg) => void>());
  const pending = useRef(new Map<string, { resolve: (result: Result) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>());
  const queue = useRef(Promise.resolve());
  const alive = useRef(true);
  const generation = useRef(0);
  const failedDraft = useRef<{ doc: BaseDoc; owner: WorkbookSession; revision: number; label: string; sheetId: string; focusSheet?: string } | null>(null);
  const [hasDraft, setHasDraft] = useState(false);
  const [document, setDocument] = useState<BaseDoc | null>(null);
  const workbookRoot = useRef<HTMLDivElement>(null);
  const tabletViewport = useTabletViewport(workbookRoot, !!document);
  const [active, setActive] = useState("main");
  const [panel, setPanel] = useState<FeaturePanel>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [selectedRows, setSelectedRows] = useState<string[]>([]);
  const [selectedCols, setSelectedCols] = useState<string[]>([]);
  const [gridCommand, setGridCommand] = useState<{ id: number; kind: string; value?: string | number }>();
  const commandId = useRef(0);
  const publishedSheet = useRef("main");
  const [snapshots, setSnapshots] = useState<SnapshotMetadata[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [rename, setRename] = useState<{ id: string; name: string } | null>(null);
  const [sheetMenu, setSheetMenu] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [mergeGuard, setMergeGuard] = useState<{ sheetId: string; messages: SheetMessage[]; merges: string[] } | null>(null);
  const dragSheet = useRef<string | null>(null);
  const currentActions = useRef<{ undo: () => void; redo: () => void }>({ undo: () => {}, redo: () => {} });

  function publish(): void {
    const current = session.current;
    if (!current) return;
    const doc = failedDraft.current?.owner === current ? clone(failedDraft.current.doc) : current.document;
    if (!listSheets(doc).some(s => s.id === current.activeSheetId)) current.activeSheetId = "main";
    if (publishedSheet.current !== current.activeSheetId) {
      setGridCommand(undefined);
      publishedSheet.current = current.activeSheetId;
    }
    setDocument(doc);
    setActive(current.activeSheetId);
    const table = toTable(getSheet(doc, current.activeSheetId), path.current);
    // JSON export always includes every worksheet and extension property.
    table.document = doc;
    table.sheetId = current.activeSheetId;
    for (const listener of listeners.current) listener({ type: "tableData", table, config: config.current });
  }

  function request(message: OutMsg & { requestId: string }): Promise<Result> {
    return new Promise((resolve, reject) => {
      if (!alive.current) { reject(new Error("表格视图已关闭")); return; }
      const timer = setTimeout(() => { pending.current.delete(message.requestId); reject(new Error("保存响应超时，请检查文件状态后重试")); }, 30000);
      pending.current.set(message.requestId, { resolve, reject, timer });
      host.post(message);
    });
  }

  function enqueue(operation: () => Promise<void>): void {
    const ownerGeneration = generation.current;
    queue.current = queue.current.catch(() => {}).then(async () => {
      if (!alive.current || generation.current !== ownerGeneration) return;
      setBusy(true);
      setError("");
      try { await operation(); }
      catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); publish(); }
      finally { if (alive.current) setBusy(false); }
    });
  }

  async function createSnapshot(label: string, doc: BaseDoc): Promise<void> {
    if (!identityPersisted.current) await persist(session.current!.document);
    const result = await request({ type: "snapshotCreate", requestId: genId(), documentId: session.current!.documentId, label, doc });
    if (result.snapshots) setSnapshots(result.snapshots);
  }

  async function persist(next: BaseDoc): Promise<void> {
    const result = await request({ type: "replaceAll", requestId: genId(), baseRevision: revision.current, doc: next });
    if (result.revision !== undefined) revision.current = result.revision;
    identityPersisted.current = (next.personal as { id?: string } | undefined)?.id === session.current?.documentId;
  }

  function transactDocument(label: string, change: (doc: BaseDoc) => void, destructive = false, focusSheet?: () => string): void {
    if (failedDraft.current) { setError("有尚未保存的修改，请先重试保存或导出待保存副本"); return; }
    const affectedSheet = session.current!.activeSheetId;
    enqueue(async () => {
      if (failedDraft.current) throw new Error("请先处理尚未保存的修改");
      const owner = session.current!;
      const before = owner.document;
      const next = clone(before);
      change(next);
      if (label !== "恢复历史快照") {
        const nextSheets = new Set(listSheets(next).map(sheet => sheet.id));
        for (const info of listSheets(before)) if (nextSheets.has(info.id)) {
          const previousSheet = getSheet(before, info.id);
          const nextSheet = getSheet(next, info.id);
          const removed = Object.keys(previousSheet.fields).filter(field => !nextSheet.fields[field]);
          const added = Object.keys(nextSheet.fields).filter(field => !previousSheet.fields[field]);
          const rename = removed.length === 1 && added.length === 1 && Object.keys(previousSheet.fields).indexOf(removed[0]) === Object.keys(nextSheet.fields).indexOf(added[0]) ? { [removed[0]]: added[0] } : {};
          rebaseFormulas(previousSheet, nextSheet, rename);
        }
      }
      const nextActive = focusSheet?.();
      validateWorkbook(next);
      if (JSON.stringify(before) === JSON.stringify(next)) return;
      if (destructive) await createSnapshot(label, before);
      if (owner !== session.current) throw new Error("文件已被外部更新，请重试操作");
      try { await persist(next); }
      catch (reason) {
        failedDraft.current = { doc: next, owner, revision: revision.current, label, sheetId: affectedSheet, focusSheet: nextActive };
        setHasDraft(true);
        throw reason;
      }
      if (owner !== session.current) throw new Error("文件已被外部更新，已重新载入");
      owner.transact(label, doc => replaceAll(doc, next), affectedSheet);
      if (nextActive) owner.activeSheetId = nextActive;
      publish();
    });
  }

  function transact(label: string, change: (sheet: BaseDoc) => void, destructive = false): void {
    const sheetId = active;
    transactDocument(label, doc => change(getSheet(doc, sheetId)), destructive);
  }

  function createWorksheet(source?: string): void {
    let created = "";
    transactDocument(source ? "复制工作表" : "新建工作表", doc => {
      created = source ? duplicateSheet(doc, source) : addSheet(doc);
    }, false, () => created);
  }

  function navigateHistory(direction: "undo" | "redo"): void {
    if (failedDraft.current) { setError("请先处理尚未保存的修改"); return; }
    enqueue(async () => {
      const owner = session.current!;
      // Restore history position if persistence fails, without discarding either stack.
      if (!owner[direction]()) return;
      const next = owner.document;
      try { await persist(next); }
      catch (reason) { owner[direction === "undo" ? "redo" : "undo"](); throw reason; }
      if (owner !== session.current) throw new Error("文件已被外部更新，已重新载入");
      publish();
    });
  }
  currentActions.current = { undo: () => navigateHistory("undo"), redo: () => navigateHistory("redo") };

  const sheetHost = useRef<Host | null>(null);
  const adapterActions = useRef<(message: OutMsg) => void>(() => {});
  const batch = useRef<SheetMessage[]>([]);
  adapterActions.current = (message) => {
    if (message.type === "ready") { publish(); return; }
    if (message.type === "openLink" || message.type === "export") { host.post(message); return; }
    if (message.type === "replaceAll" || message.type.startsWith("snapshot")) return;
    batch.current.push(message as SheetMessage);
    if (batch.current.length > 1) return;
    const sheetId = session.current!.activeSheetId;
    queueMicrotask(() => {
      const messages = batch.current.splice(0);
      if (!alive.current || !messages.length) return;
      const currentSheet = getSheet(session.current!.document, sheetId);
      const affected = (readGridMeta(currentSheet).merges ?? []).filter(merge => messages.some(message => {
        if (message.type === "saveViews" && merge.rowIds.length > 1) return JSON.stringify(message.views.map(v => v.sorts ?? v.sort)) !== JSON.stringify(currentSheet.views.map(v => v.sorts ?? v.sort));
        if (message.type === "reorderFields") {
          const indexes = merge.fields.map(field => message.names.indexOf(field));
          return indexes.some((index, i) => i > 0 && index !== indexes[i - 1] + 1);
        }
        return false;
      }));
      if (affected.length) { setMergeGuard({ sheetId, messages, merges: affected.map(m => m.id) }); publish(); return; }
      const destructive = messages.some(m => m.type === "deleteField" || m.type === "deleteRow");
      transactDocument(messages.length > 1 ? "批量修改" : operationLabel(messages[0]), doc => {
        for (const m of messages) applySheetMessage(getSheet(doc, sheetId), m);
      }, destructive);
    });
  };
  if (!sheetHost.current) sheetHost.current = {
    post: message => adapterActions.current(message),
    subscribe: listener => { listeners.current.add(listener); return () => listeners.current.delete(listener); },
    resolveResource: host.resolveResource,
  };

  useEffect(() => {
    alive.current = true;
    const unsubscribe = host.subscribe(message => {
      if (message.type === "operationResult") {
        const waiting = pending.current.get(message.requestId);
        if (!waiting) return;
        clearTimeout(waiting.timer);
        pending.current.delete(message.requestId);
        if (message.error) waiting.reject(new Error(message.error));
        else waiting.resolve(message);
        return;
      }
      if (message.type === "command") {
        if (message.command === "undo" || message.command === "redo") {
          const element = window.document.activeElement as HTMLElement | null;
          if (element?.matches("input:not([type=checkbox]):not([type=radio]):not([type=button]),textarea,[contenteditable=true]")) window.document.execCommand(message.command);
          else currentActions.current[message.command]();
        } else for (const listener of listeners.current) listener(message);
        return;
      }
      if (message.type === "tableData") {
        config.current = message.config;
        path.current = message.table.path;
        if (message.revision !== undefined) revision.current = message.revision;
        if (!session.current || message.external) {
          try {
            const incoming: BaseDoc = message.table.document ?? { fields: message.table.fields, views: message.table.views, records: message.table.rows.map(r => ({ id: r.id, ...r.values })) };
            identityPersisted.current = !!(incoming.personal as { id?: string } | undefined)?.id;
            session.current = new WorkbookSession(incoming, message.config.historyLimit ?? 100);
            generation.current++;
            batch.current = [];
            if (message.external) setError("文件已被外部更新，撤销历史已重置");
          } catch (reason) { setError(String(reason)); return; }
        }
        publish();
      }
    });
    host.post({ type: "ready" });
    return () => {
      alive.current = false;
      generation.current++;
      unsubscribe();
      for (const waiting of pending.current.values()) { clearTimeout(waiting.timer); waiting.reject(new Error("表格视图已关闭")); }
      pending.current.clear();
    };
  }, [host]);

  function loadHistory(): void {
    setPanel("history");
    enqueue(async () => {
      const result = await request({ type: "snapshotList", requestId: genId(), documentId: session.current!.documentId });
      setSnapshots(result.snapshots ?? []);
    });
  }

  function readSnapshot(id: string, restore = false): void {
    enqueue(async () => {
      const result = await request({ type: "snapshotRead", requestId: genId(), documentId: session.current!.documentId, id });
      if (!result.snapshot) throw new Error("快照内容不可用");
      setSnapshots(previous => previous.map(s => s.id === id ? result.snapshot! : s));
      if (restore) {
        const captured = result.snapshot.doc;
        transactDocument("恢复历史快照", doc => replaceAll(doc, captured), true);
      }
    });
  }

  if (!document) return <div className="loading" role="status">{error || "正在载入工作簿…"}</div>;
  const sheet = getSheet(document, active);
  const sheets = listSheets(document);
  const issueCommand = (kind: string, value?: string | number) => {
    if (kind === "fontColor" || kind === "fillColor") {
      if (!selectedRows.length || !selectedCols.length) { setError("请先选择要设置颜色的单元格"); return; }
      transact("设置单元格颜色", candidate => formatCells(candidate, selectedRows, selectedCols, { [kind === "fontColor" ? "color" : "background"]: String(value) }));
      return;
    }
    setGridCommand({ id: ++commandId.current, kind, value });
  };
  const openPanel = (next: Exclude<FeaturePanel, null>) => {
    if (next === "history") { loadHistory(); return; }
    if (next === "details") setDetailId(selectedRows[0] ?? null);
    setPanel(next);
  };
  return <div ref={workbookRoot} className={`personal-workbook${tabletViewport.keyboard ? " tablet-keyboard-open" : ""}`} style={{ maxHeight: tabletViewport.height }} aria-busy={busy} onKeyDownCapture={event => {
    if ((event.ctrlKey || event.metaKey) && ["f", "h"].includes(event.key.toLowerCase())) { event.preventDefault(); event.stopPropagation(); setPanel("search"); }
  }}>
    {error && <div className="workbook-error" role="alert">{error}<button aria-label="关闭提示" onClick={() => setError("")}>×</button></div>}
    {hasDraft && <div className="workbook-error" role="alert"><span>修改已保留，尚未写入文件。</span><button onClick={() => enqueue(async () => {
      const draft = failedDraft.current!;
      if (draft.owner !== session.current || draft.revision !== revision.current) throw new Error("原文件已更新，请导出待保存副本以保留修改");
      await persist(draft.doc);
      draft.owner.transact(draft.label, doc => replaceAll(doc, draft.doc), draft.sheetId);
      if (draft.focusSheet) draft.owner.activeSheetId = draft.focusSheet;
      failedDraft.current = null;
      setHasDraft(false);
      publish();
    })}>重试保存</button><button onClick={() => {
      const draft = failedDraft.current!;
      host.post({ type: "export", defaultName: "工作簿-待保存副本.wbase", content: JSON.stringify(draft.doc, null, 2) + "\n" });
    }}>导出待保存副本</button><button onClick={() => { failedDraft.current = null; setHasDraft(false); publish(); }}>放弃待保存修改</button></div>}
    <div className={`workbook-content${busy || hasDraft ? " workbook-busy" : ""}`}>
      <App key={active} worksheetMode host={sheetHost.current!} managedHistory={{ canUndo: session.current!.canUndo, canRedo: session.current!.canRedo, undo: () => navigateHistory("undo"), redo: () => navigateHistory("redo") }}
        renderToolbar={controls => <WorkbookRibbon controls={controls} sheet={sheet} selectedRows={selectedRows} selectedCols={selectedCols} onCommand={issueCommand} onPanel={openPanel} onCreateSheet={() => createWorksheet()} busy={busy}
            onFormulaCommit={(id, field, value) => transact("编辑单元格内容与公式", candidate => {
              const merge = readGridMeta(candidate).merges?.find(region => region.rowIds.includes(id) && region.fields.includes(field));
              if (merge) merge.display = value;
              else updateCell(candidate, id, field, typedValue(value, candidate.fields[field]));
            })} />}
          renderTable={props => <ProjectedWorkbookGrid {...props} command={gridCommand} viewId={props.view.name} sheet={sheet} transact={transact}
          onDetail={id => { setDetailId(id); setPanel("details"); }}
          onSelection={(ids, cols) => { setSelectedRows(ids); setSelectedCols(cols); }}
          onMoveToSheet={ids => { setSelectedRows(ids); setPanel("move"); }} />}
      />
    </div>
    <div className="sheet-tabs" role="tablist" aria-label="工作表">
      {sheets.map(info => <div className="sheet-tab-wrap" key={info.id} draggable onDragStart={() => { dragSheet.current = info.id; }} onDragOver={event => event.preventDefault()} onDrop={() => {
        const from = dragSheet.current;
        if (!from || from === info.id) return;
        transactDocument("调整工作表顺序", doc => { const meta = workbook(doc); meta.order = meta.order.filter(id => id !== from); meta.order.splice(meta.order.indexOf(info.id), 0, from); });
      }}>
        <button role="tab" aria-selected={active === info.id} onDoubleClick={() => setRename({ id: info.id, name: info.name })} onClick={() => { session.current!.activeSheetId = info.id; setSelectedRows([]); setSelectedCols([]); publish(); }} onContextMenu={event => { event.preventDefault(); setSheetMenu(info.id); }}>{info.name}</button>
        <button aria-label={`${info.name}操作`} onClick={() => setSheetMenu(sheetMenu === info.id ? null : info.id)}>▾</button>
        {sheetMenu === info.id && <div className="sheet-menu"><button onClick={() => { setRename({ id: info.id, name: info.name }); setSheetMenu(null); }}>重命名</button><button onClick={() => { createWorksheet(info.id); setSheetMenu(null); }}>复制工作表</button><button disabled={sheets.length <= 1} onClick={() => { setDeleteTarget(info.id); setSheetMenu(null); }}>删除工作表</button></div>}
      </div>)}
      <button aria-label="新建工作表" title="新建独立工作表" onClick={() => createWorksheet()}>＋</button>
    </div>
    {rename && <div className="workbook-dialog-backdrop"><form className="workbook-dialog" onSubmit={event => { event.preventDefault(); transactDocument("重命名工作表", doc => renameSheet(doc, rename.id, rename.name)); setRename(null); }}><h3>重命名工作表</h3><input aria-label="工作表名称" autoFocus value={rename.name} onChange={event => setRename({ ...rename, name: event.target.value })} /><button type="submit">保存</button><button type="button" onClick={() => setRename(null)}>取消</button></form></div>}
    {deleteTarget && <div className="workbook-dialog-backdrop"><div className="workbook-dialog"><h3>删除工作表</h3><p>将删除 {sheets.find(s => s.id === deleteTarget)?.name} 的 {getSheet(document, deleteTarget).records.length} 行记录。操作前会创建快照，之后可以撤销。</p><button onClick={() => { transactDocument("删除工作表", doc => removeSheet(doc, deleteTarget), true); setDeleteTarget(null); }}>删除并保留快照</button><button onClick={() => setDeleteTarget(null)}>取消</button></div></div>}
    {mergeGuard && <div className="workbook-dialog-backdrop"><div className="workbook-dialog"><h3>调整合并区域</h3><p>此操作会改变合并区域的位置。可以先取消相关合并，再继续操作。原单元格内容会恢复，操作可以撤销。</p><button onClick={() => {
      const guard = mergeGuard;
      transactDocument("取消合并并调整表格", doc => { const target = getSheet(doc, guard.sheetId); guard.merges.forEach(id => unmergeCells(target, id, true)); guard.messages.forEach(message => applySheetMessage(target, message)); }, true);
      setMergeGuard(null);
    }}>取消相关合并并继续</button><button onClick={() => { setMergeGuard(null); publish(); }}>保留合并并取消操作</button></div></div>}
    <FeaturePanels panel={panel} onClose={() => setPanel(null)} sheet={sheet} document={document} sheetId={active} sheetNames={sheets} selectedRows={selectedRows} selectedCols={selectedCols} detailId={detailId}
      transact={transact} transactDocument={transactDocument} snapshots={snapshots}
      onCreateSnapshot={() => enqueue(() => createSnapshot("手动快照", session.current!.document))}
      onReadSnapshot={id => readSnapshot(id)} onRestoreSnapshot={id => readSnapshot(id, true)}
      onNavigate={(id, rowId) => { session.current!.activeSheetId = id; setDetailId(rowId); setPanel("details"); publish(); }}
      onOpenLink={target => host.post({ type: "openLink", target })} resolveResource={host.resolveResource}
    />
  </div>;
}

function operationLabel(message: SheetMessage): string {
  const labels: Record<SheetMessage["type"], string> = { updateCell: "编辑单元格", addRow: "新增行", deleteRow: "删除行", saveViews: "修改视图", renameField: "重命名列", setField: "修改列设置", addField: "插入列", duplicateField: "复制列", reorderFields: "调整列顺序", moveRow: "移动行", moveRowTo: "移动行", deleteField: "删除列" };
  return labels[message.type];
}
