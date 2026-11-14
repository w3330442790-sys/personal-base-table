import { genId, type BaseDoc, type FieldDef, type Row, type ViewDef } from './types';
import { applyView } from '../../webview/src/filter';
import type { StyleMap } from './cell-style';
import { cellStyle, cellStyleHtml } from './cell-style';
import { isFormula } from './formulas';
export interface MergeRegion {
    id: string;
    rowIds: string[];
    fields: string[];
    original: Record<string, Record<string, unknown>>;
    display?: unknown;
}
export interface FormatRule {
    id: string;
    field: string;
    op: string;
    value?: unknown;
    target: 'cell' | 'row';
    color?: string;
    background?: string;
}
export interface GridMetadata {
    frozenRowsByView?: Record<string, string[]>;
    rowHeightsByView?: Record<string, Record<string, number>>;
    duplicateFields?: string[];
    cellStyles?: StyleMap;
    parents?: Record<string, string>;
    collapsed?: string[];
    collapsedByView?: Record<string, string[]>;
    columnGroupsByView?: Record<string, Array<{ id: string; name: string; fields: string[]; collapsed: boolean }>>;
    collapsedGroupsByView?: Record<string, string[]>;
    merges?: MergeRegion[];
    rules?: FormatRule[];
    summary?: {
        completionField?: string;
        numberField?: string;
        operation?: 'sum' | 'average' | 'min' | 'max';
    };
    collapsedGroups?: string[];
}
export function gridMeta(sheet: BaseDoc): GridMetadata {
    const extended = sheet as BaseDoc & {
        personalGrid?: GridMetadata;
    };
    return extended.personalGrid ?? (extended.personalGrid = {});
}
export function readGridMeta(sheet: BaseDoc): GridMetadata { return (sheet as BaseDoc & {
    personalGrid?: GridMetadata;
}).personalGrid ?? {}; }
export function sheetRows(sheet: BaseDoc): Row[] { return sheet.records.map(({ id, ...values }) => ({ id: String(id), values })); }
export function descendants(sheet: BaseDoc, id: string): string[] {
    const parents = readGridMeta(sheet).parents ?? {};
    const result: string[] = [];
    const seen = new Set([id]);
    const visit = (parent: string) => { for (const [child, p] of Object.entries(parents)) {
        if (p === parent && !seen.has(child)) {
            seen.add(child);
            result.push(child);
            visit(child);
        }
    } };
    visit(id);
    return result;
}
export function assignParent(sheet: BaseDoc, parent: string | undefined, children: string[]): void {
    const valid = new Set(sheet.records.map(r => String(r.id)));
    if (parent && !valid.has(parent))
        throw new Error('父行不存在');
    const parents = { ...readGridMeta(sheet).parents };
    for (const child of children) {
        if (!valid.has(child))
            throw new Error('子行不存在');
        if (parent)
            parents[child] = parent;
        else
            delete parents[child];
    }
    for (const child of Object.keys(parents)) {
        const seen = new Set([child]);
        let current = parents[child];
        while (current) {
            if (seen.has(current))
                throw new Error('父子关系不能形成循环');
            seen.add(current);
            current = parents[current];
        }
    }
    for (const merge of readGridMeta(sheet).merges ?? []) {
        if (new Set(merge.rowIds.map(id => parents[id])).size > 1)
            throw new Error('请先取消涉及父子层级变化的合并');
    }
    gridMeta(sheet).parents = parents;
}
/** Keep the first appearance of each group and preserve row order within its bucket. */
export function groupRows<T extends Row>(rows: T[], field?: string): T[] {
    if (!field) return rows;
    const buckets = new Map<string, T[]>();
    for (const row of rows) {
        const value = row.values[field];
        const key = Array.isArray(value) ? value.join(',') : String(value ?? '');
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key)!.push(row);
    }
    return [...buckets.values()].flat();
}
export interface DerivedRow extends Row { contextOnly?: boolean; }
export function deriveRows(sheet: BaseDoc, view: ViewDef): DerivedRow[] {
    const all = sheetRows(sheet);
    const meta = readGridMeta(sheet);
    const parents = meta.parents ?? {};
    const collapsed = new Set(meta.collapsedByView?.[view.name] ?? meta.collapsed ?? []);
    const matched = new Set(applyView(all, view, sheet.fields).map(r => r.id));
    const keep = new Set(matched);
    const expanded = new Set<string>();
    for (const id of matched) {
        let current: string | undefined = id;
        while (current !== undefined && !expanded.has(current)) {
            expanded.add(current);
            const parent: string | undefined = parents[current];
            if (parent) keep.add(parent);
            current = parent || undefined;
        }
    }
    const byId = new Map(all.map(r => [r.id, r]));
    // Build sibling buckets once instead of rescanning every row for each node.
    const children = new Map<string | undefined, Row[]>();
    for (const row of all) {
        if (!keep.has(row.id)) continue;
        const candidate = parents[row.id];
        const parent = candidate && byId.has(candidate) ? candidate : undefined;
        let siblings = children.get(parent);
        if (!siblings) children.set(parent, siblings = []);
        siblings.push(row);
    }
    const result: DerivedRow[] = [];
    const seen = new Set<string>();
    const sortedChildren = (parent?: string) => applyView(children.get(parent) ?? [], { name: view.name, sorts: view.sorts }, sheet.fields);
    // Iterators keep preorder traversal without consuming the JS call stack.
    const stack = [sortedChildren()[Symbol.iterator]()];
    while (stack.length) {
        const next = stack[stack.length - 1].next();
        if (next.done) {
            stack.pop();
            continue;
        }
        const row = next.value;
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        result.push({ ...row, contextOnly: !matched.has(row.id) });
        if (!collapsed.has(row.id) && children.has(row.id))
            stack.push(sortedChildren(row.id)[Symbol.iterator]());
    }
    return result;
}
export function insertRows(sheet: BaseDoc, anchor: string | undefined, side: 'above' | 'below', count = 1, duplicate = false): string[] {
    if (!Number.isInteger(count) || count < 1 || count > 10000)
        throw new Error('行数须为 1 到 10000');
    const index = sheet.records.findIndex(r => r.id === anchor);
    if (anchor && index < 0)
        throw new Error('目标行不存在');
    const source = index >= 0 ? sheet.records[index] : undefined;
    const added = Array.from({ length: count }, () => ({ ...(duplicate && source ? structuredClone(source) : {}), id: genId() }));
    sheet.records.splice(index < 0 ? sheet.records.length : index + (side === 'below' ? 1 : 0), 0, ...added);
    const parent = anchor && readGridMeta(sheet).parents?.[anchor];
    const sourceStyle = anchor && readGridMeta(sheet).cellStyles?.[anchor];
    if (duplicate && sourceStyle) for (const row of added) (gridMeta(sheet).cellStyles ??= {})[row.id] = structuredClone(sourceStyle);
    if (parent)
        assignParent(sheet, parent, added.map(r => r.id));
    return added.map(r => r.id);
}
export function deleteRows(sheet: BaseDoc, ids: string[], subtree: boolean): void {
    const remove = new Set(ids);
    if (subtree)
        for (const id of ids)
            descendants(sheet, id).forEach(child => remove.add(child));
    const meta = gridMeta(sheet);
    for (const merge of [...meta.merges ?? []])
        if (merge.rowIds.some(id => remove.has(id)))
            unmergeCells(sheet, merge.id, false);
    const parents = { ...meta.parents };
    for (const child of Object.keys(parents)) {
        const seen = new Set<string>();
        while (remove.has(parents[child]) && !seen.has(parents[child])) {
            seen.add(parents[child]);
            parents[child] = meta.parents?.[parents[child]] as string;
        }
        if (remove.has(child) || !parents[child])
            delete parents[child];
    }
    meta.parents = parents;
    meta.collapsed = meta.collapsed?.filter(id => !remove.has(id));
    if (meta.frozenRowsByView) for (const view of Object.keys(meta.frozenRowsByView)) meta.frozenRowsByView[view] = meta.frozenRowsByView[view].filter(id => !remove.has(id));
    if (meta.rowHeightsByView) for (const heights of Object.values(meta.rowHeightsByView)) for (const id of remove) delete heights[id];
    for (const id of remove) if (meta.cellStyles) delete meta.cellStyles[id];
    for (const [view, collapsed] of Object.entries(meta.collapsedByView ?? {})) meta.collapsedByView![view] = collapsed.filter(id => !remove.has(id));
    sheet.records = sheet.records.filter(r => !remove.has(String(r.id)));
}
export function moveSubtree(sheet: BaseDoc, id: string, before: string): void {
    const moving = new Set([id, ...descendants(sheet, id)]);
    if (moving.has(before))
        return;
    if ((readGridMeta(sheet).merges ?? []).some(m => m.rowIds.length > 1 && m.rowIds.some(r => moving.has(r))))
        throw new Error('请先取消涉及移动行的纵向合并');
    if (readGridMeta(sheet).parents?.[id] !== readGridMeta(sheet).parents?.[before])
        throw new Error('请在同级节点间移动');
    const block = sheet.records.filter(r => moving.has(String(r.id)));
    const rest = sheet.records.filter(r => !moving.has(String(r.id)));
    const target = rest.findIndex(r => r.id === before);
    if (target < 0)
        throw new Error('目标行不存在');
    rest.splice(target, 0, ...block);
    sheet.records = rest;
}
export function leafSummary(sheet: BaseDoc, id: string): {
    count: number;
    descendants: number;
    complete: number;
    number?: number;
} {
    const meta = readGridMeta(sheet);
    const children = descendants(sheet, id);
    const parentSet = new Set(Object.values(meta.parents ?? {}));
    const leaves = sheet.records.filter(r => children.includes(String(r.id)) && !parentSet.has(String(r.id)));
    const config = meta.summary ?? {};
    const numbers = leaves.map(r => config.numberField ? r[config.numberField] : undefined).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    let number: number | undefined;
    if (numbers.length) {
        switch (config.operation) {
            case 'average':
                number = numbers.reduce((a, b) => a + b, 0) / numbers.length;
                break;
            case 'min':
                number = Math.min(...numbers);
                break;
            case 'max':
                number = Math.max(...numbers);
                break;
            default: number = numbers.reduce((a, b) => a + b, 0);
        }
    }
    return { count: leaves.length, descendants: children.length, complete: leaves.filter(r => config.completionField && (r[config.completionField] === true || ['已完成', '完成', 'Done', 'done'].includes(String(r[config.completionField])))).length, number };
}
/** Axis order defaults to storage order. A grid supplies its visible order for a filtered rectangle. */
export function mergeCells(sheet: BaseDoc, rowIds: string[], fields: string[], join = false,
    visibleRowIds = sheet.records.map(row => String(row.id)), visibleFields = Object.keys(sheet.fields)): void {
    if (!rowIds.length || !fields.length || rowIds.length * fields.length < 2)
        throw new Error('请选择至少两个单元格');
    if (!consecutiveAxis(rowIds, visibleRowIds) || !consecutiveAxis(fields, visibleFields))
        throw new Error('合并区域必须是当前视图中的连续矩形');
    const records = new Map(sheet.records.map(r => [String(r.id), r]));
    if (new Set(rowIds).size !== rowIds.length || rowIds.some(id => !records.has(id)) || fields.some(f => !sheet.fields[f]))
        throw new Error('合并区域无效');
    const meta = readGridMeta(sheet);
    if (new Set(rowIds.map(id => meta.parents?.[id])).size > 1)
        throw new Error('不能跨父子层级合并');
    if (meta.merges?.some(m => m.rowIds.some(id => rowIds.includes(id)) && m.fields.some(f => fields.includes(f))))
        throw new Error('合并区域重叠');
    const original: MergeRegion['original'] = {};
    for (const id of rowIds) {
        original[id] = {};
        for (const f of fields) {
            if (Object.prototype.hasOwnProperty.call(records.get(id)!, f))
                original[id][f] = structuredClone(records.get(id)![f]);
        }
    }
    const display = join ? rowIds.flatMap(id => fields.map(f => original[id][f])).filter(v => v != null && v !== '').join('\n') : original[rowIds[0]][fields[0]];
    (gridMeta(sheet).merges ??= []).push({ id: genId(), rowIds: [...rowIds], fields: [...fields], original, display });
}
function consecutiveAxis(selected: string[], order: string[]): boolean {
    if (!selected.length || new Set(selected).size !== selected.length) return false;
    const start = order.indexOf(selected[0]);
    return start >= 0 && selected.every((value, index) => order[start + index] === value);
}
export function selectionClipboard(sheet: BaseDoc, rows: Row[], fields: string[]): { plain: string; html: string } {
    const rowIds = rows.map(row => row.id);
    const merges = (readGridMeta(sheet).merges ?? []).filter(merge => consecutiveAxis(merge.rowIds, rowIds) && consecutiveAxis(merge.fields, fields));
    const stringify = (value: unknown) => Array.isArray(value) ? value.join(',') : String(value ?? '');
    const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\n/g, '<br>');
    const matrix: string[][] = [];
    const htmlRows: string[] = [];
    for (const row of rows) {
        const values: string[] = [];
        const cells: string[] = [];
        for (const field of fields) {
            const merge = merges.find(region => region.rowIds.includes(row.id) && region.fields.includes(field));
            const origin = merge && merge.rowIds[0] === row.id && merge.fields[0] === field;
            const value = merge ? (origin ? stringify(merge.display) : '') : stringify(row.values[field]);
            values.push(/[\t\n\r"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
            const style = cellStyleHtml(cellStyle(sheet, row.id, field));
            if (!merge) cells.push(`<td${style ? ` style="${style}"` : ''}>${escape(value)}</td>`);
            else if (origin) cells.push(`<td rowspan="${merge.rowIds.length}" colspan="${merge.fields.length}"${style ? ` style="${style}"` : ''}>${escape(value)}</td>`);
        }
        matrix.push(values);
        htmlRows.push(`<tr>${cells.join('')}</tr>`);
    }
    return { plain: matrix.map(row => row.join('\t')).join('\r\n'), html: `<table>${htmlRows.join('')}</table>` };
}
export function unmergeCells(sheet: BaseDoc, id: string, keepDisplay = false): void {
    const meta = gridMeta(sheet);
    const merge = meta.merges?.find(m => m.id === id);
    if (!merge)
        return;
    const keptValue = keepDisplay ? typedValue(merge.display, sheet.fields[merge.fields[0]] ?? { type: 'text' }) : undefined;
    for (const row of sheet.records) {
        const original = merge.original[String(row.id)];
        if (!original)
            continue;
        for (const field of merge.fields) {
            if (Object.prototype.hasOwnProperty.call(original, field))
                row[field] = structuredClone(original[field]);
            else
                delete row[field];
        }
    }
    if (keepDisplay) {
        const first = sheet.records.find(r => r.id === merge.rowIds[0]);
        if (first)
            first[merge.fields[0]] = keptValue;
    }
    meta.merges = meta.merges!.filter(m => m.id !== id);
}
export function parseDelimited(text: string, delimiter: string): string[][] {
    if (!delimiter || delimiter.length !== 1 || /["\r\n]/.test(delimiter))
        throw new Error('分隔符无效');
    const rows: string[][] = [];
    let row: string[] = [], value = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (char === '"' && (quoted || value === '')) {
            if (quoted && text[i + 1] === '"') {
                value += '"';
                i++;
            }
            else
                quoted = !quoted;
        }
        else if (!quoted && (char === delimiter || char === '\n' || char === '\r')) {
            row.push(value);
            value = '';
            if (char !== delimiter) {
                rows.push(row);
                row = [];
                if (char === '\r' && text[i + 1] === '\n')
                    i++;
            }
        }
        else
            value += char;
    }
    if (quoted)
        throw new Error('引号未闭合');
    if (value !== '' || row.length || !rows.length) {
        row.push(value);
        rows.push(row);
    }
    return rows;
}

export function parseTSV(text: string): string[][] {
    return parseDelimited(text, '\t');
}
export function typedValue(raw: unknown, def: FieldDef): unknown {
    if (raw == null || raw === '')
        return null;
    if (isFormula(raw) && !['checkbox', 'select', 'multi'].includes(def.type)) return String(raw);
    const text = String(raw);
    switch (def.type) {
        case 'number': {
            let numeric = text.trim();
            const percent = def.numberStyle === 'percent' && numeric.endsWith('%');
            if (percent) numeric = numeric.slice(0, -1).trim();
            if (def.numberStyle === 'currency') {
                const currency = def.currency || '¥';
                if (numeric.startsWith(currency)) numeric = numeric.slice(currency.length).trim();
            }
            if (!/^[+-]?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(numeric))
                throw new Error('需要有效数字，千位分隔须为三位一组');
            const n = Number(numeric.replace(/,/g, ''));
            if (!Number.isFinite(n)) throw new Error('需要有效数字');
            return percent ? n / 100 : n;
        }
        case 'checkbox':
            if (['true', '1', '✓', '是'].includes(text.toLowerCase()))
                return true;
            if (['false', '0', '否'].includes(text.toLowerCase()))
                return false;
            throw new Error('需要 true 或 false');
        case 'date': {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(text)) || new Date(text).toISOString().slice(0, 10) !== text)
                throw new Error('日期格式为 YYYY-MM-DD');
            return text;
        }
        case 'select':
            if (!def.options?.includes(text))
                throw new Error('选项不存在');
            return text;
        case 'multi': {
            const values = Array.isArray(raw) ? raw.map(String) : text.split(/[,，]/).map(s => s.trim()).filter(Boolean);
            if (values.some(v => !def.options?.includes(v)))
                throw new Error('多选选项不存在');
            return values;
        }
        default: return text;
    }
}
export interface PastePlan {
    updates: {
        id: string;
        field: string;
        value: unknown;
    }[];
    newRows: string[];
    newFields: string[];
    errors: string[];
}
export function planPaste(sheet: BaseDoc, visibleIds: string[], cols: string[], startRow: number, startCol: number, matrix: unknown[][], expandColumns = false): PastePlan {
    const plan: PastePlan = { updates: [], newRows: [], newFields: [], errors: [] };
    const targets = [...visibleIds];
    const fields = [...cols];
    const width = Math.max(0, ...matrix.map(row => row.length));
    while (fields.length < startCol + width) {
        let name = `粘贴列 ${fields.length + 1}`;
        while (sheet.fields[name] || fields.includes(name))
            name += '_';
        fields.push(name);
        plan.newFields.push(name);
    }
    if (plan.newFields.length && !expandColumns)
        plan.errors.push('超出列边界，请勾选新增文本列');
    while (targets.length < startRow + matrix.length) {
        const id = genId();
        targets.push(id);
        plan.newRows.push(id);
    }
    matrix.forEach((row, ri) => row.forEach((raw, ci) => {
        const id = targets[startRow + ri], field = fields[startCol + ci];
        if (readGridMeta(sheet).merges?.some(m => m.rowIds.includes(id) && m.fields.includes(field))) {
            plan.errors.push(`第 ${ri + 1} 行 ${field} 涉及合并，请先取消合并`);
            return;
        }
        try {
            plan.updates.push({ id, field, value: typedValue(raw, sheet.fields[field] ?? { type: 'text' }) });
        }
        catch (error) {
            plan.errors.push(`第 ${ri + 1} 行 ${field} ${String((error as Error).message)}`);
        }
    }));
    return plan;
}
export function applyPaste(sheet: BaseDoc, plan: PastePlan): void {
    if (plan.errors.length)
        throw new Error(plan.errors.join('\n'));
    const existingIds = new Set(sheet.records.map(row => String(row.id)));
    if (new Set(plan.newRows).size !== plan.newRows.length || plan.newRows.some(id => existingIds.has(id)) || plan.newFields.some(field => sheet.fields[field]))
        throw new Error('粘贴目标已变化，请重新预览');
    for (const update of plan.updates) {
        const def = sheet.fields[update.field] ?? { type: 'text' as const };
        if (JSON.stringify(typedValue(update.value, def)) !== JSON.stringify(update.value))
            throw new Error('粘贴字段类型已变化，请重新预览');
        if (readGridMeta(sheet).merges?.some(merge => merge.rowIds.includes(update.id) && merge.fields.includes(update.field)))
            throw new Error('粘贴目标已合并，请重新预览');
    }
    const allowedIds = new Set([...existingIds, ...plan.newRows]);
    if (plan.updates.some(u => !allowedIds.has(u.id) || (!sheet.fields[u.field] && !plan.newFields.includes(u.field))))
        throw new Error('粘贴目标已变化，请重新预览');
    for (const field of plan.newFields)
        sheet.fields[field] = { type: 'text' };
    sheet.records.push(...plan.newRows.map(id => ({ id })));
    const records = new Map(sheet.records.map(r => [String(r.id), r]));
    for (const update of plan.updates)
        records.get(update.id)![update.field] = structuredClone(update.value);
}
export function fillCells(sheet: BaseDoc, ids: string[], fields: string[], value: unknown): void {
    const plan = planPaste(sheet, ids, fields, 0, 0, ids.map(() => fields.map(() => value)));
    applyPaste(sheet, plan);
}
export function conditionalStyle(sheet: BaseDoc, row: Row, field: string): {
    color?: string;
    background?: string;
} {
    const style: {
        color?: string;
        background?: string;
    } = {};
    for (const rule of readGridMeta(sheet).rules ?? []) {
        if ((rule.target === 'row' || rule.field === field) && applyView([row], { name: 'rule', filters: [rule] }, sheet.fields).length) {
            if (rule.color)
                style.color = rule.color;
            if (rule.background)
                style.background = rule.background;
        }
    }
    return style;
}

export function createColumnGroup(sheet: BaseDoc, viewId: string, name: string, fields: string[]): void {
    if (!name.trim() || fields.length < 2 || new Set(fields).size !== fields.length || fields.some(field => !sheet.fields[field])) throw new Error('请命名并选择至少两个有效列');
    const meta = gridMeta(sheet);
    const groups = meta.columnGroupsByView?.[viewId] ?? [];
    if (groups.some(group => group.fields.some(field => fields.includes(field)))) throw new Error('列组不能重叠');
    (meta.columnGroupsByView ??= {})[viewId] = [...groups, { id: genId(), name: name.trim(), fields: [...fields], collapsed: false }];
}
export function visibleGroupColumns(sheet: BaseDoc, viewId: string, columns: string[]): string[] {
    const groups = readGridMeta(sheet).columnGroupsByView?.[viewId] ?? [];
    const hidden = new Set(groups.filter(group => group.collapsed).flatMap(group => group.fields.filter(field => columns.includes(field)).slice(1)));
    return columns.filter(field => !hidden.has(field));
}
