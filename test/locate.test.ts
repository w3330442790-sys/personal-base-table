import { test } from "node:test";
import assert from "node:assert/strict";
import { locateCell } from "../webview/src/locate";

const rows = [{ id: "r1" }, { id: "r2" }, { id: "r3" }];
const cols = ["标题", "状态", "日期"];

test("locateCell maps a visible record and field to grid coordinates", () => {
  assert.deepEqual(locateCell(rows, cols, "r2", "状态"), { row: 1, col: 1 });
  assert.deepEqual(locateCell(rows, cols, "r3", "日期"), { row: 2, col: 2 });
});

test("locateCell reports filtered rows or hidden fields as unavailable", () => {
  assert.equal(locateCell(rows, cols, "missing", "标题"), null);
  assert.equal(locateCell(rows, cols, "r1", "隐藏列"), null);
  assert.equal(locateCell(rows, cols, undefined, "标题"), null);
  assert.equal(locateCell(rows, cols, "r1", undefined), null);
});
