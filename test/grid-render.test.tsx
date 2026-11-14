import assert from 'node:assert/strict';
import { test } from 'node:test';
import React, { type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WorkbookGrid } from '../webview/src/WorkbookGrid';
import { HostContext, type Host } from '../webview/src/host';
import type { BaseDoc } from '../src/core/types';

const host: Host = { post: () => {}, subscribe: () => () => {} };
const render = (element: ReactNode) => renderToStaticMarkup(<HostContext.Provider value={host}>{element}</HostContext.Provider>);

const sheet: BaseDoc = {
  fields: { 名称: { type: 'text', primary: true } },
  views: [{ name: '全部' }],
  records: [{ id: 'r1', 名称: '第一条' }],
};

const props = {
  sheet,
  rows: [{ id: 'r1', values: { 名称: '第一条' } }],
  cols: ['名称', '新增列'],
  config: { rowHeight: 'medium' as const, showRowNumbers: true, fontSize: 0, colorfulTags: false, wrapText: false },
  colWidths: {},
  transact: () => {},
  onHeaderMenu: () => {},
  onResize: () => {},
  onReorderCols: () => {},
  onAddField: () => {},
  onDetail: () => {},
};

test('a renamed column that the document has not received yet renders as text instead of crashing', () => {
  const markup = render(<WorkbookGrid {...props} />);
  assert.match(markup, /新增列/);
  assert.match(markup, /第一条/);
  assert.doesNotMatch(markup, /personal-grid-error/);
});

test('the grid still renders when the document temporarily lacks a whole column definition', () => {
  const stale = { ...sheet, fields: {}, records: [{ id: 'r1', 名称: '第一条' }] } as BaseDoc;
  const markup = render(<WorkbookGrid {...props} sheet={stale} />);
  assert.match(markup, /名称/);
  assert.match(markup, /第一条/);
});

test('column headers expose a sort cycle and a separate field menu', () => {
  const ascending = render(<WorkbookGrid {...props} sorts={[{ field: '名称', dir: 'asc' }]} onSort={() => {}} />);
  assert.match(ascending, /▲/);
  assert.match(ascending, /personal-header-inner/);
  assert.match(ascending, /personal-header-label/);
  assert.match(ascending, /personal-header-menu/);
  const descending = render(<WorkbookGrid {...props} sorts={[{ field: '名称', dir: 'desc' }]} onSort={() => {}} />);
  assert.match(descending, /▼/);
});
