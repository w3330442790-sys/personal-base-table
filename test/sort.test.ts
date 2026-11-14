import { test } from "node:test";
import assert from "node:assert/strict";
import { nextSort, sortDirection } from "../webview/src/sort";
import { applyView } from "../webview/src/filter";

test("header sorting cycles through ascending, descending and cleared", () => {
  assert.deepEqual(nextSort([], "状态"), [{ field: "状态", dir: "asc" }]);
  assert.deepEqual(nextSort([{ field: "状态", dir: "asc" }], "状态"), [{ field: "状态", dir: "desc" }]);
  assert.deepEqual(nextSort([{ field: "状态", dir: "desc" }], "状态"), []);
});

test("header sorting replaces multi-column sorting with the clicked column", () => {
  const existing = [{ field: "标题", dir: "asc" as const }, { field: "日期", dir: "desc" as const }];
  assert.deepEqual(nextSort(existing, "状态"), [{ field: "状态", dir: "asc" }]);
  assert.equal(sortDirection(existing, "日期"), "desc");
  assert.equal(sortDirection(existing, "状态"), undefined);
});

test("empty values stay last in both ascending and descending sorts", () => {
  const rows = [
    { id: "empty", values: { n: "" } },
    { id: "two", values: { n: 2 } },
    { id: "one", values: { n: 1 } },
  ];
  const fields = { n: { type: "number" as const } };
  assert.deepEqual(applyView(rows, { name: "asc", sorts: [{ field: "n", dir: "asc" }] }, fields).map((row) => row.id), ["one", "two", "empty"]);
  assert.deepEqual(applyView(rows, { name: "desc", sorts: [{ field: "n", dir: "desc" }] }, fields).map((row) => row.id), ["two", "one", "empty"]);
});
