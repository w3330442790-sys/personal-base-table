import { test } from "node:test";
import assert from "node:assert/strict";
import { safeExternalHref } from "../webview/src/url";

test("safeExternalHref allows only explicit web and mail schemes", () => {
  assert.equal(safeExternalHref("https://example.com/a?b=1"), "https://example.com/a?b=1");
  assert.equal(safeExternalHref("http://example.com"), "http://example.com");
  assert.equal(safeExternalHref("mailto:someone@example.com"), "mailto:someone@example.com");
});

test("safeExternalHref blocks script, data, file and relative values", () => {
  for (const value of [
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "obsidian://open?vault=x",
    "notes/relative",
    " https://example.com\u0000.evil",
    "",
    null,
    42,
  ]) {
    assert.equal(safeExternalHref(value), undefined);
  }
});
