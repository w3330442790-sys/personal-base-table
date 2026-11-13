import test from 'node:test';
import assert from 'node:assert/strict';
import { calculatedSheet, columnLabel, evaluateCell, isFormula, rebaseFormulas, translateFormula } from '../src/core/formulas';
import type { BaseDoc } from '../src/core/types';
import { gridMeta, insertRows, mergeCells, unmergeCells } from '../src/core/features';

function sheet(records: Record<string, unknown>[]): BaseDoc {
  return { fields: { 数量: { type: 'number' }, 价格: { type: 'number' }, 结果: { type: 'number' } }, views: [], records };
}
test('safe arithmetic, aggregates, references and literal strings', () => {
  const s = sheet([{ id: 'a', 数量: 2, 价格: 3, 结果: '=SUM(A1:B2)+2^3*2' }, { id: 'b', 数量: 4, 价格: 5 }, { id: 'c', 数量: '=AVERAGE(A1:B2)', 价格: '=COUNTIF(A1:B2;">=3")', 结果: '="say ""hello"" A1"' }]);
  assert.equal(evaluateCell(s, 'a', '结果'), 30);
  assert.equal(evaluateCell(s, 'c', '数量'), 3.5);
  assert.equal(evaluateCell(s, 'c', '价格'), 3);
  assert.equal(evaluateCell(s, 'c', '结果'), 'say "hello" A1');
  assert.equal(isFormula("'=A1"), false);
  assert.equal(columnLabel(26), 'AA');
  const result = calculatedSheet(s);
  assert.equal(result.records[0].结果, 30);
  assert.equal(s.records[0].结果, '=SUM(A1:B2)+2^3*2');
  result.fields.数量.type = 'text';
  assert.equal(s.fields.数量.type, 'number');
});
test('errors, cycle detection, empty aggregates and safety limits', () => {
  const s = sheet([{ id: 'a', 数量: '=B1', 价格: '=A1', 结果: '=1/0' }, { id: 'b', 数量: '=A99', 价格: '=UNKNOWN(1)', 结果: '=SUM(A1:A999999999)' }, { id: 'c', 数量: '=AVERAGE()', 价格: '=SUM()', 结果: '=globalThis.process()' }]);
  assert.equal(evaluateCell(s, 'a', '数量'), '#CYCLE!');
  assert.equal(evaluateCell(s, 'a', '结果'), '#DIV/0!');
  assert.equal(evaluateCell(s, 'b', '数量'), '#REF!');
  assert.equal(evaluateCell(s, 'b', '价格'), '#NAME?');
  assert.equal(evaluateCell(s, 'b', '结果'), '#REF!');
  assert.equal(evaluateCell(s, 'c', '数量'), '#DIV/0!');
  assert.equal(evaluateCell(s, 'c', '价格'), 0);
  assert.equal(evaluateCell(s, 'c', '结果'), '#VALUE!');
});
test('COUNTIF string equality, wildcards and escapes', () => {
  const s = sheet([{ id: 'a', 数量: 'alpha', 价格: '=COUNTIF(A1:A4,"a*")', 结果: '=COUNTIF(A1:A4,"a~*")' }, { id: 'b', 数量: 'Apple' }, { id: 'c', 数量: 'a*' }, { id: 'd', 数量: 'beta' }]);
  assert.equal(evaluateCell(s, 'a', '价格'), 3);
  assert.equal(evaluateCell(s, 'a', '结果'), 1);
  s.records[0].价格 = '=COUNTIF(A1:A4,"<>")';
  assert.equal(evaluateCell(s, 'a', '价格'), 4);
  s.records[0].价格 = '=COUNTIF(A1:A4,A4)';
  assert.equal(evaluateCell(s, 'a', '价格'), 1);
});
test('structural changes follow stable rows and fields, preserve absolutes and literals', () => {
  const before = sheet([{ id: 'a', 数量: 2 }, { id: 'b', 数量: 3 }, { id: 'c', 结果: '=SUM($A$1:A2)+COUNTIF(A1:A2,"A1")' }]);
  const after = structuredClone(before);
  after.records.splice(1, 0, { id: 'new', 数量: 4 });
  rebaseFormulas(before, after);
  assert.equal(after.records[3].结果, '=SUM($A$1:A3)+COUNTIF(A1:A3,"A1")');
  assert.equal(evaluateCell(after, 'c', '结果'), 9);
  const deleted = structuredClone(before);
  deleted.records.splice(0, 1);
  rebaseFormulas(before, deleted);
  assert.match(String(deleted.records[1].结果), /#REF!/);
  const renamed = structuredClone(before);
  renamed.fields = { 新数量: renamed.fields.数量, 价格: renamed.fields.价格, 结果: renamed.fields.结果 };
  rebaseFormulas(before, renamed, { 数量: '新数量' });
  assert.equal(renamed.records[2].结果, before.records[2].结果);
  assert.equal(translateFormula('=$A1+B$2+"A1"', 2, 1), '=$A3+C$2+"A1"');
});
test('large sheets share memoized dependency results', () => {
  const s = sheet(Array.from({ length: 22000 }, (_, i) => ({ id: String(i), 数量: i, 结果: '=A1+1' })));
  assert.equal(calculatedSheet(s).records[21999].结果, 1);
});
test('aggregates ignore referenced text and structural column reorder follows fields', () => {
  const s = sheet([{ id: 'a', 数量: 'text', 价格: 4, 结果: '=SUM(A1,B1,"2")' }, { id: 'b', 结果: '=AVERAGE(A1)' }]);
  assert.equal(evaluateCell(s, 'a', '结果'), 6);
  assert.equal(evaluateCell(s, 'b', '结果'), '#DIV/0!');
  const after = structuredClone(s);
  after.fields = { 价格: after.fields.价格, 结果: after.fields.结果, 数量: after.fields.数量 };
  after.records.reverse();
  rebaseFormulas(s, after);
  assert.equal(after.records[1].结果, '=SUM(C2,A2,"2")');
});
test('Excel exponent and unary precedence', () => {
  const s = sheet([{ id: 'a', 数量: '=2^3^2', 价格: '=-2^2', 结果: '=2^-2' }]);
  assert.equal(evaluateCell(s, 'a', '数量'), 64);
  assert.equal(evaluateCell(s, 'a', '价格'), 4);
  assert.equal(evaluateCell(s, 'a', '结果'), 0.25);
});
test('merged formula backups and display rebase before unmerging', () => {
  const before = sheet([{ id: 'a', 数量: 2 }, { id: 'b', 数量: 3 }, { id: 'c', 结果: '=SUM($A$1:A2)' }, { id: 'd' }]);
  mergeCells(before, ['c', 'd'], ['结果'], false);
  const after = structuredClone(before);
  insertRows(after, 'a', 'above');
  rebaseFormulas(before, after);
  const merged = gridMeta(after).merges![0];
  assert.equal(merged.original.c.结果, '=SUM($A$2:A3)');
  assert.equal(merged.display, '=SUM($A$2:A3)');
  unmergeCells(after, merged.id);
  assert.equal(evaluateCell(after, 'c', '结果'), 5);
});
test('rebasing preserves edited merged display and metadata extensions', () => {
  const before = sheet([{ id: 'a', 数量: 2 }, { id: 'b', 数量: 3 }, { id: 'c', 结果: '=A1' }, { id: 'd' }]);
  mergeCells(before, ['c', 'd'], ['结果'], false);
  const after = structuredClone(before);
  gridMeta(after).merges![0].display = '=A2';
  (gridMeta(after).merges![0] as unknown as Record<string, unknown>).extension = { preserved: true };
  insertRows(after, 'a', 'above');
  rebaseFormulas(before, after);
  assert.equal(gridMeta(after).merges![0].display, '=A2');
  assert.equal(gridMeta(after).merges![0].original.c.结果, '=A2');
  assert.deepEqual((gridMeta(after).merges![0] as unknown as Record<string, unknown>).extension, { preserved: true });
  const next = structuredClone(after);
  next.records.splice(0, 1);
  rebaseFormulas(after, next);
  assert.equal(gridMeta(next).merges![0].display, '=A1');
  assert.equal(gridMeta(next).merges![0].original.c.结果, '=A1');
});
