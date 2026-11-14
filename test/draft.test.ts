import { test } from "node:test";
import assert from "node:assert/strict";
import { clearDraft, draftStorageKey, readDraft, writeDraft, type DraftRecord, type DraftStorage } from "../webview/src/draft";
import type { BaseDoc } from "../src/core/types";

class MemoryStorage implements DraftStorage {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

const doc = (): BaseDoc => ({ fields: { 标题: { type: "text" } }, views: [], records: [{ id: "r1", 标题: "草稿" }] });
const record = (): DraftRecord => ({ version: 1, doc: doc(), revision: 7, label: "编辑单元格", sheetId: "main", focusSheet: "main", savedAt: 123 });

test("failed-save drafts round-trip through local storage", () => {
  const storage = new MemoryStorage();
  assert.equal(writeDraft(storage, "Notes/table.wbase", record()), true);
  assert.deepEqual(readDraft(storage, "Notes/table.wbase"), record());
  assert.equal(storage.values.has(draftStorageKey("Notes/table.wbase")), true);
  clearDraft(storage, "Notes/table.wbase");
  assert.equal(readDraft(storage, "Notes/table.wbase"), null);
});

test("malformed or foreign stored drafts are ignored", () => {
  const storage = new MemoryStorage();
  storage.setItem(draftStorageKey("table.wbase"), "{broken");
  assert.equal(readDraft(storage, "table.wbase"), null);
  storage.setItem(draftStorageKey("table.wbase"), JSON.stringify({ version: 2, doc: doc() }));
  assert.equal(readDraft(storage, "table.wbase"), null);
  storage.setItem(draftStorageKey("table.wbase"), JSON.stringify({ ...record(), doc: { fields: {}, views: [], records: [] } }));
  assert.deepEqual(readDraft(storage, "table.wbase")?.doc.records, []);
});

test("draft persistence fails soft when storage is unavailable or full", () => {
  const full: DraftStorage = {
    getItem: () => null,
    setItem: () => { throw new Error("QuotaExceededError"); },
    removeItem: () => {},
  };
  assert.equal(writeDraft(full, "table.wbase", record()), false);
  assert.equal(writeDraft(undefined, "table.wbase", record()), false);
  assert.equal(readDraft(undefined, "table.wbase"), null);
  assert.doesNotThrow(() => clearDraft(undefined, "table.wbase"));
});
