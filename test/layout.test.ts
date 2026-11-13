import { test } from "node:test";
import assert from "node:assert/strict";
import { rowHeaderWidth, gridWidth } from "../webview/src/grid-layout";
import { floatingPosition } from "../webview/src/floating";

test("row header stays compact and keeps a saved drag width", () => {
  assert.equal(rowHeaderWidth({}), 56);
  assert.equal(rowHeaderWidth({ __rownum__: 74 }), 74);
  assert.equal(rowHeaderWidth({ __rownum__: 8 }), 44);
  assert.equal(rowHeaderWidth({ __rownum__: 900 }), 160);
  assert.equal(rowHeaderWidth({ __rownum__: NaN }), 56);
});

test("table width uses exact column widths without distributing spare container width", () => {
  assert.equal(gridWidth(["Title", "English"], {}), 56 + 160 + 160 + 36);
  assert.equal(gridWidth(["Title"], { Title: 240, __rownum__: 64 }), 64 + 240 + 36);
});

test("menus anchor at the click and stay inside the actual viewport", () => {
  assert.deepEqual(floatingPosition(120, 80, 240, 320, 1200, 800), { left: 120, top: 80 });
  assert.deepEqual(floatingPosition(980, 600, 240, 320, 1200, 800), { left: 952, top: 472 });
  assert.deepEqual(floatingPosition(-20, -100, 240, 320, 1200, 800), { left: 8, top: 8 });
  assert.deepEqual(floatingPosition(320, 600, 620, 700, 360, 640), { left: 8, top: 8 });
});
