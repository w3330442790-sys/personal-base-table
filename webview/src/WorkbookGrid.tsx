import React, { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { BaseDoc, FieldDef, Row, SortSpec } from '../../src/core/types';
import { applyPaste, assignParent, conditionalStyle, deleteRows, descendants, fillCells, gridMeta, insertRows, leafSummary, mergeCells, moveSubtree, parseTSV, planPaste, readGridMeta, unmergeCells, selectionClipboard, groupRows, createColumnGroup, visibleGroupColumns } from '../../src/core/features';
import { columnLabel, calculatedSheet, isFormula, translateFormula } from '../../src/core/formulas';
import { buildSelectivePaste, applySelectivePaste, makeCellClipboard, encodeCellClipboard, decodeCellClipboard, CELL_CLIPBOARD_MIME, findDuplicateRows, type CellClipboard } from '../../src/core/spreadsheet-data';
import { formatNumber, formatDate } from './format';
import { Cell } from './Cell';
import { cellStyle, cellStyleCss, formatCells, toggleCellStyle, type CellStyle } from '../../src/core/cell-style';
import { applySheetMessage } from '../../src/core/messages';
import type { UIConfig } from './config';
import { FloatingPanel } from './FloatingPanel';
import { belowAnchor, pointerAnchor, type FloatingAnchor } from './floating';
import { GridTouchGesture } from './grid-touch';
import { wheelScroll } from './grid-wheel';
import { gridWidth, rowHeaderWidth, ROW_HEADER_KEY } from './grid-layout';
import { locateCell } from './locate';
interface Props {
    command?: { id: number; kind: string; value?: string | number; rowId?: string; field?: string };
    sheet: BaseDoc;
    rows: Row[];
    cols: string[];
    config: UIConfig;
    colWidths: Record<string, number>;
    frozen?: number;
    viewId?: string;
    groupField?: string;
    canReorder?: boolean;
    sorts?: SortSpec[];
    onSort?: (field: string) => void;
    transact: (label: string, change: (sheet: BaseDoc) => void, destructive?: boolean) => void;
    onHeaderMenu: (col: string, x: number, y: number, element?: HTMLElement) => void;
    onResizeColumns?: (widths: Record<string, number>) => void;
    onResize: (col: string, width: number) => void;
    onReorderCols: (from: string, to: string) => void;
    onAddField: () => void;
    onDetail: (id: string) => void;
    onSelection?: (ids: string[], cols: string[]) => void;
    onMoveToSheet?: (ids: string[]) => void;
    sequence?: boolean;
    onSequenceChange?: (value: boolean) => void;
}
interface Point {
    row: number;
    col: number;
}interface Selection {
    start: Point;
    end: Point;
}
type Dialog = 'insert' | 'parent' | 'merge' | 'paste' | 'fill' | 'summary' | 'delete' | 'columnGroup' | 'freeze' | null;
/** 改名等操作提交后、宿主回推前，界面列名可能短暂领先于文档；缺定义时按文本列兜底，避免整表渲染崩溃。 */
const FALLBACK_FIELD: FieldDef = { type: 'text' };
const text = (value: unknown): string => Array.isArray(value) ? value.join(',') : String(value ?? '');
function htmlMatrix(html: string): string[][] | undefined {
    if (!html)
        return;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('br').forEach(br => br.replaceWith(doc.createTextNode('\n')));
    const table = doc.querySelector('table');
    if (!table)
        return;
    const result: string[][] = [];
    Array.from(table.rows).forEach((row, ri) => {
        result[ri] ??= [];
        let col = 0;
        Array.from(row.cells).forEach(cell => {
            while (result[ri][col] !== undefined)
                col++;
            const value = cell.textContent ?? '';
            for (let dr = 0; dr < cell.rowSpan; dr++) {
                result[ri + dr] ??= [];
                for (let dc = 0; dc < cell.colSpan; dc++)
                    result[ri + dr][col + dc] = dr === 0 && dc === 0 ? value : '';
            }
            col += cell.colSpan;
        });
    });
    return result;
}
type ViewGridExtras = { frozenRowsByView?: Record<string, string[]>; rowHeightsByView?: Record<string, Record<string, number>>; duplicateFields?: string[] };
let internalClipboard: { plain: string; html: string; payload: CellClipboard; rowCoordinates: number[]; columnCoordinates: number[] } | undefined;
function safeHtmlColor(value: string): string | undefined {
    if (!value || /url|var|expression/i.test(value)) return;
    const probe = document.createElement('canvas').getContext('2d');
    if (!probe) return;
    probe.fillStyle = '#010203'; probe.fillStyle = value;
    let normalized = probe.fillStyle;
    if (normalized === '#010203' && !/^(#010203|rgb\(1,\s*2,\s*3\))$/i.test(value)) return;
    if (/^#[\da-f]{6}$/i.test(normalized)) return normalized;
    const rgb = normalized.match(/^rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)(?:,\s*(1|1\.0+))?\s*\)$/);
    if (rgb) return '#' + rgb.slice(1, 4).map(part => Number(part).toString(16).padStart(2, '0')).join('');
}
function htmlStyles(html: string): CellStyle[][] | undefined {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const table = doc.querySelector('table');
    if (!table) return;
    const result: CellStyle[][] = [];
    Array.from(table.rows).forEach((row, ri) => {
        result[ri] ??= [];
        let ci = 0;
        Array.from(row.cells).forEach(cell => {
            while (result[ri][ci] !== undefined) ci++;
            const inline = cell.style;
            const style: CellStyle = {
                bold: /bold|[6-9]00/.test(inline.fontWeight) || !!cell.querySelector('b,strong'),
                italic: inline.fontStyle === 'italic' || !!cell.querySelector('i,em'),
                underline: inline.textDecoration.includes('underline') || !!cell.querySelector('u'),
                strikethrough: inline.textDecoration.includes('line-through') || !!cell.querySelector('s,strike'),
                ...(['left', 'center', 'right'].includes(inline.textAlign) ? { align: inline.textAlign as CellStyle['align'] } : {}),
                ...(safeHtmlColor(inline.color) ? { color: safeHtmlColor(inline.color) } : {}),
                ...(safeHtmlColor(inline.backgroundColor) ? { background: safeHtmlColor(inline.backgroundColor) } : {})
            };
            for (let dr = 0; dr < Math.min(cell.rowSpan, 10000); dr++) {
                result[ri + dr] ??= [];
                for (let dc = 0; dc < Math.min(cell.colSpan, 1000); dc++) result[ri + dr][ci + dc] = { ...style };
            }
            ci += cell.colSpan;
        });
    });
    return result;
}
export function WorkbookGrid(props: Props) {
    const { sheet, config, transact } = props;
    const fieldDef = (field: string): FieldDef => sheet.fields[field] ?? FALLBACK_FIELD;
    const viewId = props.viewId ?? sheet.views[0]?.name ?? '全部';
    const [fallbackSequence, setFallbackSequence] = useState(false);
    const sequence = props.sequence ?? fallbackSequence;
    const setSequence = (value: boolean) => { if (props.onSequenceChange) props.onSequenceChange(value); else setFallbackSequence(value); };
    const { meta, cols, fieldIndices, parentIds, renderedFrozenCount, columnGroups, collapsedRows, collapsedGroups, extras, heights, pinnedRows, rows, pinnedIds, sourceRows, visibleRowMap, rowIndices } = useMemo(() => {
        const groupedRows = groupRows(props.rows, props.groupField);
        const meta = readGridMeta(sheet);
        const cols = visibleGroupColumns(sheet, viewId, props.cols);
        const fieldIndices = new Map(Object.keys(sheet.fields).map((field, index) => [field, index]));
        const parentIds = new Set(Object.values(meta.parents ?? {}));
        const frozenColumnIds = new Set(props.cols.slice(0, props.frozen ?? 0));
        const renderedFrozenCount = cols.filter(field => frozenColumnIds.has(field)).length;
        const columnGroups = meta.columnGroupsByView?.[viewId] ?? [];
        const collapsedRows = meta.collapsedByView?.[viewId] ?? meta.collapsed ?? [];
        const collapsedGroups = meta.collapsedGroupsByView?.[viewId] ?? meta.collapsedGroups ?? [];
        const extras = meta as typeof meta & ViewGridExtras;
        const heights = extras.rowHeightsByView?.[viewId] ?? {};
        const visibleRows = groupedRows.filter(row => !props.groupField || !collapsedGroups.includes(text(row.values[props.groupField]) || '未分组'));
        const frozenIds = new Set(extras.frozenRowsByView?.[viewId] ?? []);
        const pinnedRows = visibleRows.filter(row => frozenIds.has(row.id));
        const rows = [...pinnedRows, ...visibleRows.filter(row => !frozenIds.has(row.id))];
        const pinnedIds = new Set(pinnedRows.map(row => row.id));
        const sourceRows = [...pinnedRows, ...groupedRows.filter(row => !pinnedIds.has(row.id))];
        const visibleRowMap = new Map(rows.map(row => [row.id, row]));
        const rowIndices = new Map(rows.map((row, index) => [row.id, index]));
        return { meta, cols, fieldIndices, parentIds, renderedFrozenCount, columnGroups, collapsedRows, collapsedGroups, extras, heights, pinnedRows, rows, pinnedIds, sourceRows, visibleRowMap, rowIndices };
    }, [sheet, props.rows, props.groupField, props.cols, props.frozen, viewId]);
    const recordIndices = useMemo(() => new Map(sheet.records.map((row, index) => [String(row.id), index])), [sheet]);
    const rawRecords = useMemo(() => new Map(sheet.records.map(row => [String(row.id), row])), [sheet]);
    const calculated = useMemo(() => calculatedSheet(sheet), [sheet]);
    const mergedFormulaRecords = useMemo(() => {
        const formulaMerges = (meta.merges ?? []).filter(merge => isFormula(merge.display));
        if (!formulaMerges.length) return new Map<string, Record<string, unknown>>();
        const overlays = new Map<string, Record<string, unknown>>();
        for (const merge of formulaMerges) {
            const patch = overlays.get(merge.rowIds[0]) ?? {};
            patch[merge.fields[0]] = merge.display; overlays.set(merge.rowIds[0], patch);
        }
        const projected: BaseDoc = { ...sheet, records: sheet.records.map(record => {
            const patch = overlays.get(String(record.id));
            return patch ? { ...record, ...patch } : record;
        }) };
        return new Map(calculatedSheet(projected).records.map(record => [String(record.id), record]));
    }, [sheet]);
    const calculatedRecords = useMemo(() => new Map(calculated.records.map(row => [String(row.id), row])), [calculated]);
    const duplicateIds = useMemo(() => { const fields = extras.duplicateFields?.filter(field => sheet.fields[field]) ?? []; return new Set(fields.length ? findDuplicateRows(sheet, fields).duplicateIds : []); }, [sheet, (extras.duplicateFields ?? []).join('\0')]);
    const defaultHeight = config.rowHeight === 'compact' ? 30 : config.rowHeight === 'tall' ? 54 : 38;
    const [headerHeight, setHeaderHeight] = useState(34);
    const [measuredHeights, setMeasuredHeights] = useState<Record<string, number>>({});
    const frozenTops = new Map<string, number>();
    let frozenOffset = headerHeight;
    for (const row of pinnedRows) { frozenTops.set(row.id, frozenOffset); frozenOffset += measuredHeights[row.id] ?? heights[row.id] ?? defaultHeight; }
    const frozenRowStyle = (id: string): CSSProperties => frozenTops.has(id) ? { position: 'sticky', top: frozenTops.get(id), zIndex: 4, background: 'var(--background-primary,var(--vscode-editor-background))' } : {};
    const root = useRef<HTMLDivElement>(null);
    const scroller = useRef<HTMLDivElement>(null);
    const selecting = useRef(false);
    const [touchRange, setTouchRange] = useState(false);
    const [touchUsed, setTouchUsed] = useState(false);
    const touchGesture = useRef(new GridTouchGesture());
    const touchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const lastTouch = useRef(0);
    const touchTap = useRef<() => void>(() => {});
    const cancelTouch = () => { touchGesture.current.cancel(); clearTimeout(touchTimer.current); };
    useEffect(() => {
        const down = (event: PointerEvent) => { if (event.pointerType === 'touch' && !event.isPrimary) cancelTouch(); };
        const move = (event: PointerEvent) => { touchGesture.current.move(event.pointerId, event.clientX, event.clientY); };
        const up = (event: PointerEvent) => {
            if (event.pointerType !== 'touch') return;
            lastTouch.current = Date.now();
            clearTimeout(touchTimer.current);
            if (touchGesture.current.end(event.pointerId)) touchTap.current();
        };
        window.addEventListener('pointerdown', down, true);
        window.addEventListener('pointermove', move, true);
        window.addEventListener('pointerup', up, true);
        window.addEventListener('pointercancel', cancelTouch, true);
        window.addEventListener('scroll', cancelTouch, true);
        return () => {
            cancelTouch();
            window.removeEventListener('pointerdown', down, true);
            window.removeEventListener('pointermove', move, true);
            window.removeEventListener('pointerup', up, true);
            window.removeEventListener('pointercancel', cancelTouch, true);
            window.removeEventListener('scroll', cancelTouch, true);
        };
    }, []);
    useEffect(() => {
        const element = scroller.current;
        if (!element) return;
        // React 的 onWheel 默认 passive,必须用原生监听才能阻止外层滚动并实现 Shift 横向滚动
        const onWheel = (event: WheelEvent) => {
            // 单元格编辑框、下拉和菜单自己处理滚轮
            if ((event.target as HTMLElement).closest?.('textarea,input,select,[contenteditable=true],[role=menu],[role=dialog]')) return;
            const delta = wheelScroll(event, { clientWidth: element.clientWidth, clientHeight: element.clientHeight, scrollWidth: element.scrollWidth, scrollHeight: element.scrollHeight });
            if (!delta) return;
            event.preventDefault();
            element.scrollLeft += delta.dx;
            element.scrollTop += delta.dy;
        };
        element.addEventListener('wheel', onWheel, { passive: false });
        return () => element.removeEventListener('wheel', onWheel);
    }, []);
    const dragFill = useRef<Selection | null>(null);
    const draggedRow = useRef<string | null>(null);
    const draggedCol = useRef<string | null>(null);
    const [selection, setSelection] = useState<Selection | null>(null);
    const [menu, setMenu] = useState<{
        anchor: FloatingAnchor;
        id: string;
    } | null>(null);
    const [dialog, setDialog] = useState<Dialog>(null);
    const lastAnchor = useRef<FloatingAnchor | null>(null);
    const resizeCleanup = useRef<() => void>(() => {});
    const headerWidth = rowHeaderWidth(props.colWidths);
    const [count, setCount] = useState(1);
    const [deleteMode, setDeleteMode] = useState<'rows' | 'columns'>('rows');
    const [side, setSide] = useState<'above' | 'below'>('below');
    const [join, setJoin] = useState(false);
    const [keepDisplay, setKeepDisplay] = useState(false);
    const [fill, setFill] = useState('');
    const [groupName, setGroupName] = useState('');
    const [pasteText, setPasteText] = useState('');
    const [pasteMatrix, setPasteMatrix] = useState<unknown[][] | null>(null);
    const [pasteSourceCoordinates, setPasteSourceCoordinates] = useState<{ rows: number[]; columns: number[] } | undefined>();
    const [pasteEvaluatedValues, setPasteEvaluatedValues] = useState<unknown[][] | undefined>();
    const [pasteStyles, setPasteStyles] = useState<CellStyle[][] | undefined>();
    const [pasteMode, setPasteMode] = useState<'all' | 'values' | 'formats'>('all');
    const [freezeMode, setFreezeMode] = useState<'selected' | 'first'>('selected');
    const lastCommand = useRef<number | undefined>(undefined);
    const [expand, setExpand] = useState(false);
    const [error, setError] = useState('');
    const [completion, setCompletion] = useState(meta.summary?.completionField ?? '');
    const [number, setNumber] = useState(meta.summary?.numberField ?? '');
    const [operation, setOperation] = useState<'sum' | 'average' | 'min' | 'max'>(meta.summary?.operation ?? 'sum');
    const [parentMode, setParentMode] = useState<'following' | 'selected'>('selected');
    const selectedRows = selection ? rows.slice(Math.min(selection.start.row, selection.end.row), Math.max(selection.start.row, selection.end.row) + 1) : [];
    const selectedCols = selection ? cols.slice(Math.min(selection.start.col, selection.end.col), Math.max(selection.start.col, selection.end.col) + 1) : [];
    const ids = selectedRows.map(row => row.id);
    const top = selection ? Math.min(selection.start.row, selection.end.row) : 0;
    const left = selection ? Math.min(selection.start.col, selection.end.col) : 0;
    const active = menu?.id ?? ids[0];
    const selectedMerge = meta.merges?.find(m => m.rowIds.some(id => ids.includes(id)) && m.fields.some(f => selectedCols.includes(f)));
    useEffect(() => { props.onSelection?.(ids, selectedCols); }, [ids.join('\0'), selectedCols.join('\0')]);
    useEffect(() => {
        const up = () => { selecting.current = false; dragFill.current = null; };
        window.addEventListener('mouseup', up);
        return () => { window.removeEventListener('mouseup', up); resizeCleanup.current(); };
    }, []);
    useEffect(() => { cancelTouch(); setSelection(null); setMenu(null); setDialog(null); }, [cols.join('\0'), viewId]);
    const run = (label: string, change: (sheet: BaseDoc) => void, destructive = false) => {
        try {
            transact(label, change, destructive);
            setError('');
            setMenu(null);
            setDialog(null);
        }
        catch (err) {
            setError((err as Error).message);
        }
    };
    const show = (next: Dialog, element?: HTMLElement) => {
        if (element) lastAnchor.current = belowAnchor(element);
        else if (menu) lastAnchor.current = menu.anchor;
        lastAnchor.current ??= belowAnchor(root.current!);
        setError(''); setMenu(null); setDialog(next);
    };
    const openMenu = (id: string, element: HTMLElement, x: number, y: number) => {
        const anchor = pointerAnchor(element, x, y);
        lastAnchor.current = anchor;
        setMenu({ id, anchor });
    };
    const trackResize = (event: React.PointerEvent<HTMLElement>, preview: (event: PointerEvent) => void, commit: (event: PointerEvent) => void, restore: () => void) => {
        if (event.button !== 0 || !event.isPrimary) return;
        event.preventDefault(); event.stopPropagation(); cancelTouch(); resizeCleanup.current();
        const handle = event.currentTarget;
        const owner = handle.ownerDocument.defaultView!;
        const pointerId = event.pointerId;
        handle.setPointerCapture(pointerId);
        const move = (next: PointerEvent) => { if (next.pointerId === pointerId) preview(next); };
        const cancel = () => cleanup();
        const cleanup = () => {
            owner.removeEventListener('pointermove', move);
            owner.removeEventListener('pointerup', up);
            owner.removeEventListener('pointercancel', cancelled);
            owner.removeEventListener('blur', cancel);
            handle.removeEventListener('lostpointercapture', cancel);
            if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
            restore();
            resizeCleanup.current = () => {};
        };
        const cancelled = (next: PointerEvent) => { if (next.pointerId === pointerId) cleanup(); };
        const up = (next: PointerEvent) => { if (next.pointerId === pointerId) { cleanup(); commit(next); } };
        resizeCleanup.current = cleanup;
        owner.addEventListener('pointermove', move);
        owner.addEventListener('pointerup', up);
        owner.addEventListener('pointercancel', cancelled);
        owner.addEventListener('blur', cancel);
        handle.addEventListener('lostpointercapture', cancel);
    };
    const resizeColumn = (event: React.PointerEvent<HTMLElement>, col: string, width: number) => {
        const target = event.currentTarget.parentElement!;
        const initial = target.style.width;
        const start = event.clientX;
        const nextWidth = (x: number) => col === ROW_HEADER_KEY ? Math.max(44, Math.min(160, width + x - start)) : Math.max(70, width + x - start);
        trackResize(event, next => { target.style.width = `${nextWidth(next.clientX)}px`; }, next => {
            if (nextWidth(next.clientX) !== width) props.onResize(col, nextWidth(next.clientX));
        }, () => { target.style.width = initial; });
    };
    const startTouch = (event: React.PointerEvent<HTMLElement>, point: Point, id: string) => {
        if (event.pointerType !== 'touch') return;
        setTouchUsed(true);
        lastTouch.current = Date.now();
        if ((event.target as HTMLElement).closest('.is-editing,.select-pop')) return;
        const gesture = touchGesture.current;
        if (!gesture.begin(event.pointerId, event.clientX, event.clientY, Date.now(), event.isPrimary)) return;
        const element = event.currentTarget;
        touchTap.current = () => { choose(point, touchRange); setMenu(null); };
        touchTimer.current = setTimeout(() => {
            if (!gesture.hold(Date.now())) return;
            if (!isSelected(point.row, point.col)) choose(point, touchRange);
            openMenu(id, element, event.clientX, event.clientY);
        }, 550);
    };
    const choose = (point: Point, extend = false) => {
        setSelection(old => {
            const start = extend && old ? old.start : point;
            if (old && old.start.row === start.row && old.start.col === start.col && old.end.row === point.row && old.end.col === point.col) return old;
            return { start, end: point };
        });
    };
    const focusPoint = (point: Point) => requestAnimationFrame(() => {
        const target = root.current?.querySelector<HTMLElement>(`td[data-row-index="${point.row}"][data-col-index="${point.col}"] .spreadsheet-cell`);
        (target ?? root.current)?.focus();
    });
    const revealPoint = (point: Point) => requestAnimationFrame(() => {
        const cell = root.current?.querySelector<HTMLElement>(`td[data-row-index="${point.row}"][data-col-index="${point.col}"]`);
        cell?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        focusPoint(point);
    });
    const navigate = (row: number, col: number, direction: 'up' | 'down' | 'left' | 'right') => {
        const point = { row: Math.max(0, Math.min(rows.length - 1, row + (direction === 'down' ? 1 : direction === 'up' ? -1 : 0))), col: Math.max(0, Math.min(cols.length - 1, col + (direction === 'right' ? 1 : direction === 'left' ? -1 : 0))) };
        choose(point);
        focusPoint(point);
    };
    const formatEnabled = (key: 'bold' | 'italic' | 'underline' | 'strikethrough') => ids.length > 0 && selectedCols.length > 0 && ids.every(id => selectedCols.every(field => cellStyle(sheet, id, field)[key]));
    const requireSelection = () => { if (!ids.length || !selectedCols.length) { setError('请先选择单元格区域'); return false; } return true; };
    const toggleFormat = (key: 'bold' | 'italic' | 'underline' | 'strikethrough') => { if (requireSelection()) run('修改单元格格式', candidate => toggleCellStyle(candidate, ids, selectedCols, key)); };
    const alignSelection = (align: CellStyle['align']) => { if (requireSelection()) run('设置选区对齐', candidate => formatCells(candidate, ids, selectedCols, { align })); };
    const isSelected = (row: number, col: number) => !!selection && row >= Math.min(selection.start.row, selection.end.row) && row <= Math.max(selection.start.row, selection.end.row) && col >= Math.min(selection.start.col, selection.end.col) && col <= Math.max(selection.start.col, selection.end.col);
    const rawSelectedRows = selectedRows.map(row => ({ id: row.id, values: Object.fromEntries(Object.keys(sheet.fields).map(field => [field, rawRecords.get(row.id)?.[field]])) }));
    const copyData = () => selectionClipboard(sheet, rawSelectedRows, selectedCols);
    const copy = async () => {
        try {
            if (!requireSelection()) return;
            const data = copyData();
            internalClipboard = { ...data, payload: makeCellClipboard(sheet, rawSelectedRows, selectedCols), rowCoordinates: selectedRows.map(row => recordIndices.get(row.id)!), columnCoordinates: selectedCols.map(field => fieldIndices.get(field)!) };
            if (navigator.clipboard.write && typeof ClipboardItem !== 'undefined')
                try { await navigator.clipboard.write([new ClipboardItem({ [CELL_CLIPBOARD_MIME]: new Blob([encodeCellClipboard(internalClipboard.payload)], { type: CELL_CLIPBOARD_MIME }), 'text/plain': new Blob([data.plain], { type: 'text/plain' }), 'text/html': new Blob([data.html], { type: 'text/html' }) })]); }
                catch { await navigator.clipboard.write([new ClipboardItem({ 'text/plain': new Blob([data.plain], { type: 'text/plain' }), 'text/html': new Blob([data.html], { type: 'text/html' }) })]); }
            else
                await navigator.clipboard.writeText(data.plain);
            setMenu(null);
        }
        catch {
            setError('已暂存到插件剪贴板，可用“粘贴”按钮继续操作；系统剪贴板暂不可用');
            setMenu(null);
        }
    };
    let pastePlan: ReturnType<typeof buildSelectivePaste> | undefined;
    let pasteError = '';
    if (dialog === 'paste') {
        try {
            let matrix = (pasteMode === 'values' ? pasteEvaluatedValues : undefined) ?? pasteMatrix ?? parseTSV(pasteText);
            if (pasteMode === 'all' && pasteSourceCoordinates) {
                matrix = matrix.map((line, ri) => line.map((value, ci) => {
                    if (!isFormula(value)) return value;
                    const targetId = rows[top + ri]?.id;
                    const targetRow = targetId ? recordIndices.get(targetId)! : sheet.records.length + top + ri - rows.length;
                    const targetField = cols[left + ci];
                    const targetCol = targetField ? fieldIndices.get(targetField)! : fieldIndices.size + left + ci - cols.length;
                    return translateFormula(value, targetRow - pasteSourceCoordinates.rows[ri], targetCol - pasteSourceCoordinates.columns[ci]);
                }));
            }
            pastePlan = buildSelectivePaste(sheet, rows.map(r => r.id), cols, top, left, matrix, pasteMode, pasteStyles, expand);
        }
        catch (err) { pasteError = (err as Error).message; }
    }
    const openPaste = (plain = '', html = '', custom = '', mode: 'all' | 'values' | 'formats' = 'all') => {
        const internal = internalClipboard && plain === internalClipboard.plain && (!html || html === internalClipboard.html) ? internalClipboard : undefined;
        const payload = decodeCellClipboard(custom) ?? internal?.payload;
        setPasteSourceCoordinates(internal ? { rows: internal.rowCoordinates, columns: internal.columnCoordinates } : undefined);
        setPasteEvaluatedValues(payload?.evaluatedValues); setPasteText(plain); setPasteMatrix(payload?.values ?? htmlMatrix(html) ?? null); setPasteStyles(payload?.styles ?? htmlStyles(html)); setPasteMode(mode); setExpand(false); show('paste');
    };
    const readPaste = async (mode: 'all' | 'values' | 'formats') => {
        try {
            if (navigator.clipboard.read) {
                const entries = await navigator.clipboard.read(); let plain = '', html = '', custom = '';
                for (const item of entries) {
                    if (item.types.includes('text/plain')) plain = await (await item.getType('text/plain')).text();
                    if (item.types.includes('text/html')) html = await (await item.getType('text/html')).text();
                    if (item.types.includes(CELL_CLIPBOARD_MIME)) custom = await (await item.getType(CELL_CLIPBOARD_MIME)).text();
                }
                openPaste(plain, html, custom, mode);
            } else openPaste(await navigator.clipboard.readText(), '', '', mode);
        } catch {
            if (internalClipboard) openPaste(internalClipboard.plain, internalClipboard.html, encodeCellClipboard(internalClipboard.payload), mode);
            else openPaste('', '', '', mode);
        }
    };
    let columnOffset = headerWidth;
    const columnOffsets = cols.map(col => { const left = columnOffset; columnOffset += props.colWidths[col] ?? 160; return left; });
    const frozenStyle = (index: number): CSSProperties => index < renderedFrozenCount ? { position: 'sticky', left: columnOffsets[index], zIndex: 2, background: 'var(--background-primary, var(--vscode-editor-background))' } : {};
    const displayText = (row: Row, field: string) => {
        const record = calculatedRecords.get(row.id);
        const value = record ? record[field] : row.values[field];
        const def = fieldDef(field);
        return def.type === 'number' ? formatNumber(value, def) : def.type === 'date' ? formatDate(value, def.dateFormat) : text(value);
    };
    const canvasContext = useRef<CanvasRenderingContext2D | null>(null);
    const measureWidth = (value: string, style: CellStyle = {}) => {
        const context = canvasContext.current ??= document.createElement('canvas').getContext('2d');
        if (!context) return value.length * 8;
        context.font = `${style.italic ? 'italic ' : ''}${style.bold ? '700' : '400'} ${config.fontSize || 13}px ${getComputedStyle(root.current!).fontFamily}`;
        return Math.max(...value.split('\n').map(line => context.measureText(line).width), 0);
    };
    const autoColumnWidth = (fields = selectedCols.length ? selectedCols : cols) => {
        const widths: Record<string, number> = {};
        for (const field of fields) {
            let width = measureWidth(`${columnLabel((fieldIndices.get(field) ?? 0))} ${field}`) + 42;
            for (const row of rows) width = Math.max(width, measureWidth(displayText(row, field), cellStyle(sheet, row.id, field)) + 28);
            widths[field] = Math.max(70, Math.min(1000, Math.ceil(width)));
        }
        if (props.onResizeColumns) props.onResizeColumns(widths);
        else run('自动适应列宽', candidate => { const view = candidate.views.find(view => view.name === viewId); if (view) view.colWidths = { ...props.colWidths, ...widths }; });
    };
    const autoRowHeight = (targets = selectedRows.length ? selectedRows : rows) => {
        const next: Record<string, number> = {};
        const probe = document.createElement('div');
        Object.assign(probe.style, { position: 'fixed', left: '-10000px', top: '0', visibility: 'hidden', pointerEvents: 'none' });
        root.current?.appendChild(probe);
        try {
            for (const row of targets) {
                let height = defaultHeight;
                const ri = rowIndices.get(row.id);
                for (const [ci, field] of cols.entries()) {
                    const style = cellStyle(sheet, row.id, field);
                    const width = Math.max(20, (props.colWidths[field] ?? 160) - 24);
                    const lines = displayText(row, field).split('\n').reduce((sum, line) => sum + (config.wrapText ? Math.max(1, Math.ceil(measureWidth(line, style) / width)) : 1), 0);
                    let measured = lines * (config.fontSize || 13) * 1.5 + 12;
                    const cell = root.current?.querySelector<HTMLElement>(`td[data-row-index="${ri}"][data-col-index="${ci}"] .spreadsheet-cell`);
                    if (cell && !cell.classList.contains('is-editing') && !cell.closest('[rowspan],[colspan]')) {
                        const clone = cell.cloneNode(true) as HTMLElement;
                        const computed = getComputedStyle(cell);
                        Object.assign(clone.style, { width: `${props.colWidths[field] ?? 160}px`, minHeight: '0', height: 'auto', maxHeight: 'none', display: 'block', boxSizing: 'border-box', whiteSpace: config.wrapText ? 'pre-wrap' : 'nowrap', overflowWrap: 'anywhere', font: computed.font });
                        clone.querySelectorAll<HTMLElement>('span,div').forEach(child => Object.assign(child.style, { overflow: 'visible', textOverflow: 'clip', whiteSpace: 'inherit' }));
                        clone.querySelectorAll('button,input,textarea').forEach(child => child.remove());
                        probe.replaceChildren(clone);
                        measured = Math.ceil(clone.getBoundingClientRect().height + 2);
                    }
                    height = Math.max(height, measured);
                }
                next[row.id] = Math.min(1200, Math.ceil(height));
            }
        } finally { probe.remove(); }
        run('自动适应行高', candidate => { const extra = gridMeta(candidate) as ViewGridExtras; Object.assign((extra.rowHeightsByView ??= {})[viewId] ??= {}, next); });
    };
    const resizeRow = (event: React.PointerEvent<HTMLElement>, id: string) => {
        const target = event.currentTarget.closest('tr')!;
        const initialHeight = target.style.height, initialVariable = target.style.getPropertyValue('--bt-row-h');
        const start = event.clientY, initial = target.getBoundingClientRect().height;
        const height = (y: number) => Math.max(26, Math.min(1200, Math.round(initial + y - start)));
        trackResize(event, next => {
            target.style.height = `${height(next.clientY)}px`; target.style.setProperty('--bt-row-h', `${height(next.clientY)}px`);
        }, next => {
            if (height(next.clientY) !== Math.round(initial)) run('调整行高', candidate => {
                const extra = gridMeta(candidate) as ViewGridExtras;
                ((extra.rowHeightsByView ??= {})[viewId] ??= {})[id] = height(next.clientY);
            });
        }, () => { target.style.height = initialHeight; target.style.setProperty('--bt-row-h', initialVariable); });
    };
    useEffect(() => {
        if (!root.current || !pinnedRows.length || typeof ResizeObserver === 'undefined') return;
        const observer = new ResizeObserver(entries => {
            const header = entries.find(entry => entry.target.tagName === 'THEAD');
            if (header) setHeaderHeight(Math.ceil(header.target.getBoundingClientRect().height));
            setMeasuredHeights(previous => {
                const next = { ...previous }; let changed = false;
                for (const entry of entries) {
                    const height = Math.ceil(entry.target.getBoundingClientRect().height);
                    if (entry.target.tagName === 'THEAD') continue;
                    const id = (entry.target as HTMLElement).dataset.recordId!;
                    if (next[id] !== height) { next[id] = height; changed = true; }
                }
                return changed ? next : previous;
            });
        });
        root.current.querySelectorAll('tr[data-frozen=true],thead').forEach(row => observer.observe(row));
        return () => observer.disconnect();
    }, [pinnedRows.map(row => row.id).join('\0'), sheet, config.wrapText, config.fontSize]);
    useEffect(() => {
        const command = props.command;
        if (!command || lastCommand.current === command.id) return;
        lastCommand.current = command.id;
        switch (command.kind) {
            case 'locate': {
                const position = locateCell(rows, cols, command.rowId, command.field);
                if (!position) {
                    setError('该结果不在当前视图的可见范围，请清除筛选、展开分组或显示对应列后重试');
                    break;
                }
                setError('');
                setMenu(null);
                setDialog(null);
                choose(position);
                revealPoint(position);
                break;
            }
            case 'copy': void copy(); break;
            case 'paste': void readPaste('all'); break;
            case 'pasteValues': void readPaste('values'); break;
            case 'pasteFormats': void readPaste('formats'); break;
            case 'autoColumnWidth': autoColumnWidth(); break;
            case 'autoRowHeight': autoRowHeight(); break;
            case 'freezeRows': setFreezeMode(ids.length ? 'selected' : 'first'); show('freeze'); break;
            case 'unfreezeRows': setSelection(null); run('取消冻结行', candidate => { const extra = gridMeta(candidate) as ViewGridExtras; if (extra.frozenRowsByView) delete extra.frozenRowsByView[viewId]; }); break;
            case 'insertRow': show('insert'); break;
            case 'parent': setParentMode(ids.length > 1 ? 'selected' : 'following'); show('parent'); break;
            case 'merge': if (requireSelection()) show('merge'); break;
            case 'groupColumns': if (requireSelection()) show('columnGroup'); break;
            case 'summary': show('summary'); break;
            case 'clearContents': if (requireSelection()) run('清空区域', candidate => fillCells(candidate, ids, selectedCols, null)); break;
            case 'clearFormat': if (requireSelection()) run('清除单元格格式', candidate => formatCells(candidate, ids, selectedCols, null)); break;
            case 'bold': case 'italic': case 'underline': case 'strikethrough': toggleFormat(command.kind); break;
            case 'left': case 'center': case 'right': alignSelection(command.kind); break;
            case 'fontColor': case 'fillColor': if (requireSelection()) run('设置颜色', candidate => formatCells(candidate, ids, selectedCols, { [command.kind === 'fontColor' ? 'color' : 'background']: String(command.value ?? '') })); break;
        }
    }, [props.command?.id]);
    const applyDragFill = (targetRow: number) => {
        const source = dragFill.current;
        if (!source || targetRow <= Math.max(source.start.row, source.end.row))
            return;
        const first = Math.min(source.start.row, source.end.row), last = Math.max(source.start.row, source.end.row);
        const firstCol = Math.min(source.start.col, source.end.col), lastCol = Math.max(source.start.col, source.end.col);
        const matrix = rows.slice(last + 1, targetRow + 1).map((target, i) => cols.slice(firstCol, lastCol + 1).map(field => {
            const sourceRow = rows[first + i % (last - first + 1)];
            const value = rawRecords.get(sourceRow.id)?.[field];
            if (isFormula(value)) {
                const deltaRow = recordIndices.get(target.id)! - recordIndices.get(sourceRow.id)!;
                return translateFormula(value, deltaRow, 0);
            }
            if (sequence && typeof value === 'number')
                return value + (Math.floor(i / (last - first + 1)) + 1) * (last - first + 1);
            if (sequence && fieldDef(field).type === 'date' && value) {
                const date = new Date(String(value));
                date.setUTCDate(date.getUTCDate() + (Math.floor(i / (last - first + 1)) + 1) * (last - first + 1));
                return date.toISOString().slice(0, 10);
            }
            return value;
        }));
        run(sequence ? '序列填充' : '拖动填充', d => applyPaste(d, planPaste(d, rows.map(r => r.id), cols, last + 1, firstCol, matrix)));
        setSelection({ start: source.start, end: { row: targetRow, col: lastCol } });
    };
    return <div className={`personal-grid ${touchUsed ? 'personal-touch-used' : ''}`} style={{ "--personal-rownum-width": `${headerWidth}px` } as CSSProperties} ref={root} tabIndex={0} onKeyDown={event => {
            if ((event.target as HTMLElement).matches('input,textarea,select,[contenteditable=true]'))
                return;
            if (event.key === 'Escape') {
                setMenu(null);
                setDialog(null);
                return;
            }
            if (!selection)
                return;
            const directions: Record<string, [
                number,
                number
            ]> = { ArrowDown: [1, 0], ArrowUp: [-1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
            if (directions[event.key]) {
                event.preventDefault();
                const [dr, dc] = directions[event.key];
                const point = { row: Math.max(0, Math.min(rows.length - 1, selection.end.row + dr)), col: Math.max(0, Math.min(cols.length - 1, selection.end.col + dc)) };
                choose(point, event.shiftKey);
                focusPoint(point);
            }
            if (event.key === 'Tab' || event.key === 'Enter') {
                event.preventDefault();
                navigate(selection.end.row, selection.end.col, event.key === 'Tab' ? (event.shiftKey ? 'left' : 'right') : (event.shiftKey ? 'up' : 'down'));
            }
            if ((event.ctrlKey || event.metaKey) && ['b', 'i', 'u'].includes(event.key.toLowerCase())) {
                event.preventDefault();
                toggleFormat(event.key.toLowerCase() === 'b' ? 'bold' : event.key.toLowerCase() === 'i' ? 'italic' : 'underline');
            }
            if (event.key === 'Delete' || event.key === 'Backspace') {
                event.preventDefault();
                run('清空区域', d => fillCells(d, ids, selectedCols, null));
            }
        }} onCopy={event => { if ((event.target as HTMLElement).matches('input,textarea'))
        return; if (!selection)
        return; const data = copyData(); internalClipboard = { ...data, payload: makeCellClipboard(sheet, rawSelectedRows, selectedCols), rowCoordinates: selectedRows.map(row => recordIndices.get(row.id)!), columnCoordinates: selectedCols.map(field => fieldIndices.get(field)!) }; event.clipboardData.setData(CELL_CLIPBOARD_MIME, encodeCellClipboard(internalClipboard.payload)); event.preventDefault(); event.clipboardData.setData('text/plain', data.plain); event.clipboardData.setData('text/html', data.html); }} onPaste={event => { if ((event.target as HTMLElement).matches('input,textarea'))
        return; event.preventDefault(); openPaste(event.clipboardData.getData('text/plain'), event.clipboardData.getData('text/html'), event.clipboardData.getData(CELL_CLIPBOARD_MIME)); }}>
    {error && <div role="alert" className="personal-grid-error">{error}<button onClick={() => setError('')}>关闭</button></div>}
    <div className="personal-grid-scroll" ref={scroller} onMouseDownCapture={event => {
        if (Date.now() - lastTouch.current < 800 && (event.target as HTMLElement).closest('td[data-row-index]') && !(event.target as HTMLElement).closest('.is-editing,.select-pop')) { event.preventDefault(); event.stopPropagation(); }
    }} onClickCapture={event => {
        if (event.isTrusted && Date.now() - lastTouch.current < 800 && (event.target as HTMLElement).closest('td[data-row-index]') && !(event.target as HTMLElement).closest('.is-editing,.select-pop')) { event.preventDefault(); event.stopPropagation(); }
    }} onDoubleClickCapture={event => {
        if (Date.now() - lastTouch.current < 800) { event.preventDefault(); event.stopPropagation(); }
    }}><table className={`personal-grid-table ${config.wrapText ? 'wrap' : ''}`} style={{ fontSize: config.fontSize || undefined, width: gridWidth(cols, props.colWidths), minWidth: gridWidth(cols, props.colWidths) }}><colgroup><col style={{ width: headerWidth }}/>{cols.map(c => <col key={c} style={{ width: props.colWidths[c] ?? 160 }}/>)}<col style={{ width: 36 }}/></colgroup>
      <thead><tr><th className="personal-row-head" aria-label="行操作" style={{ width: headerWidth, minWidth: headerWidth, maxWidth: headerWidth }}>行<span className="personal-col-resize" title="拖动调整行号列宽度" onPointerDown={event => resizeColumn(event, ROW_HEADER_KEY, headerWidth)}/></th>{cols.map((col, ci) => <th key={col} className="personal-field-head" data-field={col} style={frozenStyle(ci)} draggable onDragStart={() => { draggedCol.current = col; }} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); if (draggedCol.current)
        props.onReorderCols(draggedCol.current, col); draggedCol.current = null; }} onContextMenu={e => { e.preventDefault(); props.onHeaderMenu(col, e.clientX, e.clientY, e.currentTarget); }}>{(() => {
            const dir = props.sorts?.find(sort => sort.field === col)?.dir;
            const openMenu = (event: React.MouseEvent<HTMLButtonElement>) => {
                const header = event.currentTarget.closest("th")!;
                const rect = header.getBoundingClientRect();
                props.onHeaderMenu(col, rect.left, rect.bottom + 4, header);
            };
            return <span className="personal-header-inner">
                <button className="personal-header-label" title={dir ? `当前${dir === 'asc' ? '升序' : '降序'}，点击切换` : '点击升序，再点降序'} onClick={event => props.onSort ? props.onSort(col) : openMenu(event)}>{columnLabel((fieldIndices.get(col) ?? 0))} {col}{dir ? (dir === 'asc' ? ' ▲' : ' ▼') : ''}</button>
                <button className="personal-header-menu" aria-label={`${col} 字段菜单`} title="字段菜单" onClick={event => { event.stopPropagation(); openMenu(event); }}>▾</button>
            </span>;
        })()}<span className="personal-col-resize" title="拖动调整列宽，双击适应内容" onDoubleClick={event => { event.preventDefault(); event.stopPropagation(); autoColumnWidth([col]); }} onPointerDown={event => resizeColumn(event, col, props.colWidths[col] ?? 160)}/></th>)}<th><button onClick={props.onAddField} title="新增字段">＋</button></th></tr></thead>
      <tbody>{sourceRows.map((row, sourceIndex) => {
            const ri = rowIndices.get(row.id) ?? -1;
            const parent = meta.parents?.[row.id];
            let depth = 0, current = parent;
            const seen = new Set<string>();
            while (current && !seen.has(current)) {
                seen.add(current);
                depth++;
                current = meta.parents?.[current];
            }
            const children = parentIds.has(row.id);
            const summary = children ? leafSummary(sheet, row.id) : undefined;
            const group = pinnedIds.has(row.id) ? undefined : props.groupField ? text(row.values[props.groupField]) || '未分组' : undefined;
            const previous = sourceIndex > 0 && !pinnedIds.has(sourceRows[sourceIndex - 1].id) && props.groupField ? text(sourceRows[sourceIndex - 1].values[props.groupField]) || '未分组' : undefined;
            const groupCollapsed = group !== undefined && collapsedGroups.includes(group);
            return <FragmentRow key={row.id} group={group !== previous ? group : undefined} collapsed={!!groupCollapsed} columns={cols.length + 2} onToggle={() => run('折叠分组', d => { const m = gridMeta(d); (m.collapsedGroupsByView ??= {})[viewId] = collapsedGroups.includes(group!) ? collapsedGroups.filter(g => g !== group) : [...collapsedGroups, group!]; })}>
          {!groupCollapsed && <tr data-record-id={row.id} data-frozen={frozenTops.has(row.id) || undefined} className={(row as Row & { contextOnly?: boolean }).contextOnly ? 'personal-context-row' : undefined} title={(row as Row & { contextOnly?: boolean }).contextOnly ? '筛选结果的祖先上下文行' : undefined} style={{ height: heights[row.id] ?? defaultHeight, '--bt-row-h': `${heights[row.id] ?? defaultHeight}px` } as CSSProperties} onDragStart={e => { const target = e.target as HTMLElement; if (!props.canReorder || !target.closest('.personal-row-head') || target.closest('input,textarea,button,.personal-row-resize')) {
                    e.preventDefault();
                    return;
                } selecting.current = false; draggedRow.current = row.id; }} onDragEnd={() => { draggedRow.current = null; }} onDragOver={e => { if (draggedRow.current)
                    e.preventDefault(); }} onDrop={e => { e.preventDefault(); const source = draggedRow.current; if (source)
                    run('移动行', d => moveSubtree(d, source, row.id)); draggedRow.current = null; }}>
            <th className="personal-row-head" draggable={props.canReorder} title={props.canReorder ? '拖动行号调整行顺序' : undefined} style={{ ...frozenRowStyle(row.id), zIndex: frozenTops.has(row.id) ? 6 : 3 }} onClick={event => { setSelection(old => ({ start: event.shiftKey && old ? { row: old.start.row, col: 0 } : { row: ri, col: 0 }, end: { row: ri, col: cols.length - 1 } })); root.current?.focus(); }} onContextMenu={event => { event.preventDefault(); if (!ids.includes(row.id))
                    setSelection({ start: { row: ri, col: 0 }, end: { row: ri, col: cols.length - 1 } }); openMenu(row.id, event.currentTarget, event.clientX, event.clientY); }}><span style={{ paddingLeft: Math.min(depth, 2) * 4 }}>{children ? <button title="折叠子行" onClick={event => { event.stopPropagation(); run('折叠子行', d => { const m = gridMeta(d); (m.collapsedByView ??= {})[viewId] = collapsedRows.includes(row.id) ? collapsedRows.filter(id => id !== row.id) : [...collapsedRows, row.id]; }); }}>{collapsedRows.includes(row.id) ? '▸' : '▾'}</button> : null}{config.showRowNumbers ? (recordIndices.get(row.id) ?? ri) + 1 : '•'}</span><button title="行详情" onClick={e => { e.stopPropagation(); props.onDetail(row.id); }}>↗</button><span className="personal-row-resize" title="拖动调整行高，双击适应内容" onClick={event => event.stopPropagation()} onPointerDown={event => resizeRow(event, row.id)} onDoubleClick={event => { event.stopPropagation(); autoRowHeight([row]); }}/></th>
            {cols.map((field, ci) => {
                        const merge = meta.merges?.find(m => m.rowIds.includes(row.id) && m.fields.includes(field));
                        const intact = merge && merge.rowIds.every(id => frozenTops.has(id) === frozenTops.has(row.id)) && merge.rowIds.every((id, i) => (rowIndices.get(id) ?? -1) === (rowIndices.get(merge.rowIds[0]) ?? -1) + i) && merge.fields.every((f, i) => cols.indexOf(f) === cols.indexOf(merge.fields[0]) + i) && (!props.groupField || merge.rowIds.every(id => text(visibleRowMap.get(id)?.values[props.groupField!]) === text(row.values[props.groupField!])));
                        if (intact && (merge.rowIds[0] !== row.id || merge.fields[0] !== field))
                            return null;
                        const value = intact ? merge.display : rawRecords.get(row.id)?.[field];
                        const displayValue = intact ? isFormula(merge.display) ? mergedFormulaRecords.get(row.id)?.[field] : merge.display : calculatedRecords.get(row.id)?.[field];
                        return <td key={field} data-row-index={ri} data-col-index={ci} data-row-id={row.id} data-field={field} rowSpan={intact ? merge.rowIds.length : undefined} colSpan={intact ? merge.fields.length : undefined} title={merge && !intact ? '部分合并区域，当前显示原值' : `${columnLabel((fieldIndices.get(field) ?? 0))}${(recordIndices.get(row.id) ?? ri) + 1}`} className={`${isSelected(ri, ci) ? 'personal-selected' : ''} ${merge ? 'personal-merged' : ''} ${duplicateIds.has(row.id) && extras.duplicateFields?.includes(field) ? 'personal-duplicate' : ''}`} style={{ ...frozenStyle(ci), ...frozenRowStyle(row.id), ...(frozenTops.has(row.id) && ci < renderedFrozenCount ? { zIndex: 5 } : {}), ...cellStyleCss(cellStyle(sheet, row.id, field)), textAlign: cellStyle(sheet, row.id, field).align ?? fieldDef(field).align ?? (fieldDef(field).type === 'number' ? 'right' : 'left'), ...conditionalStyle(sheet, row, field) }} onPointerDownCapture={event => startTouch(event, { row: ri, col: ci }, row.id)} onMouseDown={event => { if (event.button !== 0)
                            return; choose({ row: ri, col: ci }, event.shiftKey); selecting.current = true; setMenu(null); if (!(event.target as HTMLElement).closest('input,textarea,button,a'))
                            (event.currentTarget.querySelector<HTMLElement>('.spreadsheet-cell') ?? root.current)?.focus(); }} onMouseEnter={() => { if (selecting.current)
                            setSelection(old => old && (old.end.row !== ri || old.end.col !== ci) ? { ...old, end: { row: ri, col: ci } } : old); }} onMouseUp={() => { if (dragFill.current)
                            applyDragFill(ri); selecting.current = false; }} onContextMenu={event => { event.preventDefault(); if (Date.now() - lastTouch.current < 800) return; if (!isSelected(ri, ci))
                            choose({ row: ri, col: ci }); openMenu(row.id, event.currentTarget, event.clientX, event.clientY); }}>
                <Cell spreadsheet onNavigate={direction => navigate(ri, ci, direction)} def={intact ? { type: 'longtext' } : fieldDef(field)} value={value} displayValue={displayValue} colorful={config.colorfulTags} onCommit={next => run('编辑单元格', d => { if (intact) {
                            const m = gridMeta(d).merges?.find(m => m.id === merge.id);
                            if (m)
                                m.display = next;
                        }
                        else {
                            const rec = d.records.find(r => r.id === row.id);
                            if (rec)
                                rec[field] = next;
                        } })}/>
                {ci === 0 && summary && <small className="personal-summary">{summary.descendants} 子行{summary.descendants !== summary.count ? ` · ${summary.count} 叶子行` : ''}{meta.summary?.completionField ? ` · ${summary.complete}/${summary.count} 完成` : ''}{summary.number !== undefined ? ` · ${meta.summary?.operation ?? 'sum'} ${summary.number}` : ''}</small>}
                {selection && ri === Math.max(selection.start.row, selection.end.row) && ci === Math.max(selection.start.col, selection.end.col) && <button className="personal-fill-handle" aria-label="拖动填充" title="向下拖动填充" onMouseDown={event => { event.preventDefault(); event.stopPropagation(); dragFill.current = selection; selecting.current = false; }}/>}
              </td>;
                    })}<td style={frozenRowStyle(row.id)}/></tr>}
        </FragmentRow>;
        })}</tbody></table>{!sourceRows.length && <div className="personal-grid-empty">暂无记录<button onClick={() => run('新增行', d => { insertRows(d, undefined, 'below'); })}>新增行</button></div>}</div>
    <div className="personal-grid-status">
      <div className="personal-touch-controls" aria-label="触屏选区操作">
        <button aria-pressed={touchRange} onClick={() => setTouchRange(value => !value)}>范围选择{touchRange ? '：开' : '：关'}</button>
        <button disabled={!selection} onClick={() => {
            if (!selection) return;
            const point = selection.end;
            const cell = root.current?.querySelector<HTMLElement>(`td[data-row-index="${point.row}"][data-col-index="${point.col}"]`);
            const editor = cell?.querySelector<HTMLElement>('.spreadsheet-cell');
            if (editor) editor.dispatchEvent(new Event('personal-edit-cell'));
            else {
                const target = cell?.querySelector<HTMLElement>('.cell-select,input[type=checkbox],button[title="编辑"],input,textarea');
                if (target?.matches('input:not([type=checkbox]),textarea')) target.focus();
                else target?.click();
            }
        }}>编辑选中</button>
        <button disabled={!selection} onClick={event => { if (ids[0]) { const rect = event.currentTarget.getBoundingClientRect(); openMenu(ids[0], event.currentTarget, rect.left, rect.bottom); } }}>选区操作</button>
        <button disabled={!selection} onClick={event => show('fill', event.currentTarget)}>填充区域</button>
      </div>
      <div className="personal-status-groups">{columnGroups.map(group => <span className="personal-column-group" key={group.id}><button title={group.fields.join('、')} onClick={() => run('折叠列组', d => { const target = gridMeta(d).columnGroupsByView?.[viewId]?.find(item => item.id === group.id); if (target) target.collapsed = !target.collapsed; })}>{group.collapsed ? '▸' : '▾'} {group.name}</button><button title="移除列组" onClick={() => run('移除列组', d => { const m = gridMeta(d); if (m.columnGroupsByView) m.columnGroupsByView[viewId] = (m.columnGroupsByView[viewId] ?? []).filter(item => item.id !== group.id); })}>×</button></span>)}</div>
      <span className="personal-status-hint">Shift + 滚轮 横向滚动</span>
      <span className="personal-status-count">{ids.length && selectedCols.length ? `${ids.length} 行 × ${selectedCols.length} 列` : `${rows.length} 条记录`}</span>
      <label className="personal-status-toggle" title="拖动填充时按序列递增数值或日期"><input type="checkbox" checked={sequence} onChange={e => setSequence(e.target.checked)} />序列填充</label>
    </div>
    {menu && <FloatingPanel anchor={menu.anchor} role="menu" className="personal-context" onDismiss={() => setMenu(null)}>
      <div className="personal-format-toolbar" aria-label="单元格格式">
        <button aria-label="增粗" aria-pressed={formatEnabled('bold')} title="增粗 Ctrl/Cmd+B" onClick={() => toggleFormat('bold')}><b>B</b></button>
        <button aria-label="斜体" aria-pressed={formatEnabled('italic')} title="斜体 Ctrl/Cmd+I" onClick={() => toggleFormat('italic')}><i>I</i></button>
        <button aria-label="下划线" aria-pressed={formatEnabled('underline')} title="下划线 Ctrl/Cmd+U" onClick={() => toggleFormat('underline')}><u>U</u></button>
        <button aria-label="删除线" aria-pressed={formatEnabled('strikethrough')} title="删除线" onClick={() => toggleFormat('strikethrough')}><s>S</s></button>
      </div>
      <div className="personal-format-toolbar" aria-label="选区对齐"><button onClick={() => alignSelection('left')}>左对齐</button><button onClick={() => alignSelection('center')}>居中</button><button onClick={() => alignSelection('right')}>右对齐</button></div>
      <button onClick={() => run('清除单元格格式', candidate => formatCells(candidate, ids, selectedCols, null))}>清除格式</button><button disabled={selectedCols.length < 2} onClick={() => show('columnGroup')}>创建选中列的列组</button><hr />
      <button onClick={() => { props.onDetail(active); setMenu(null); }}>打开行详情</button><button onClick={() => { setSide('above'); show('insert'); }}>上方插入行</button><button onClick={() => { setSide('below'); show('insert'); }}>下方插入行 / 多行</button><button onClick={() => run('复制行', d => { for (const id of ids)
            insertRows(d, id, 'below', 1, true); })}>复制选中行</button><button onClick={() => { setParentMode(ids.length > 1 ? 'selected' : 'following'); show('parent'); }}>设置为父节点</button><button onClick={() => run('取消父节点归属', d => assignParent(d, undefined, ids))}>提升选中行到顶级</button>
      <hr /><button onClick={() => show('merge')}>合并区域 / 取消合并</button><button onClick={() => void copy()}>复制区域</button><button onClick={() => void readPaste('all')}>粘贴预览</button><button onClick={() => autoColumnWidth()}>自动列宽</button><button onClick={() => autoRowHeight()}>自动行高</button><button onClick={() => { setFreezeMode('selected'); show('freeze'); }}>冻结选中行</button><button onClick={() => show('fill')}>填充区域</button><button onClick={() => run('清空区域', d => fillCells(d, ids, selectedCols, null))}>清空区域</button>{props.onMoveToSheet && <button onClick={() => { props.onMoveToSheet?.(ids); setMenu(null); }}>移动到其他工作表</button>}<hr /><button onClick={() => { setDeleteMode('rows'); show('delete'); }}>删除选中行</button><button onClick={() => { setDeleteMode('columns'); show('delete'); }}>删除选中列</button>
    </FloatingPanel>}
    {dialog && <FloatingPanel anchor={lastAnchor.current ?? belowAnchor(root.current!)} className="personal-dialog" onDismiss={() => setDialog(null)}><h3>{{ insert: '插入行', parent: '父子行设置', merge: '合并单元格', paste: '粘贴预览', fill: '填充区域', summary: '父节点汇总', delete: '删除行', columnGroup: '创建列组', freeze: '冻结行' }[dialog]}</h3>
      {dialog === 'freeze' && <><label>冻结范围<select value={freezeMode} onChange={event => setFreezeMode(event.target.value as 'selected' | 'first')}><option value="selected" disabled={!ids.length}>当前选中的 {ids.length} 行</option><option value="first">当前可见的前 N 行</option></select></label>{freezeMode === 'first' && <label>行数<input type="number" min={1} max={rows.length} value={count} onChange={event => setCount(Number(event.target.value))}/></label>}<p>冻结行固定在表头下方，随行高自动调整；每个视图分别保存。</p><button onClick={() => run('冻结行', candidate => { if (freezeMode === 'first' && (!Number.isInteger(count) || count < 1 || count > rows.length)) throw new Error('请输入有效行数'); const extra = gridMeta(candidate) as ViewGridExtras; (extra.frozenRowsByView ??= {})[viewId] = freezeMode === 'selected' ? ids : rows.slice(0, count).map(row => row.id); setSelection(null); })}>冻结</button></>}
      {dialog === 'columnGroup' && <><label>列组名称<input value={groupName} onChange={event => setGroupName(event.target.value)} /></label><p>选中 {selectedCols.join('、')}。折叠后保留组内首个可见列。</p><button onClick={() => run('创建列组', d => createColumnGroup(d, viewId, groupName, selectedCols))}>创建</button></>}{dialog === 'insert' && <><label>插入位置<select value={side} onChange={e => setSide(e.target.value as 'above' | 'below')}><option value="above">上方</option><option value="below">下方</option></select></label><label>行数<input type="number" min={1} max={10000} value={count} onChange={e => setCount(Number(e.target.value))}/></label><p>排序视图按排序规则展示插入后的行。同级父节点归属自动继承。</p><button onClick={() => run('插入行', d => { insertRows(d, active, side, count); })}>插入</button></>}
      {dialog === 'parent' && <><p>以当前行作为父节点，归属使用稳定行 ID。</p><select value={parentMode} onChange={e => setParentMode(e.target.value as 'following' | 'selected')}><option value="selected">使用选中行作为子节点</option><option value="following">使用随后 N 行作为子节点</option></select>{parentMode === 'following' && <input type="number" min={1} value={count} onChange={e => setCount(Number(e.target.value))}/>}<button onClick={() => run('设置父子节点', d => { if (parentMode === 'following' && (!Number.isInteger(count) || count < 1))
            throw new Error('请输入有效行数'); const at = rows.findIndex(r => r.id === active); const children = parentMode === 'selected' ? ids.filter(id => id !== active) : rows.slice(at + 1, at + 1 + count).map(r => r.id); if (!children.length)
            throw new Error('请选择子行'); assignParent(d, active, children); })}>应用</button><button onClick={() => run('新增子行', d => { const added = insertRows(d, active, 'below'); assignParent(d, active, added); })}>新增空白子行</button></>}
      {dialog === 'merge' && <><p>{ids.length} 行 × {selectedCols.length} 列。原内容会保存供取消合并恢复。</p><div className="personal-preview">{selectedRows.map(row => <div key={row.id}>{selectedCols.map(f => text(row.values[f])).join(' | ')}</div>)}</div><label><input type="checkbox" checked={join} onChange={e => setJoin(e.target.checked)}/>拼接全部内容作为显示值</label><button onClick={() => run('合并区域', d => mergeCells(d, ids, selectedCols, join, rows.map(row => row.id), cols), true)}>合并</button>{selectedMerge && <><label><input type="checkbox" checked={keepDisplay} onChange={e => setKeepDisplay(e.target.checked)}/>编辑结果保留到左上格</label><button onClick={() => run('取消合并', d => unmergeCells(d, selectedMerge.id, keepDisplay))}>取消合并并恢复原值</button></>}</>}
      {dialog === 'paste' && <><p>目标从第 {top + 1} 行「{cols[left] ?? '新增列'}」开始，按当前可见行顺序写入。</p><label>粘贴方式<select value={pasteMode} onChange={event => setPasteMode(event.target.value as typeof pasteMode)}><option value="all">全部（内容与格式）</option><option value="values">仅数值 / 内容</option><option value="formats">仅格式</option></select></label><textarea aria-label="粘贴内容" placeholder="在此粘贴 Excel/WPS 区域" value={pasteText} onChange={e => { setPasteText(e.target.value); setPasteMatrix(null); setPasteStyles(undefined); setPasteEvaluatedValues(undefined); setPasteSourceCoordinates(undefined); }} onPaste={e => { e.stopPropagation(); e.preventDefault(); openPaste(e.clipboardData.getData('text/plain'), e.clipboardData.getData('text/html'), e.clipboardData.getData(CELL_CLIPBOARD_MIME), pasteMode); }}/><label><input type="checkbox" checked={expand} onChange={e => setExpand(e.target.checked)}/>超出列数时新增文本列</label>{pasteError && <p role="alert" className="personal-grid-error">{pasteError}</p>}{pastePlan && <><p>内容 {pastePlan.values?.updates.length ?? 0} 格 · 格式 {pastePlan.styleUpdates.length} 格，新增 {pastePlan.newRows.length} 行、{pastePlan.newFields.length} 列</p><div className="personal-preview">{(pastePlan.values?.updates ?? []).slice(0, 30).map((u, i) => <div key={i}>{u.id} · {u.field} → {text(u.value)}</div>)}</div>{pastePlan.errors.map((err, i) => <div key={i} className="personal-grid-error">{err}</div>)}<button disabled={!!pastePlan.errors.length || !(pastePlan.values?.updates.length || pastePlan.styleUpdates.length)} onClick={() => run('批量粘贴', d => applySelectivePaste(d, pastePlan!), true)}>确认粘贴</button></>}</>}
      {dialog === 'fill' && <><label>填充值<input value={fill} onChange={e => setFill(e.target.value)}/></label><p>所有目标字段类型验证通过后一次写入。空白值清空区域。</p><button onClick={() => run('批量填充', d => fillCells(d, ids, selectedCols, fill))}>应用到 {ids.length * selectedCols.length} 个单元格</button></>}
      {dialog === 'summary' && <><label>完成状态字段<select value={completion} onChange={e => setCompletion(e.target.value)}><option value="">不显示完成进度</option>{cols.map(f => <option key={f}>{f}</option>)}</select></label><label>数字字段<select value={number} onChange={e => setNumber(e.target.value)}><option value="">不显示数字汇总</option>{cols.filter(f => sheet.fields[f].type === 'number').map(f => <option key={f}>{f}</option>)}</select></label><label>统计方式<select value={operation} onChange={e => setOperation(e.target.value as typeof operation)}><option value="sum">求和</option><option value="average">平均</option><option value="min">最小</option><option value="max">最大</option></select></label><p>统计全部后代叶子行。完成值支持勾选或「已完成」「完成」「Done」。</p><button onClick={() => run('设置父节点汇总', d => { gridMeta(d).summary = { completionField: completion || undefined, numberField: number || undefined, operation }; })}>保存设置</button></>}
      {dialog === 'delete' && deleteMode === 'columns' && <><p>将删除选中的 {selectedCols.length} 列及其内容，操作前会创建快照。</p><p>{selectedCols.join('、')}</p><button onClick={() => run('删除选中列', candidate => {
          if (selectedCols.some(field => candidate.fields[field]?.primary)) throw new Error('主字段需要保留，请调整选区');
          for (const field of selectedCols) applySheetMessage(candidate, { type: 'deleteField', name: field });
      }, true)}>删除选中列</button></>}
      {dialog === 'delete' && deleteMode === 'rows' && <><p>将删除选中的 {ids.length} 行。父节点包含的子行可提升或一起删除。</p><button onClick={() => run('删除行并提升子行', d => deleteRows(d, ids, false), true)}>删除并提升子行</button><button onClick={() => run('删除子树', d => deleteRows(d, ids, true), true)}>连同全部子行删除</button><p>额外子行数 {new Set(ids.flatMap(id => descendants(sheet, id)).filter(id => !ids.includes(id))).size}</p></>}
      {error && <p role="alert" className="personal-grid-error">{error}</p>}<footer><button onClick={() => { setDialog(null); setError(''); }}>关闭</button></footer>
    </FloatingPanel>}
  </div>;
}
function FragmentRow({ group, collapsed, columns, onToggle, children }: {
    group?: string;
    collapsed: boolean;
    columns: number;
    onToggle: () => void;
    children: React.ReactNode;
}) {
    return <>{group !== undefined && <tr className="personal-group"><th colSpan={columns}><button onClick={onToggle}>{collapsed ? '▸' : '▾'} {group}</button></th></tr>}{children}</>;
}
