import type { BaseDoc } from './types';
import type { MergeRegion } from './features';

/** Formula syntax deliberately has no JavaScript execution or property access. */
export function isFormula(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('=');
}
export function columnLabel(index: number): string {
  if (!Number.isSafeInteger(index) || index < 0) return '';
  let label = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) label = String.fromCharCode(65 + (n - 1) % 26) + label;
  return label;
}
type Code = '#REF!' | '#DIV/0!' | '#VALUE!' | '#NAME?' | '#CYCLE!';
class FormulaError extends Error { constructor(readonly code: Code) { super(code); } }
function fail(code: Code): never { throw new FormulaError(code); }
type Address = { row: number; col: number; absRow: boolean; absCol: boolean };
function address(text: string): Address {
  const m = /^(\$?)([A-Za-z]+)(\$?)([0-9]+)$/.exec(text)!;
  let col = 0;
  for (const c of m[2].toUpperCase()) col = col * 26 + c.charCodeAt(0) - 64;
  return { row: Number(m[4]) - 1, col: col - 1, absRow: !!m[3], absCol: !!m[1] };
}
function formatAddress(a: Address): string {
  if (!Number.isSafeInteger(a.row) || !Number.isSafeInteger(a.col) || a.row < 0 || a.col < 0) return '#REF!';
  return `${a.absCol ? '$' : ''}${columnLabel(a.col)}${a.absRow ? '$' : ''}${a.row + 1}`;
}
type Token = { kind: string; text: string; start: number; end: number };
function lex(source: string): Token[] {
  if (source.length > 8192) fail('#VALUE!');
  const tokens: Token[] = [];
  let i = 1;
  while (i < source.length) {
    if (/\s/.test(source[i])) { i++; continue; }
    const start = i;
    if (source[i] === '"') {
      i++;
      let closed = false;
      while (i < source.length) {
        if (source[i++] !== '"') continue;
        if (source[i] === '"') { i++; continue; }
        closed = true; break;
      }
      if (!closed) fail('#VALUE!');
      tokens.push({ kind: 'string', text: source.slice(start, i), start, end: i });
      continue;
    }
    const rest = source.slice(i);
    const error = /^(#REF!|#DIV\/0!|#VALUE!|#NAME\?|#CYCLE!)/i.exec(rest);
    const ref = /^\$?[A-Za-z]+\$?[0-9]+(?![A-Za-z0-9_])/.exec(rest);
    const num = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(rest);
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
    const match = error || ref || num || name;
    if (match) {
      i += match[0].length;
      tokens.push({ kind: error ? 'error' : ref ? 'ref' : num ? 'number' : 'name', text: match[0], start, end: i });
    } else if ('+-*/^():,;'.includes(source[i])) {
      i++; tokens.push({ kind: source[start], text: source[start], start, end: i });
    } else fail('#VALUE!');
    if (tokens.length > 4096) fail('#VALUE!');
  }
  tokens.push({ kind: 'end', text: '', start: i, end: i });
  return tokens;
}
type Value = unknown;
function numeric(v: Value): number {
  if (Array.isArray(v) || (typeof v === 'object' && v !== null)) fail('#VALUE!');
  if (v === null || v === undefined || v === '') return 0;
  const n = typeof v === 'boolean' ? Number(v) : Number(v);
  return Number.isFinite(n) ? n : fail('#VALUE!');
}
function finite(n: number): number { return Number.isFinite(n) ? n : fail('#VALUE!'); }
function criteriaMatch(value: unknown, criterion: unknown): boolean {
  if (typeof criterion === 'number') return (typeof value === 'number' || typeof value === 'string' && value.trim() !== '') && Number(value) === criterion;
  const text = String(criterion ?? '');
  const m = /^(<=|>=|<>|=|<|>)(.*)$/.exec(text);
  const op = m?.[1] ?? '=';
  const target = m?.[2] ?? text;
  if (target.trim() !== '' && Number.isFinite(Number(target))) {
    const n = (value === '' || value == null) ? 0 : typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
    const t = Number(target);
    if (!Number.isFinite(n)) return op === '<>';
    return op === '<' ? n < t : op === '>' ? n > t : op === '<=' ? n <= t : op === '>=' ? n >= t : op === '<>' ? n !== t : n === t;
  }
  const pattern: { char: string; wildcard?: boolean }[] = [];
  for (let i = 0; i < target.length; i++) {
    let c = target[i];
    if (c === '~' && i + 1 < target.length) c = target[++i];
    else if (c === '*' || c === '?') { pattern.push({ char: c, wildcard: true }); continue; }
    pattern.push({ char: c.toLowerCase() });
  }
  // Bounded glob matching avoids regular-expression backtracking on hostile criteria.
  const input = String(value ?? '').toLowerCase();
  let p = 0, v = 0, star = -1, restart = 0, steps = 0;
  while (v < input.length) {
    if (++steps > 100_000) fail('#VALUE!');
    const token = pattern[p];
    if (token && (token.wildcard && token.char === '?' || !token.wildcard && token.char === input[v])) { p++; v++; }
    else if (token?.wildcard && token.char === '*') { star = p++; restart = v; }
    else if (star >= 0) { p = star + 1; v = ++restart; }
    else break;
  }
  while (pattern[p]?.wildcard && pattern[p].char === '*') p++;
  const same = v === input.length && p === pattern.length;
  if (op === '=' || op === '<>') return op === '=' ? same : !same;
  const a = String(value ?? '').toLowerCase(), b = target.toLowerCase();
  return op === '<' ? a < b : op === '>' ? a > b : op === '<=' ? a <= b : a >= b;
}
class Context {
  readonly fields: string[];
  readonly ids = new Map<string, number>();
  readonly memo = new Map<string, Value | FormulaError>();
  readonly active = new Set<string>();
  readonly tokens = new Map<string, Token[]>();
  private budget = 2_000_000;
  constructor(readonly sheet: BaseDoc) {
    this.fields = Object.keys(sheet.fields);
    sheet.records.forEach((r, i) => this.ids.set(String(r.id), i));
  }
  spend(n = 1): void { this.budget -= n; if (this.budget < 0) fail('#VALUE!'); }
  valid(a: Address): boolean { return Number.isSafeInteger(a.row) && Number.isSafeInteger(a.col) && a.row >= 0 && a.col >= 0 && a.row < this.sheet.records.length && a.col < this.fields.length; }
  ref(a: Address): Value {
    if (!this.valid(a)) fail('#REF!');
    return this.cell(a.row, a.col);
  }
  cell(row: number, col: number): Value {
    const key = `${row}:${col}`;
    if (this.memo.has(key)) { const v = this.memo.get(key); if (v instanceof FormulaError) throw v; return v; }
    if (this.active.has(key)) fail('#CYCLE!');
    if (this.active.size >= 128) fail('#VALUE!');
    this.spend();
    const raw = this.sheet.records[row][this.fields[col]];
    if (!isFormula(raw)) return raw;
    this.active.add(key);
    try {
      let tokens = this.tokens.get(raw);
      if (!tokens) { tokens = lex(raw); this.tokens.set(raw, tokens); }
      const result = new Parser(tokens, this).parse();
      if (Array.isArray(result)) fail('#VALUE!');
      this.memo.set(key, result);
      return result;
    } catch (err) {
      const e = err instanceof FormulaError ? err : new FormulaError('#VALUE!');
      this.memo.set(key, e); throw e;
    } finally { this.active.delete(key); }
  }
  display(row: number, col: number): Value { try { return this.cell(row, col); } catch (e) { return e instanceof FormulaError ? e.code : '#VALUE!'; } }
}
class Parser {
  private pos = 0;
  private depth = 0;
  constructor(readonly tokens: Token[], readonly ctx: Context) {}
  get current(): Token { return this.tokens[this.pos]; }
  take(kind: string): boolean { if (this.current.kind !== kind) return false; this.pos++; return true; }
  expect(kind: string): void { if (!this.take(kind)) fail('#VALUE!'); }
  parse(): Value { const result = this.expr(); this.expect('end'); return result; }
  expr(min = 0): Value {
    if (++this.depth > 128) fail('#VALUE!');
    this.ctx.spend();
    let value = this.primary();
    const precedence: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2, '^': 3 };
    while ((precedence[this.current.kind] ?? -1) >= min) {
      const op = this.current.kind; this.pos++;
      const rhs = this.expr(precedence[op] + 1);
      const a = numeric(value), b = numeric(rhs);
      if (op === '/' && b === 0) fail('#DIV/0!');
      value = finite(op === '+' ? a + b : op === '-' ? a - b : op === '*' ? a * b : op === '/' ? a / b : a ** b);
    }
    this.depth--;
    return value;
  }
  primary(): Value {
    const t = this.current; this.pos++;
    if (t.kind === '+' || t.kind === '-') return numeric(this.expr(4)) * (t.kind === '-' ? -1 : 1);
    if (t.kind === 'number') return finite(Number(t.text));
    if (t.kind === 'string') return t.text.slice(1, -1).replace(/""/g, '"');
    if (t.kind === 'error') fail(t.text.toUpperCase() as Code);
    if (t.kind === '(') { const v = this.expr(); this.expect(')'); return v; }
    if (t.kind === 'ref') {
      const a = address(t.text);
      if (!this.take(':')) return this.ctx.ref(a);
      if (this.current.kind === 'error') fail('#REF!');
      const b = address(this.current.text); this.expect('ref');
      if (!this.ctx.valid(a) || !this.ctx.valid(b)) fail('#REF!');
      const count = (Math.abs(a.row - b.row) + 1) * (Math.abs(a.col - b.col) + 1);
      if (count > 100_000) fail('#VALUE!');
      this.ctx.spend(count);
      const values: Value[] = [];
      for (let r = Math.min(a.row, b.row); r <= Math.max(a.row, b.row); r++)
        for (let c = Math.min(a.col, b.col); c <= Math.max(a.col, b.col); c++) values.push(this.ctx.cell(r, c));
      return values;
    }
    if (t.kind === 'name') {
      const name = t.text.toUpperCase();
      if (!this.take('(')) { if (name === 'TRUE') return true; if (name === 'FALSE') return false; fail('#NAME?'); }
      if (!['SUM', 'AVERAGE', 'COUNTIF'].includes(name)) fail('#NAME?');
      const args: Value[] = [];
      if (!this.take(')')) {
        do {
          const start = this.pos;
          const value = this.expr();
          // Aggregate functions ignore text/booleans reached via a reference.
          args.push(name !== 'COUNTIF' && this.tokens[start].kind === 'ref' && this.pos === start + 1 ? [value] : value);
        } while (this.take(',') || this.take(';'));
        this.expect(')');
      }
      if (name === 'COUNTIF') {
        if (args.length !== 2 || Array.isArray(args[1])) fail('#VALUE!');
        return (Array.isArray(args[0]) ? args[0] : [args[0]]).filter(v => criteriaMatch(v, args[1])).length;
      }
      const numbers: number[] = [];
      for (const arg of args) {
        if (Array.isArray(arg)) { for (const v of arg) if (typeof v === 'number' && Number.isFinite(v)) numbers.push(v); }
        else if (arg !== undefined && arg !== null && arg !== '') numbers.push(numeric(arg));
      }
      if (name === 'AVERAGE' && !numbers.length) fail('#DIV/0!');
      return finite(numbers.reduce((sum, n) => sum + n, 0) / (name === 'AVERAGE' ? numbers.length : 1));
    }
    return fail('#VALUE!');
  }
}
export function evaluateCell(sheet: BaseDoc, rowId: string, field: string): unknown {
  const ctx = new Context(sheet), row = ctx.ids.get(rowId), col = ctx.fields.indexOf(field);
  return row === undefined || col < 0 ? '#REF!' : ctx.display(row, col);
}
export function calculatedSheet(sheet: BaseDoc): BaseDoc {
  const result: BaseDoc = JSON.parse(JSON.stringify(sheet));
  const ctx = new Context(sheet);
  sheet.records.forEach((record, r) => ctx.fields.forEach((field, c) => {
    if (isFormula(record[field])) result.records[r][field] = ctx.display(r, c);
  }));
  return result;
}
function rewrite(formula: string, convert: (a: Address) => string): string {
  try {
    const refs = lex(formula).filter(t => t.kind === 'ref');
    let result = '', last = 0;
    for (const t of refs) { result += formula.slice(last, t.start) + convert(address(t.text)); last = t.end; }
    return result + formula.slice(last);
  } catch { return formula; }
}
/** Copy/fill translation respects dollar anchors; structural rebasing always follows identities. */
export function translateFormula(formula: string, deltaRow: number, deltaCol: number): string {
  if (!isFormula(formula)) return formula;
  return rewrite(formula, a => formatAddress({ ...a, row: a.row + (a.absRow ? 0 : deltaRow), col: a.col + (a.absCol ? 0 : deltaCol) }));
}
export function rebaseFormulas(before: BaseDoc, after: BaseDoc, fieldRenames: Record<string, string> = {}): void {
  const oldFields = Object.keys(before.fields), newFields = Object.keys(after.fields);
  const oldRows = new Map(before.records.map(r => [String(r.id), r]));
  const newRows = new Map(after.records.map((r, i) => [String(r.id), i]));
  const newCols = new Map(newFields.map((f, i) => [f, i]));
  const reverseNames = new Map(Object.entries(fieldRenames).map(([a, b]) => [b, a]));
  const rebase = (raw: string): string => rewrite(raw, a => {
    const row = before.records[a.row];
    const oldField = oldFields[a.col];
    const r = row && newRows.get(String(row.id));
    const c = oldField === undefined ? undefined : newCols.get(fieldRenames[oldField] ?? oldField);
    return r === undefined || c === undefined ? '#REF!' : formatAddress({ ...a, row: r, col: c });
  });
  for (const record of after.records) {
    const previous = oldRows.get(String(record.id));
    if (!previous) continue;
    for (const field of newFields) {
      const raw = record[field];
      if (!isFormula(raw) || previous[reverseNames.get(field) ?? field] !== raw) continue;
      record[field] = rebase(raw);
    }
  }
  // Merge backups are restored on unmerge, so they must track the same identities
  // as ordinary cells. Display is independently editable: compare its own old value.
  const merges = (sheet: BaseDoc): MergeRegion[] => {
    const meta = sheet.personalGrid as { merges?: MergeRegion[] } | undefined;
    return Array.isArray(meta?.merges) ? meta.merges : [];
  };
  const previousMerges = new Map(merges(before).map(merge => [merge.id, merge]));
  for (const merge of merges(after)) {
    const previous = previousMerges.get(merge.id);
    if (!previous) continue;
    if (isFormula(merge.display) && merge.display === previous.display) merge.display = rebase(merge.display);
    for (const [id, values] of Object.entries(merge.original)) {
      for (const [field, raw] of Object.entries(values)) {
        if (isFormula(raw) && previous.original[id]?.[reverseNames.get(field) ?? field] === raw) values[field] = rebase(raw);
      }
    }
  }
}
