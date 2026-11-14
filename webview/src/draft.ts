import type { BaseDoc } from "../../src/core/types";
import { validateWorkbook } from "../../src/core/workbook";

export interface DraftRecord {
  version: 1;
  doc: BaseDoc;
  revision: number;
  label: string;
  sheetId: string;
  focusSheet?: string;
  savedAt: number;
}

export interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const PREFIX = "personal-base-table.draft:";

export function draftStorageKey(path: string): string {
  return PREFIX + path;
}

export function writeDraft(storage: DraftStorage | undefined, path: string, draft: DraftRecord): boolean {
  if (!storage || !path) return false;
  try {
    storage.setItem(draftStorageKey(path), JSON.stringify(draft));
    return true;
  } catch {
    // localStorage can be unavailable or full on mobile; the in-memory draft
    // banner still works, so persistence is best-effort.
    return false;
  }
}

export function readDraft(storage: DraftStorage | undefined, path: string): DraftRecord | null {
  if (!storage || !path) return null;
  try {
    const raw = storage.getItem(draftStorageKey(path));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<DraftRecord>;
    if (!value || value.version !== 1 || !value.doc || !value.doc.fields || Array.isArray(value.doc.fields) || typeof value.doc.fields !== "object" || !Array.isArray(value.doc.views) || !Array.isArray(value.doc.records) || !Number.isFinite(value.revision) || typeof value.label !== "string" || typeof value.sheetId !== "string") return null;
    validateWorkbook(value.doc, { allowMissingIds: true });
    return {
      version: 1,
      doc: value.doc,
      revision: value.revision!,
      label: value.label,
      sheetId: value.sheetId,
      focusSheet: typeof value.focusSheet === "string" ? value.focusSheet : undefined,
      savedAt: typeof value.savedAt === "number" && Number.isFinite(value.savedAt) ? value.savedAt : 0,
    };
  } catch {
    return null;
  }
}

export function clearDraft(storage: DraftStorage | undefined, path: string): void {
  if (!storage || !path) return;
  try {
    storage.removeItem(draftStorageKey(path));
  } catch {
    // Ignore unavailable storage; there is nothing else to clean up.
  }
}

export function browserDraftStorage(): DraftStorage | undefined {
  try {
    return typeof window !== "undefined" ? window.localStorage : undefined;
  } catch {
    return undefined;
  }
}
