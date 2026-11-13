import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visibleWorkbookHeight } from '../webview/src/tablet-viewport';

test('tablet keyboard limits workbook to visible viewport and preserves split panes', () => {
  assert.equal(visibleWorkbookHeight(100, 900, { top: 0, height: 600 }), 500);
  assert.equal(visibleWorkbookHeight(100, 350, { top: 0, height: 1000 }), 350);
  const pannedHeight = visibleWorkbookHeight(100, 900, { top: 200, height: 500 });
  assert.equal(pannedHeight, 600);
  assert.equal(100 + pannedHeight, 200 + 500);
  assert.equal(visibleWorkbookHeight(800, 200, { top: 0, height: 600 }), 0);
});
