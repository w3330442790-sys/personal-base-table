import { test } from "node:test";
import assert from "node:assert/strict";
import { cellStyle, formatCells, toggleCellStyle } from "../src/core/cell-style";
import { applySheetMessage } from "../src/core/messages";
import { duplicateSheet, getSheet, WorkbookSession } from "../src/core/workbook";
import { deleteRows, insertRows, selectionClipboard, sheetRows } from "../src/core/features";
import { toXLS } from "../webview/src/export";
import type { BaseDoc } from "../src/core/types";

function fixture(): BaseDoc {
  return { fields: { Title: { type: "text", primary: true }, Notes: { type: "longtext" } }, views: [{ name: "All" }], records: [{ id: "r1", Title: "One", Notes: "Long text" }, { id: "r2", Title: "Two" }] };
}

test("formatting a rectangle preserves values and rejects stale selections atomically", () => {
  const doc = fixture();
  const records = JSON.stringify(doc.records);
  toggleCellStyle(doc, ["r1", "r2"], ["Title", "Notes"], "bold");
  assert.equal(cellStyle(doc, "r2", "Notes").bold, true);
  assert.equal(JSON.stringify(doc.records), records);
  const before = JSON.stringify(doc);
  assert.throws(() => formatCells(doc, ["missing"], ["Title"], { italic: true }));
  assert.equal(JSON.stringify(doc), before);
  toggleCellStyle(doc, ["r1", "r2"], ["Title", "Notes"], "bold");
  assert.deepEqual(cellStyle(doc, "r1", "Title"), {});
});

test("cell formatting survives serialization and full document undo and redo", () => {
  const session = new WorkbookSession(fixture());
  session.transact("格式", doc => formatCells(doc, ["r1"], ["Title"], { italic: true, underline: true, strikethrough: true }));
  session.undo();
  assert.deepEqual(cellStyle(session.document, "r1", "Title"), {});
  session.redo();
  const reopened = new WorkbookSession(JSON.parse(JSON.stringify(session.document)));
  assert.equal(cellStyle(reopened.document, "r1", "Title").strikethrough, true);
});

test("column operations and duplicated rows or sheets maintain formatting ownership", () => {
  const doc = fixture();
  formatCells(doc, ["r1"], ["Notes"], { bold: true });
  applySheetMessage(doc, { type: "renameField", oldName: "Notes", newName: "Details" });
  assert.equal(cellStyle(doc, "r1", "Details").bold, true);
  assert.deepEqual(cellStyle(doc, "r1", "Notes"), {});
  applySheetMessage(doc, { type: "duplicateField", name: "Details" });
  assert.equal(cellStyle(doc, "r1", "Details 副本").bold, true);
  const [row] = insertRows(doc, "r1", "below", 1, true);
  assert.equal(cellStyle(doc, row, "Details").bold, true);
  const sheetId = duplicateSheet(doc, "main");
  const copied = getSheet(doc, sheetId);
  assert.equal(cellStyle(copied, String(copied.records[0].id), "Details").bold, true);
  deleteRows(doc, [row], false);
  assert.deepEqual(cellStyle(doc, row, "Details"), {});
  applySheetMessage(doc, { type: "deleteField", name: "Details" });
  assert.deepEqual(cellStyle(doc, "r1", "Details"), {});
});

test("HTML clipboard and Excel export carry styles while escaping cell content", () => {
  const doc = fixture();
  doc.records[0].Title = "<value>";
  formatCells(doc, ["r1"], ["Title"], { bold: true, italic: true });
  const clipboard = selectionClipboard(doc, sheetRows(doc), ["Title"]);
  assert.match(clipboard.html, /font-weight:700/);
  assert.match(clipboard.html, /&lt;value&gt;/);
  const styles = (doc.personalGrid as { cellStyles: import("../src/core/cell-style").StyleMap }).cellStyles;
  const excel = toXLS(["Title"], sheetRows(doc), [], styles);
  assert.match(excel, /font-style:italic/);
  assert.match(excel, /&lt;value&gt;/);
});
