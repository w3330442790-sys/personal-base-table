import { test } from "node:test";
import assert from "node:assert/strict";
import { rowHeaderWidth, gridWidth } from "../webview/src/grid-layout";
import { floatingPosition, visibleOwnerBounds, visibleViewport } from "../webview/src/floating";

test("row header stays compact and keeps a saved drag width", () => {
  assert.equal(rowHeaderWidth({}), 56);
  assert.equal(rowHeaderWidth({ __rownum__: 74 }), 74);
  assert.equal(rowHeaderWidth({ __rownum__: 8 }), 44);
  assert.equal(rowHeaderWidth({ __rownum__: 900 }), 160);
  assert.equal(rowHeaderWidth({ __rownum__: NaN }), 56);
});

test("keyboard viewport keeps menus above the keyboard including viewport pan offsets", () => {
  assert.deepEqual(floatingPosition(700, 700, 240, 280, 800, 360, 40, 120), { left: 592, top: 192 });
  assert.deepEqual(floatingPosition(0, 0, 900, 700, 800, 360, 40, 120), { left: 48, top: 128 });
});

test("visible viewport uses visualViewport and falls back for desktop", () => {
  assert.deepEqual(visibleViewport({ innerWidth: 1200, innerHeight: 800, visualViewport: null }), { left: 0, top: 0, width: 1200, height: 800 });
  assert.deepEqual(visibleViewport({ innerWidth: 1200, innerHeight: 800, visualViewport: { offsetLeft: 30, offsetTop: 150, width: 800, height: 320 } }), { left: 30, top: 150, width: 800, height: 320 });
});

test("feature panel bounds intersect the visible owner and account for its page position", () => {
  assert.deepEqual(visibleOwnerBounds({ left: 200, top: 100, width: 900, height: 700 }, { left: 40, top: 180, width: 800, height: 360 }), { left: 0, top: 80, width: 640, height: 360 });
  assert.deepEqual(visibleOwnerBounds({ left: -100, top: -50, width: 600, height: 600 }, { left: 0, top: 0, width: 800, height: 400 }), { left: 100, top: 50, width: 500, height: 400 });
  assert.deepEqual(visibleOwnerBounds({ left: 900, top: 800, width: 200, height: 100 }, { left: 0, top: 0, width: 800, height: 400 }), { left: 0, top: 0, width: 0, height: 0 });
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
