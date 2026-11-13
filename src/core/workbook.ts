import type { BaseDoc } from "./types";
import { genId } from "./types";
import { starterDoc } from "./doc";
import type { GridMetadata } from "./features";

export interface SheetInfo { id: string; name: string }
export interface PersonalWorkbook {
  version: 1;
  id: string;
  main: SheetInfo;
  sheets: Array<SheetInfo & { data: BaseDoc }>;
  order: string[];
  templates?: Array<{ id: string; name: string; data: BaseDoc }>;
  [key: string]: unknown;
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function workbook(doc: BaseDoc): PersonalWorkbook {
  if (doc.personal) {
    const existing = doc.personal as PersonalWorkbook;
    if (existing.version !== 1 || !Array.isArray(existing.sheets) || !Array.isArray(existing.order) || existing.main?.id !== "main") {
      throw new Error("工作簿版本或工作表结构无效");
    }
    return existing;
  }
  const personal: PersonalWorkbook = {
    version: 1, id: genId(), main: { id: "main", name: "工作表1" }, sheets: [], order: ["main"],
  };
  doc.personal = personal;
  return personal;
}

export function listSheets(doc: BaseDoc): SheetInfo[] {
  if (!doc.personal) return [{ id: "main", name: "工作表1" }];
  const meta = workbook(doc);
  const sheets = [meta.main, ...meta.sheets];
  return meta.order.map(id => sheets.find(s => s.id === id)).filter((s): s is SheetInfo => !!s).map(({ id, name }) => ({ id, name }));
}

export function getSheet(doc: BaseDoc, id: string): BaseDoc {
  if (id === "main") return doc;
  const sheet = workbook(doc).sheets.find(s => s.id === id);
  if (!sheet) throw new Error("工作表不存在");
  return sheet.data;
}

function uniqueSheetName(doc: BaseDoc, name: string): string {
  const names = new Set(listSheets(doc).map(s => s.name));
  const base = name.trim() || "工作表";
  let unique = base;
  let suffix = 2;
  while (names.has(unique)) unique = `${base} ${suffix++}`;
  return unique;
}

export function addSheet(doc: BaseDoc, name = "新工作表", data = starterDoc()): string {
  const meta = workbook(doc);
  const id = genId();
  const sheet = clone(data);
  delete sheet.personal;
  meta.sheets.push({ id, name: uniqueSheetName(doc, name), data: sheet });
  meta.order.push(id);
  return id;
}

export function remapRecords(sheet: BaseDoc): BaseDoc {
  const copy = clone(sheet);
  delete copy.personal;
  const ids = new Map(copy.records.map(r => [String(r.id), genId()]));
  for (const record of copy.records) record.id = ids.get(String(record.id));
  const grid = copy.personalGrid as GridMetadata | undefined;
  if (grid?.parents) grid.parents = Object.fromEntries(Object.entries(grid.parents).map(([id, parent]) => [ids.get(id)!, ids.get(parent)!]).filter(([id, parent]) => id && parent));
  if (grid?.collapsed) grid.collapsed = grid.collapsed.map(id => ids.get(id)!).filter(Boolean);
  if (grid?.collapsedByView) for (const [view, collapsed] of Object.entries(grid.collapsedByView)) grid.collapsedByView[view] = collapsed.map(id => ids.get(id)!).filter(Boolean);
  if (grid?.cellStyles) grid.cellStyles = Object.fromEntries(Object.entries(grid.cellStyles).filter(([id]) => ids.has(id)).map(([id, values]) => [ids.get(id)!, values]));
  for (const merge of grid?.merges ?? []) {
    merge.id = genId();
    merge.rowIds = merge.rowIds.map(id => ids.get(id)!).filter(Boolean);
    merge.original = Object.fromEntries(Object.entries(merge.original).map(([id, values]) => [ids.get(id)!, values]).filter(([id]) => id));
  }
  return copy;
}

export function duplicateSheet(doc: BaseDoc, id: string): string {
  const source = listSheets(doc).find(s => s.id === id);
  if (!source) throw new Error("工作表不存在");
  return addSheet(doc, `${source.name} 副本`, remapRecords(getSheet(doc, id)));
}

export function renameSheet(doc: BaseDoc, id: string, name: string): void {
  name = name.trim();
  if (!name) throw new Error("工作表名称不能为空");
  if (listSheets(doc).some(s => s.id !== id && s.name === name)) throw new Error("工作表名称已存在");
  const meta = workbook(doc);
  const sheet = id === "main" ? meta.main : meta.sheets.find(s => s.id === id);
  if (!sheet) throw new Error("工作表不存在");
  sheet.name = name;
}

export function removeSheet(doc: BaseDoc, id: string): void {
  const meta = workbook(doc);
  if (listSheets(doc).length <= 1) throw new Error("至少保留一张工作表");
  if (!listSheets(doc).some(s => s.id === id)) throw new Error("工作表不存在");
  if (id === "main") {
    const promotedId = meta.order.find(s => s !== "main")!;
    const promoted = meta.sheets.find(s => s.id === promotedId)!;
    const copy = clone(promoted.data);
    for (const key of Object.keys(doc)) if (key !== "personal") delete doc[key];
    Object.assign(doc, copy);
    meta.main.name = promoted.name;
    meta.sheets = meta.sheets.filter(s => s.id !== promotedId);
    meta.order = meta.order.filter(s => s !== "main").map(s => s === promotedId ? "main" : s);
  } else {
    meta.sheets = meta.sheets.filter(s => s.id !== id);
    meta.order = meta.order.filter(s => s !== id);
  }
}

export function validateWorkbook(doc: BaseDoc): void {
  const sheets = listSheets(doc);
  const seen = new Set<string>();
  for (const info of sheets) {
    if (seen.has(info.id)) throw new Error("工作表 ID 重复");
    seen.add(info.id);
    const sheet = getSheet(doc, info.id);
    if (!sheet.fields || Array.isArray(sheet.fields) || typeof sheet.fields !== "object" || !Array.isArray(sheet.records) || !Array.isArray(sheet.views)) throw new Error("工作表数据结构无效");
    const ids = new Set<string>();
    for (const rec of sheet.records) {
      if (typeof rec.id !== "string" || !rec.id || ids.has(rec.id)) throw new Error("行 ID 缺失或重复");
      ids.add(rec.id);
    }
  }
  if (doc.personal) {
    const meta = workbook(doc);
    if (meta.order.length !== meta.sheets.length + 1 || sheets.length !== meta.order.length) throw new Error("工作表顺序无效");
  }
}

interface HistoryEntry { label: string; doc: BaseDoc; sheetId: string }

/** The only owner of committed data. Callers receive detached copies. */
export class WorkbookSession {
  private current: BaseDoc;
  private past: HistoryEntry[] = [];
  private future: HistoryEntry[] = [];
  activeSheetId = "main";
  readonly documentId: string;

  constructor(doc: BaseDoc, readonly limit = 100) {
    this.current = clone(doc);
    this.documentId = workbook(this.current).id;
    // Legacy files without IDs are displayed using deterministic IDs until first save.
    for (const info of listSheets(this.current)) {
      const sheet = getSheet(this.current, info.id);
      const taken = new Set(sheet.records.map(r => r.id));
      sheet.records.forEach((r, i) => {
        if (typeof r.id === "string" && r.id) return;
        let generated = `_row${i}`;
        while (taken.has(generated)) generated += "_";
        r.id = generated;
        taken.add(generated);
      });
    }
    validateWorkbook(this.current);
  }

  get document(): BaseDoc { return clone(this.current); }
  get canUndo(): boolean { return this.past.length > 0; }
  get canRedo(): boolean { return this.future.length > 0; }
  get undoLabel(): string { return this.past[this.past.length - 1]?.label ?? ""; }
  get redoLabel(): string { return this.future[this.future.length - 1]?.label ?? ""; }

  transact(label: string, change: (doc: BaseDoc) => void, sheetId = this.activeSheetId): boolean {
    const next = clone(this.current);
    change(next);
    validateWorkbook(next);
    if (JSON.stringify(next) === JSON.stringify(this.current)) return false;
    this.past.push({ label, doc: clone(this.current), sheetId });
    this.past = this.past.slice(-this.limit);
    this.future = [];
    this.current = clone(next);
    return true;
  }

  undo(): boolean {
    const previous = this.past.pop();
    if (!previous) return false;
    this.future.push({ label: previous.label, doc: clone(this.current), sheetId: previous.sheetId });
    this.current = clone(previous.doc);
    this.activeSheetId = previous.sheetId;
    return true;
  }

  redo(): boolean {
    const next = this.future.pop();
    if (!next) return false;
    this.past.push({ label: next.label, doc: clone(this.current), sheetId: next.sheetId });
    this.current = clone(next.doc);
    this.activeSheetId = next.sheetId;
    return true;
  }
}
