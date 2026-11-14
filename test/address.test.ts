import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCellAddress } from "../webview/src/address";

const fields = ["标题", "状态", "日期"];
const records = [{ id: "r1" }, { id: "r2" }, { id: "r3" }];

test("parseCellAddress resolves spreadsheet-style addresses", () => {
  assert.deepEqual(parseCellAddress("A1", fields, records), { rowId: "r1", field: "标题" });
  assert.deepEqual(parseCellAddress("c3", fields, records), { rowId: "r3", field: "日期" });
  assert.deepEqual(parseCellAddress("$B$2", fields, records), { rowId: "r2", field: "状态" });
});

test("parseCellAddress rejects malformed, out-of-range or hidden targets", () => {
  assert.equal(parseCellAddress("", fields, records), null);
  assert.equal(parseCellAddress("A0", fields, records), null);
  assert.equal(parseCellAddress("D1", fields, records), null);
  assert.equal(parseCellAddress("A4", fields, records), null);
  assert.equal(parseCellAddress("A1:C2", fields, records), null);
});
