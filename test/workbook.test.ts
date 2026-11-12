import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDoc, serializeDoc, toTable } from "../src/core/doc";
import * as ops from "../src/core/ops";
import { WorkbookSession, getSheet, listSheets, addSheet, removeSheet, duplicateSheet } from "../src/core/workbook";
import type { BaseDoc } from "../src/core/types";
import { applySheetMessage } from "../src/core/messages";
import { gridMeta } from "../src/core/features";

function fixture(): BaseDoc {
  return {
    fields: { Title: { type: "text", primary: true }, Status: { type: "select", options: ["Todo"], colors: { Todo: "blue" } } },
    views: [{ name: "All", filters: [{ field: "Status", op: "is", value: "Todo" }], colWidths: { Status: 160 } }],
    records: [{ id: "r1", Title: "Example", Status: "Todo" }],
  };
}

test("UI table never shares mutable field or view metadata with its document", () => {
  const doc = fixture();
  const table = toTable(doc, "sample.wbase");
  ops.deleteField(doc, "Status");
  assert.equal(table.fields.Status.type, "select");
  assert.equal(table.views[0].colWidths!.Status, 160);
});

test("unknown document properties survive parsing and JSON round trips", () => {
  const doc = { ...fixture(), custom: { nested: [1, 2] } };
  assert.deepEqual(parseDoc(serializeDoc(doc), true), doc);
});

test("delete-column undo and redo preserve the full field, records and view settings", () => {
  const history = new WorkbookSession(fixture());
  const before = history.document;
  history.transact("删除列", d => ops.deleteField(d, "Status"));
  assert.equal(history.document.fields.Status, undefined);
  assert.equal(history.undo(), true);
  assert.deepEqual(history.document, before);
  assert.equal(history.redo(), true);
  assert.equal(history.document.fields.Status, undefined);
  history.undo();
  history.transact("修改选项", d => d.fields.Status.options!.push("Done"));
  history.undo();
  assert.deepEqual(history.document, before);
  assert.equal(history.canRedo, true);
});

test("failed and no-op transactions leave document and redo untouched", () => {
  const history = new WorkbookSession(fixture());
  history.transact("修改", d => ops.updateCell(d, "r1", "Title", "Changed"));
  history.undo();
  const before = history.document;
  assert.throws(() => history.transact("失败", d => { d.records.length = 0; throw new Error("stop"); }));
  assert.deepEqual(history.document, before);
  assert.equal(history.transact("无变化", () => {}), false);
  assert.equal(history.canRedo, true);
});

test("worksheets remain independent, duplication remaps row ids, sheet deletion is undoable", () => {
  const history = new WorkbookSession(fixture());
  let added = "";
  history.transact("新建表", d => { added = addSheet(d, "Sheet 2"); });
  assert.equal(listSheets(history.document).length, 2);
  history.transact("修改新表", d => { getSheet(d, added).records.push({ id: "child", 标题: "Second" }); });
  assert.equal(history.document.records.length, 1);
  history.transact("复制", d => duplicateSheet(d, "main"));
  const copy = listSheets(history.document)[2];
  assert.notEqual(getSheet(history.document, copy.id).records[0].id, "r1");
  history.transact("删除", d => removeSheet(d, added));
  history.undo();
  assert.equal(getSheet(history.document, added).records.length, 1);
});

test("redo returns to the affected worksheet even when the user switched before undo", () => {
  const history = new WorkbookSession(fixture());
  let second = "";
  history.transact("添加", d => { second = addSheet(d); });
  history.transact("编辑主表", d => ops.updateCell(d, "r1", "Title", "Changed"));
  history.activeSheetId = second;
  history.undo();
  assert.equal(history.activeSheetId, "main");
  history.activeSheetId = second;
  history.redo();
  assert.equal(history.activeSheetId, "main");
});

test("column rename and deletion preserve valid column-group references", () => {
  const doc = fixture();
  gridMeta(doc).columnGroupsByView = { All: [{ id: "g", name: "Group", fields: ["Title", "Status"], collapsed: true }] };
  applySheetMessage(doc, { type: "renameField", oldName: "Status", newName: "Progress" });
  assert.deepEqual(gridMeta(doc).columnGroupsByView!.All[0].fields, ["Title", "Progress"]);
  applySheetMessage(doc, { type: "deleteField", name: "Progress" });
  assert.deepEqual(gridMeta(doc).columnGroupsByView!.All, []);
});

test("duplicate sheets remap view-scoped collapse to their new row ids", () => {
  const doc = fixture();
  gridMeta(doc).collapsedByView = { All: ["r1"] };
  const id = duplicateSheet(doc, "main");
  const copy = getSheet(doc, id);
  assert.deepEqual(gridMeta(copy).collapsedByView!.All, [copy.records[0].id]);
});
