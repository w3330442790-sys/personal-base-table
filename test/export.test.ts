import { test } from "node:test";
import assert from "node:assert/strict";
import { toMarkdown } from "../webview/src/export";

test("toMarkdown emits a readable table and escapes pipes and newlines", () => {
  const rows = [
    { id: "r1", values: { 标题: "A|B", 备注: "第一行\n第二行" } },
    { id: "r2", values: { 标题: "C", 备注: "" } },
  ];
  const md = toMarkdown(["标题", "备注"], rows);
  assert.equal(md, "| 标题 | 备注 |\n| --- | --- |\n| A\\|B | 第一行<br>第二行 |\n| C |  |\n");
});
