import type { BaseDoc, Row } from './types';
import type { CellStyle } from './cell-style';
import { cellStyle } from './cell-style';
import { applyPaste, deleteRows, planPaste, readGridMeta, type PastePlan } from './features';
import { calculatedSheet } from './formulas';

export const CELL_CLIPBOARD_MIME = 'application/x-personal-base-table+json';
export interface CellClipboard {
    version: 1;
    rowCount: number;
    columnCount: number;
    values: unknown[][];
    /** Calculated results used by paste-values, while values retains formulas. */
    evaluatedValues?: unknown[][];
    styles: CellStyle[][];
    sourceRows?: string[];
    sourceFields?: string[];
}

/** Clipboard formats are complete cell styles, so an empty style clears formatting. */
function cleanStyle(value: unknown): CellStyle {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('剪贴板格式无效');
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of ['bold', 'italic', 'underline', 'strikethrough']) {
        if (source[key] !== undefined && typeof source[key] !== 'boolean') throw new Error('剪贴板格式无效');
        if (source[key] === true) result[key] = true;
    }
    if (source.align !== undefined) {
        if (!['left', 'center', 'right'].includes(String(source.align))) throw new Error('剪贴板对齐格式无效');
        result.align = source.align;
    }
    for (const key of ['color', 'background']) if (source[key] !== undefined) {
        if (typeof source[key] !== 'string' || !/^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(source[key])) throw new Error('剪贴板颜色无效');
        result[key] = source[key];
    }
    return result as CellStyle;
}

export function makeCellClipboard(sheet: BaseDoc, rows: Row[], fields: string[]): CellClipboard {
    if (fields.some(field => !sheet.fields[field]) || rows.some(row => !sheet.records.some(record => String(record.id) === row.id))) throw new Error('复制选区已变化');
    const ids = rows.map(row => row.id);
    const originals = new Map(sheet.records.map(record => [String(record.id), record]));
    const calculated = new Map(calculatedSheet(sheet).records.map(record => [String(record.id), record]));
    const contained = (readGridMeta(sheet).merges ?? []).filter(merge => merge.rowIds.every(id => ids.includes(id)) && merge.fields.every(field => fields.includes(field)));
    return {
        version: 1, rowCount: rows.length, columnCount: fields.length,
        values: rows.map(row => fields.map(field => {
            const merge = contained.find(item => item.rowIds.includes(row.id) && item.fields.includes(field));
            return structuredClone(merge ? merge.rowIds[0] === row.id && merge.fields[0] === field ? merge.display ?? null : null : originals.get(row.id)?.[field] ?? null);
        })),
        evaluatedValues: rows.map(row => fields.map(field => {
            const merge = contained.find(item => item.rowIds.includes(row.id) && item.fields.includes(field));
            return structuredClone(merge ? merge.rowIds[0] === row.id && merge.fields[0] === field ? merge.display ?? null : null : calculated.get(row.id)?.[field] ?? null);
        })),
        styles: rows.map(row => fields.map(field => structuredClone(cellStyle(sheet, row.id, field)))),
        sourceRows: ids, sourceFields: [...fields],
    };
}
export function encodeCellClipboard(value: CellClipboard): string { return JSON.stringify(value); }
export function decodeCellClipboard(raw: string): CellClipboard | null {
    try {
        const value = JSON.parse(raw) as CellClipboard;
        if (!value || value.version !== 1 || !Number.isInteger(value.rowCount) || !Number.isInteger(value.columnCount) || value.rowCount < 1 || value.columnCount < 1 || value.rowCount * value.columnCount > 1000000) return null;
        if (!Array.isArray(value.values) || !Array.isArray(value.styles) || value.values.length !== value.rowCount || value.styles.length !== value.rowCount) return null;
        if (value.values.some(row => !Array.isArray(row) || row.length !== value.columnCount) || value.styles.some(row => !Array.isArray(row) || row.length !== value.columnCount)) return null;
        if (value.evaluatedValues !== undefined && (!Array.isArray(value.evaluatedValues) || value.evaluatedValues.length !== value.rowCount || value.evaluatedValues.some(row => !Array.isArray(row) || row.length !== value.columnCount))) return null;
        return { version: 1, rowCount: value.rowCount, columnCount: value.columnCount, values: value.values, evaluatedValues: value.evaluatedValues, styles: value.styles.map(row => row.map(cleanStyle)) };
    } catch { return null; }
}

export interface SelectivePastePlan {
    values?: PastePlan;
    styleUpdates: Array<{ id: string; field: string; style: CellStyle }>;
    newRows: string[];
    newFields: string[];
    errors: string[];
    baseline: string;
}
export function buildSelectivePaste(sheet: BaseDoc, visibleIds: string[], cols: string[], startRow: number, startCol: number, matrix: unknown[][], mode: 'all' | 'values' | 'formats', sourceStyles?: CellStyle[][], expandColumns = false): SelectivePastePlan {
    const result: SelectivePastePlan = { styleUpdates: [], newRows: [], newFields: [], errors: [], baseline: JSON.stringify(sheet) };
    if (!['all', 'values', 'formats'].includes(mode) || !Number.isInteger(startRow) || !Number.isInteger(startCol) || startRow < 0 || startRow > visibleIds.length || startCol < 0 || startCol > cols.length || !matrix.length || !matrix[0]?.length || matrix.some(row => row.length !== matrix[0].length)) {
        result.errors.push('粘贴选区或剪贴板尺寸无效'); return result;
    }
    const knownIds = new Set(sheet.records.map(row => String(row.id)));
    if (new Set(visibleIds).size !== visibleIds.length || new Set(cols).size !== cols.length || visibleIds.some(id => !knownIds.has(id)) || cols.some(field => !sheet.fields[field])) {
        result.errors.push('粘贴目标已变化，请重新选择'); return result;
    }
    if (mode === 'formats' && !sourceStyles) { result.errors.push('剪贴板不含可粘贴的格式'); return result; }
    const topology = planPaste(sheet, visibleIds, cols, startRow, startCol, mode === 'formats' ? matrix.map(row => row.map(() => null)) : matrix, expandColumns);
    result.newRows = topology.newRows;
    result.newFields = topology.newFields;
    result.errors.push(...topology.errors);
    result.values = mode === 'formats' ? { ...topology, updates: [] } : topology;
    if (mode !== 'values' && sourceStyles) {
        if (sourceStyles.length !== matrix.length || sourceStyles.some((row, index) => row.length !== matrix[index].length)) {
            result.errors.push('剪贴板内容与格式尺寸不一致'); return result;
        }
        const ids = [...visibleIds, ...topology.newRows], fields = [...cols, ...topology.newFields];
        try {
            matrix.forEach((row, ri) => row.forEach((_, ci) => result.styleUpdates.push({ id: ids[startRow + ri], field: fields[startCol + ci], style: cleanStyle(sourceStyles[ri][ci]) })));
        } catch (error) { result.errors.push((error as Error).message); }
    }
    return result;
}
export const planSelectivePaste = buildSelectivePaste;

/** Validate against the preview and a clone before committing any values or styles. */
export function applySelectivePaste(sheet: BaseDoc, plan: SelectivePastePlan): void {
    if (plan.errors.length) throw new Error(plan.errors.join('\n'));
    if (JSON.stringify(sheet) !== plan.baseline) throw new Error('工作表已变化，请重新预览粘贴');
    const next = structuredClone(sheet);
    if (plan.values) applyPaste(next, plan.values);
    const ids = new Set(next.records.map(row => String(row.id)));
    for (const update of plan.styleUpdates) {
        if (!ids.has(update.id) || !next.fields[update.field] || readGridMeta(next).merges?.some(merge => merge.rowIds.includes(update.id) && merge.fields.includes(update.field))) throw new Error('粘贴格式目标无效或已合并');
        const style = cleanStyle(update.style);
        const meta = (next.personalGrid ??= {}) as { cellStyles?: Record<string, Record<string, CellStyle>> };
        const map = (meta.cellStyles ??= {});
        if (Object.keys(style).length) (map[update.id] ??= {})[update.field] = style;
        else {
            if (map[update.id]) { delete map[update.id][update.field]; if (!Object.keys(map[update.id]).length) delete map[update.id]; }
        }
        if (!Object.keys(map).length) delete meta.cellStyles;
    }
    sheet.fields = next.fields;
    sheet.records = next.records;
    if (next.personalGrid !== undefined) sheet.personalGrid = next.personalGrid;
}

function structuralKey(value: unknown): unknown {
    if (value === undefined || value === null || value === '') return ['empty'];
    if (Array.isArray(value)) return ['array', value.map(structuralKey)];
    if (typeof value === 'object') return ['object', Object.keys(value as object).sort().map(key => [key, structuralKey((value as Record<string, unknown>)[key])])];
    return [typeof value, value];
}
/** Compare typed values structurally; missing, null, and empty strings share one blank value. */
export function findDuplicateRows(sheet: BaseDoc, fields: string[], ids?: string[]): { groups: string[][]; duplicateIds: string[] } {
    if (!fields.length || new Set(fields).size !== fields.length || fields.some(field => !sheet.fields[field])) throw new Error('请选择有效的去重字段');
    const selected = ids ? new Set(ids) : undefined;
    if (selected && ids!.some(id => !sheet.records.some(row => String(row.id) === id))) throw new Error('去重选区已变化');
    const buckets = new Map<string, string[]>();
    for (const row of calculatedSheet(sheet).records) {
        const id = String(row.id);
        if (selected && !selected.has(id)) continue;
        const key = JSON.stringify(fields.map(field => structuralKey(row[field])));
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key)!.push(id);
    }
    const groups = [...buckets.values()].filter(group => group.length > 1);
    return { groups, duplicateIds: groups.flatMap(group => group.slice(1)) };
}
export function removeDuplicates(sheet: BaseDoc, fields: string[], ids?: string[]): number {
    const { duplicateIds } = findDuplicateRows(sheet, fields, ids);
    if (duplicateIds.length) deleteRows(sheet, duplicateIds, false);
    return duplicateIds.length;
}
