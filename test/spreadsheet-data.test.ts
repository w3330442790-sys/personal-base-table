import test from 'node:test';
import assert from 'node:assert/strict';
import type { BaseDoc } from '../src/core/types';
import { cellStyle, formatCells } from '../src/core/cell-style';
import { assignParent, gridMeta, mergeCells, sheetRows } from '../src/core/features';
import { applySelectivePaste, buildSelectivePaste, decodeCellClipboard, encodeCellClipboard, findDuplicateRows, makeCellClipboard, removeDuplicates } from '../src/core/spreadsheet-data';

const make = (): BaseDoc => ({ fields: { title: { type: 'text' }, n: { type: 'number' } }, views: [{ name: 'All' }], records: [{ id: 'a', title: 'A', n: 1 }, { id: 'b', title: 'B', n: 2 }, { id: 'c', title: 'C', n: 3 }] });

test('formats-only bypasses value conversion and replaces complete styles without field conversion', () => {
    const sheet = make(); formatCells(sheet, ['a'], ['n'], { italic: true, bold: true });
    const fields = structuredClone(sheet.fields), records = structuredClone(sheet.records);
    const plan = buildSelectivePaste(sheet, ['a', 'b', 'c'], ['title', 'n'], 0, 1, [['not numeric']], 'formats', [[{ underline: true }]]);
    applySelectivePaste(sheet, plan);
    assert.deepEqual(sheet.records, records); assert.deepEqual(sheet.fields, fields);
    assert.deepEqual(cellStyle(sheet, 'a', 'n'), { underline: true });
    applySelectivePaste(sheet, buildSelectivePaste(sheet, ['a'], ['n'], 0, 0, [['']], 'formats', [[{}]]));
    assert.deepEqual(cellStyle(sheet, 'a', 'n'), {});
});

test('values-only preserves styles, while all applies both values and complete source styles', () => {
    const sheet = make(); formatCells(sheet, ['a'], ['n'], { italic: true });
    applySelectivePaste(sheet, buildSelectivePaste(sheet, ['a'], ['n'], 0, 0, [['42']], 'values', [[{ bold: true }]]));
    assert.equal(sheet.records[0].n, 42); assert.deepEqual(cellStyle(sheet, 'a', 'n'), { italic: true });
    applySelectivePaste(sheet, buildSelectivePaste(sheet, ['a'], ['n'], 0, 0, [['7']], 'all', [[{ bold: true }]]));
    assert.equal(sheet.records[0].n, 7); assert.deepEqual(cellStyle(sheet, 'a', 'n'), { bold: true });
});

test('selective paste rejects invalid values, stale previews, merges and malformed styles atomically', () => {
    const sheet = make(), before = structuredClone(sheet);
    assert.throws(() => applySelectivePaste(sheet, buildSelectivePaste(sheet, ['a'], ['title', 'n'], 0, 0, [['changed', 'bad']], 'all', [[{ bold: true }, {}]])));
    assert.deepEqual(sheet, before);
    const stale = buildSelectivePaste(sheet, ['a'], ['title'], 0, 0, [['changed']], 'values');
    sheet.records[0].n = 99;
    assert.throws(() => applySelectivePaste(sheet, stale)); assert.equal(sheet.records[0].title, 'A');
    mergeCells(sheet, ['a'], ['title', 'n']);
    const merged = structuredClone(sheet);
    assert.throws(() => applySelectivePaste(sheet, buildSelectivePaste(sheet, ['a'], ['title'], 0, 0, [['x']], 'formats', [[{ bold: true }]])));
    assert.deepEqual(sheet, merged);
    const plain = make(), original = structuredClone(plain);
    const corrupt = buildSelectivePaste(plain, ['a'], ['title'], 0, 0, [['changed']], 'all', [[{ bold: true }]]);
    corrupt.styleUpdates.push({ id: 'missing', field: 'title', style: {} });
    assert.throws(() => applySelectivePaste(plain, corrupt)); assert.deepEqual(plain, original);
});

test('format paste can append rows but column expansion requires opt-in', () => {
    const sheet = make();
    applySelectivePaste(sheet, buildSelectivePaste(sheet, ['a'], ['n'], 1, 0, [['bad']], 'formats', [[{ bold: true }]]));
    const added = sheet.records.at(-1)!;
    assert.equal(sheet.records.length, 4); assert.equal(Object.hasOwn(added, 'n'), false); assert.deepEqual(cellStyle(sheet, String(added.id), 'n'), { bold: true });
    const rejected = buildSelectivePaste(sheet, ['a'], ['n'], 0, 0, [['x', 'y']], 'formats', [[{}, {}]]);
    assert.ok(rejected.errors.length);
    applySelectivePaste(sheet, buildSelectivePaste(sheet, ['a'], ['n'], 0, 0, [['x', 'y']], 'formats', [[{}, { italic: true }]], true));
    assert.equal(Object.keys(sheet.fields).length, 3); assert.equal(sheet.records[0].n, 1);
});

test('custom clipboard preserves raw typed values and sanitizes payload dimensions and styles', () => {
    const sheet = make(); formatCells(sheet, ['a'], ['n'], { bold: true });
    const clipboard = makeCellClipboard(sheet, sheetRows(sheet).slice(0, 1), ['title', 'n']);
    const restored = decodeCellClipboard(encodeCellClipboard(clipboard));
    assert.deepEqual(restored?.values, [['A', 1]]); assert.deepEqual(restored?.styles, [[{}, { bold: true }]]);
    assert.equal(decodeCellClipboard(JSON.stringify({ ...clipboard, rowCount: 2 })), null);
    assert.equal(decodeCellClipboard(JSON.stringify({ ...clipboard, styles: [[{}, { color: 'url(evil)' }]] })), null);
    assert.equal((decodeCellClipboard(JSON.stringify({ ...clipboard, styles: [[{}, { color: '#abc' }]] }))?.styles[0][1] as { color?: string })?.color, '#abc');
    clipboard.styles[0][1].bold = false; assert.deepEqual(cellStyle(sheet, 'a', 'n'), { bold: true });
    sheet.records[0].n = '=1+1';
    const formulaClipboard = makeCellClipboard(sheet, [{ id: 'a', values: { n: 2 } }], ['n']);
    assert.equal(formulaClipboard.values[0][0], '=1+1');
    assert.equal(formulaClipboard.evaluatedValues?.[0][0], 2);
    assert.deepEqual(decodeCellClipboard(encodeCellClipboard(formulaClipboard))?.evaluatedValues, [[2]]);
    assert.equal(decodeCellClipboard(JSON.stringify({ ...formulaClipboard, evaluatedValues: [[2, 3]] })), null);
});

test('duplicate comparison is typed, structural, blank-equivalent, scoped and stable', () => {
    const sheet = make(); sheet.fields.extra = { type: 'text' };
    sheet.records = [{ id: 'a', title: null, extra: { a: 1, b: [2] } }, { id: 'b', title: '', extra: { b: [2], a: 1 } }, { id: 'c', extra: { a: 1, b: [2] } }, { id: 'd', title: 1 }, { id: 'e', title: '1' }];
    assert.deepEqual(findDuplicateRows(sheet, ['title', 'extra']), { groups: [['a', 'b', 'c']], duplicateIds: ['b', 'c'] });
    assert.deepEqual(findDuplicateRows(sheet, ['title'], ['c', 'b']).groups, [['b', 'c']]);
    assert.throws(() => findDuplicateRows(sheet, [])); assert.throws(() => findDuplicateRows(sheet, ['missing']));
});

test('duplicate removal preserves first row and promotes surviving descendants of removed parents', () => {
    const sheet = make(); sheet.records[1].title = 'A';
    assignParent(sheet, 'a', ['b']); assignParent(sheet, 'b', ['c']);
    assert.equal(removeDuplicates(sheet, ['title']), 1);
    assert.deepEqual(sheet.records.map(row => row.id), ['a', 'c']); assert.equal(gridMeta(sheet).parents?.c, 'a');
});

test('duplicates compare calculated formula values', () => {
    const sheet = make(); sheet.records[0].n = '=1+1';
    assert.deepEqual(findDuplicateRows(sheet, ['n']).duplicateIds, ['b']);
});
