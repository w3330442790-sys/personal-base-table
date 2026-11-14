import { test } from "node:test";
import assert from "node:assert/strict";
import { buildImportedDoc, detectDelimiter, importSheetName, parseImportText } from "../webview/src/import";

test("detectDelimiter ignores quoted commas and picks the real separator", () => {
  assert.equal(detectDelimiter('"A,B"\tC\n1\t2'), "\t");
  assert.equal(detectDelimiter("A,B\n1,2"), ",");
  assert.equal(detectDelimiter("A;B\n1;2"), ";");
});

test("CSV import infers common types and keeps quoted commas and newlines", () => {
  const { matrix } = parseImportText('标题,数量,完成,日期\n"甲,乙",3,true,2026-01-02\n"多行\n文本",4,false,2026-01-03\n');
  const doc = buildImportedDoc(matrix, { header: true });
  assert.deepEqual(Object.keys(doc.fields), ["标题", "数量", "完成", "日期"]);
  assert.equal(doc.fields.数量.type, "number");
  assert.equal(doc.fields.完成.type, "checkbox");
  assert.equal(doc.fields.日期.type, "date");
  assert.equal(doc.records.length, 2);
  const first = doc.records[0];
  assert.equal(first["标题"], "甲,乙");
  assert.equal(first["数量"], 3);
  assert.equal(first["完成"], true);
  assert.equal(doc.records[1]["标题"], "多行\n文本");
});

test("CSV import handles duplicate/blank headers and headerless files", () => {
  const withHeader = buildImportedDoc([["A", "A", ""], ["1", "2", "x"]], { header: true });
  assert.deepEqual(Object.keys(withHeader.fields), ["A", "A 2", "列3"]);
  const withoutHeader = buildImportedDoc([["a", "b"], ["c", "d"]], { header: false });
  assert.deepEqual(Object.keys(withoutHeader.fields), ["列1", "列2"]);
  assert.equal(withoutHeader.records.length, 2);
});

test("import sheet names strip supported extensions", () => {
  assert.equal(importSheetName("选题库.csv"), "选题库");
  assert.equal(importSheetName("my table.tsv"), "my table");
  assert.equal(importSheetName(".csv"), "导入表格");
});
