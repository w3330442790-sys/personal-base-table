import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { BaseDoc, Row } from '../../src/core/types';
import { applyPaste, assignParent, conditionalStyle, deleteRows, descendants, fillCells, gridMeta, insertRows, leafSummary, mergeCells, moveSubtree, parseTSV, planPaste, readGridMeta, unmergeCells, selectionClipboard, groupRows, createColumnGroup, visibleGroupColumns, type PastePlan } from '../../src/core/features';
import { Cell } from './Cell';
import { cellStyle, cellStyleCss, formatCells, toggleCellStyle, type CellStyle } from '../../src/core/cell-style';
import { applySheetMessage } from '../../src/core/messages';
import type { UIConfig } from './config';
import { FloatingPanel } from './FloatingPanel';
import { belowAnchor, pointerAnchor, type FloatingAnchor } from './floating';
import { gridWidth, rowHeaderWidth, ROW_HEADER_KEY } from './grid-layout';
interface Props {
    sheet: BaseDoc;
    rows: Row[];
    cols: string[];
    config: UIConfig;
    colWidths: Record<string, number>;
    frozen?: number;
    viewId?: string;
    groupField?: string;
    canReorder?: boolean;
    transact: (label: string, change: (sheet: BaseDoc) => void, destructive?: boolean) => void;
    onHeaderMenu: (col: string, x: number, y: number, element?: HTMLElement) => void;
    onResize: (col: string, width: number) => void;
    onReorderCols: (from: string, to: string) => void;
    onAddField: () => void;
    onDetail: (id: string) => void;
    onSelection?: (ids: string[], cols: string[]) => void;
    onMoveToSheet?: (ids: string[]) => void;
}
interface Point {
    row: number;
    col: number;
}
interface Selection {
    start: Point;
    end: Point;
}
type Dialog = 'insert' | 'parent' | 'merge' | 'paste' | 'fill' | 'summary' | 'delete' | 'columnGroup' | null;
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
export function WorkbookGrid(props: Props) {
    const { sheet, config, transact } = props;
    const sourceRows = groupRows(props.rows, props.groupField);
    const viewId = props.viewId ?? sheet.views[0]?.name ?? '全部';
    const meta = readGridMeta(sheet);
    const cols = visibleGroupColumns(sheet, viewId, props.cols);
    const columnGroups = meta.columnGroupsByView?.[viewId] ?? [];
    const collapsedRows = meta.collapsedByView?.[viewId] ?? meta.collapsed ?? [];
    const collapsedGroups = meta.collapsedGroupsByView?.[viewId] ?? meta.collapsedGroups ?? [];
    const rows = sourceRows.filter(row => !props.groupField || !collapsedGroups.includes(text(row.values[props.groupField]) || '未分组'));
    const root = useRef<HTMLDivElement>(null);
    const selecting = useRef(false);
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
    const [pasteMatrix, setPasteMatrix] = useState<string[][] | null>(null);
    const [expand, setExpand] = useState(false);
    const [error, setError] = useState('');
    const [completion, setCompletion] = useState(meta.summary?.completionField ?? '');
    const [number, setNumber] = useState(meta.summary?.numberField ?? '');
    const [operation, setOperation] = useState<'sum' | 'average' | 'min' | 'max'>(meta.summary?.operation ?? 'sum');
    const [sequence, setSequence] = useState(false);
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
    useEffect(() => { setSelection(null); setMenu(null); setDialog(null); }, [cols.join('\0'), viewId]);
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
    const resizeColumn = (event: React.MouseEvent<HTMLElement>, col: string, width: number) => {
        event.preventDefault();
        event.stopPropagation();
        resizeCleanup.current();
        const target = event.currentTarget.parentElement!;
        const start = event.clientX;
        const owner = target.ownerDocument.defaultView!;
        const nextWidth = (x: number) => col === ROW_HEADER_KEY ? Math.max(44, Math.min(160, width + x - start)) : Math.max(70, width + x - start);
        const move = (mouse: MouseEvent) => { target.style.width = `${nextWidth(mouse.clientX)}px`; };
        const cleanup = () => { owner.removeEventListener('mousemove', move); owner.removeEventListener('mouseup', up); };
        const up = (mouse: MouseEvent) => { cleanup(); props.onResize(col, nextWidth(mouse.clientX)); };
        resizeCleanup.current = cleanup;
        owner.addEventListener('mousemove', move);
        owner.addEventListener('mouseup', up);
    };
    const choose = (point: Point, extend = false) => { setSelection(old => ({ start: extend && old ? old.start : point, end: point })); };
    const focusPoint = (point: Point) => requestAnimationFrame(() => {
        const target = root.current?.querySelector<HTMLElement>(`td[data-row-index="${point.row}"][data-col-index="${point.col}"] .spreadsheet-cell`);
        (target ?? root.current)?.focus();
    });
    const navigate = (row: number, col: number, direction: 'up' | 'down' | 'left' | 'right') => {
        const point = { row: Math.max(0, Math.min(rows.length - 1, row + (direction === 'down' ? 1 : direction === 'up' ? -1 : 0))), col: Math.max(0, Math.min(cols.length - 1, col + (direction === 'right' ? 1 : direction === 'left' ? -1 : 0))) };
        choose(point);
        focusPoint(point);
    };
    const formatEnabled = (key: 'bold' | 'italic' | 'underline' | 'strikethrough') => ids.length > 0 && selectedCols.length > 0 && ids.every(id => selectedCols.every(field => cellStyle(sheet, id, field)[key]));
    const toggleFormat = (key: 'bold' | 'italic' | 'underline' | 'strikethrough') => run('修改单元格格式', candidate => toggleCellStyle(candidate, ids, selectedCols, key));
    const alignSelection = (align: CellStyle['align']) => run('设置选区对齐', candidate => formatCells(candidate, ids, selectedCols, { align }));
    const isSelected = (row: number, col: number) => !!selection && row >= Math.min(selection.start.row, selection.end.row) && row <= Math.max(selection.start.row, selection.end.row) && col >= Math.min(selection.start.col, selection.end.col) && col <= Math.max(selection.start.col, selection.end.col);
    const copyData = () => selectionClipboard(sheet, selectedRows, selectedCols);
    const copy = async () => {
        try {
            const data = copyData();
            if (navigator.clipboard.write && typeof ClipboardItem !== 'undefined')
                await navigator.clipboard.write([new ClipboardItem({ 'text/plain': new Blob([data.plain], { type: 'text/plain' }), 'text/html': new Blob([data.html], { type: 'text/html' }) })]);
            else
                await navigator.clipboard.writeText(data.plain);
            setMenu(null);
        }
        catch {
            setError('请在表格选区使用 Ctrl/Cmd+C 复制');
            setMenu(null);
        }
    };
    let pastePlan: PastePlan | undefined;
    if (dialog === 'paste') {
        try {
            pastePlan = planPaste(sheet, rows.map(r => r.id), cols, top, left, pasteMatrix ?? parseTSV(pasteText), expand);
        }
        catch (err) {
            pastePlan = { updates: [], newRows: [], newFields: [], errors: [(err as Error).message] };
        }
    }
    const openPaste = (plain = '', html = '') => { setPasteText(plain); setPasteMatrix(htmlMatrix(html) ?? null); setExpand(false); show('paste'); };
    const frozenStyle = (index: number): CSSProperties => index < (props.frozen ?? 0) ? { position: 'sticky', left: headerWidth + cols.slice(0, index).reduce((sum, col) => sum + (props.colWidths[col] ?? 160), 0), zIndex: 2, background: 'var(--background-primary, var(--vscode-editor-background))' } : {};
    const applyDragFill = (targetRow: number) => {
        const source = dragFill.current;
        if (!source || targetRow <= Math.max(source.start.row, source.end.row))
            return;
        const first = Math.min(source.start.row, source.end.row), last = Math.max(source.start.row, source.end.row);
        const firstCol = Math.min(source.start.col, source.end.col), lastCol = Math.max(source.start.col, source.end.col);
        const matrix = rows.slice(last + 1, targetRow + 1).map((_, i) => cols.slice(firstCol, lastCol + 1).map(field => {
            const value = rows[first + i % (last - first + 1)].values[field];
            if (sequence && typeof value === 'number')
                return value + (Math.floor(i / (last - first + 1)) + 1) * (last - first + 1);
            if (sequence && sheet.fields[field].type === 'date' && value) {
                const date = new Date(String(value));
                date.setUTCDate(date.getUTCDate() + (Math.floor(i / (last - first + 1)) + 1) * (last - first + 1));
                return date.toISOString().slice(0, 10);
            }
            return value;
        }));
        run(sequence ? '序列填充' : '拖动填充', d => applyPaste(d, planPaste(d, rows.map(r => r.id), cols, last + 1, firstCol, matrix)));
        setSelection({ start: source.start, end: { row: targetRow, col: lastCol } });
    };
    return <div className="personal-grid" style={{ "--personal-rownum-width": `${headerWidth}px` } as CSSProperties} ref={root} tabIndex={0} onKeyDown={event => {
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
        return; const data = copyData(); event.preventDefault(); event.clipboardData.setData('text/plain', data.plain); event.clipboardData.setData('text/html', data.html); }} onPaste={event => { if ((event.target as HTMLElement).matches('input,textarea'))
        return; event.preventDefault(); openPaste(event.clipboardData.getData('text/plain'), event.clipboardData.getData('text/html')); }}>
    <div className="personal-grid-tools"><span>{ids.length} 行 × {selectedCols.length} 列</span><button onClick={event => show('paste', event.currentTarget)}>粘贴预览</button><button onClick={event => show('summary', event.currentTarget)}>父节点汇总</button><label><input type="checkbox" checked={sequence} onChange={e => setSequence(e.target.checked)}/>序列填充</label>{columnGroups.map(group => <span className="personal-column-group" key={group.id}><button title={group.fields.join('、')} onClick={() => run('折叠列组', d => {const target = gridMeta(d).columnGroupsByView?.[viewId]?.find(item => item.id === group.id);if (target) target.collapsed = !target.collapsed;})}>{group.collapsed ? '▸' : '▾'} {group.name}</button><button title="移除列组" onClick={() => run('移除列组', d => {const m=gridMeta(d); if(m.columnGroupsByView) m.columnGroupsByView[viewId] = (m.columnGroupsByView[viewId] ?? []).filter(item => item.id !== group.id);})}>×</button></span>)}<span className="personal-grid-hint">拖选单元格 · Shift 扩选 · 右键操作 · 右下角拖动填充</span></div>
    {error && <div role="alert" className="personal-grid-error">{error}<button onClick={() => setError('')}>关闭</button></div>}
    <div className="personal-grid-scroll"><table className={`personal-grid-table ${config.wrapText ? 'wrap' : ''}`} style={{ fontSize: config.fontSize || undefined, width: gridWidth(cols, props.colWidths), minWidth: gridWidth(cols, props.colWidths) }}><colgroup><col style={{ width: headerWidth }}/>{cols.map(c => <col key={c} style={{ width: props.colWidths[c] ?? 160 }}/>)}<col style={{ width: 36 }}/></colgroup>
      <thead><tr><th className="personal-row-head" aria-label="行操作" style={{ width: headerWidth, minWidth: headerWidth, maxWidth: headerWidth }}>行<span className="personal-col-resize" title="拖动调整行号列宽度" onMouseDown={event => resizeColumn(event, ROW_HEADER_KEY, headerWidth)}/></th>{cols.map((col, ci) => <th key={col} data-field={col} style={frozenStyle(ci)} draggable onDragStart={() => { draggedCol.current = col; }} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); if (draggedCol.current)
        props.onReorderCols(draggedCol.current, col); draggedCol.current = null; }} onContextMenu={e => { e.preventDefault(); props.onHeaderMenu(col, e.clientX, e.clientY, e.currentTarget); }}><button onClick={e => { const header = e.currentTarget.closest("th")!; const rect = header.getBoundingClientRect(); props.onHeaderMenu(col, rect.left, rect.bottom + 4, header); }}>{col} ▾</button><span className="personal-col-resize" onMouseDown={event => resizeColumn(event, col, props.colWidths[col] ?? 160)}/></th>)}<th><button onClick={props.onAddField} title="新增字段">＋</button></th></tr></thead>
      <tbody>{sourceRows.map((row, sourceIndex) => {
            const ri = rows.findIndex(visible => visible.id === row.id);
            const parent = meta.parents?.[row.id];
            let depth = 0, current = parent;
            const seen = new Set<string>();
            while (current && !seen.has(current)) {
                seen.add(current);
                depth++;
                current = meta.parents?.[current];
            }
            const children = Object.values(meta.parents ?? {}).includes(row.id);
            const summary = children ? leafSummary(sheet, row.id) : undefined;
            const group = props.groupField ? text(row.values[props.groupField]) || '未分组' : undefined;
            const previous = sourceIndex > 0 && props.groupField ? text(sourceRows[sourceIndex - 1].values[props.groupField]) || '未分组' : undefined;
            const groupCollapsed = group !== undefined && collapsedGroups.includes(group);
            return <FragmentRow key={row.id} group={group !== previous ? group : undefined} collapsed={!!groupCollapsed} columns={cols.length + 2} onToggle={() => run('折叠分组', d => { const m = gridMeta(d); (m.collapsedGroupsByView ??= {})[viewId] = collapsedGroups.includes(group!) ? collapsedGroups.filter(g => g !== group) : [...collapsedGroups, group!]; })}>
          {!groupCollapsed && <tr className={(row as Row & { contextOnly?: boolean }).contextOnly ? 'personal-context-row' : undefined} title={(row as Row & { contextOnly?: boolean }).contextOnly ? '筛选结果的祖先上下文行' : undefined} style={{ height: config.rowHeight === 'compact' ? 30 : config.rowHeight === 'tall' ? 54 : 38 }} draggable={props.canReorder} onDragStart={e => { if ((e.target as HTMLElement).closest('input,textarea')) {
                    e.preventDefault();
                    return;
                } draggedRow.current = row.id; }} onDragOver={e => { if (draggedRow.current)
                    e.preventDefault(); }} onDrop={e => { e.preventDefault(); if (draggedRow.current)
                    run('移动行', d => moveSubtree(d, draggedRow.current!, row.id)); draggedRow.current = null; }}>
            <th className="personal-row-head" onClick={event => { setSelection(old => ({ start: event.shiftKey && old ? { row: old.start.row, col: 0 } : { row: ri, col: 0 }, end: { row: ri, col: cols.length - 1 } })); root.current?.focus(); }} onContextMenu={event => { event.preventDefault(); if (!ids.includes(row.id))
                    setSelection({ start: { row: ri, col: 0 }, end: { row: ri, col: cols.length - 1 } }); openMenu(row.id, event.currentTarget, event.clientX, event.clientY); }}><span style={{ paddingLeft: Math.min(depth, 2) * 4 }}>{children ? <button title="折叠子行" onClick={event => { event.stopPropagation(); run('折叠子行', d => { const m = gridMeta(d); (m.collapsedByView ??= {})[viewId] = collapsedRows.includes(row.id) ? collapsedRows.filter(id => id !== row.id) : [...collapsedRows, row.id]; }); }}>{collapsedRows.includes(row.id) ? '▸' : '▾'}</button> : null}{config.showRowNumbers ? ri + 1 : '•'}</span><button title="行详情" onClick={e => { e.stopPropagation(); props.onDetail(row.id); }}>↗</button></th>
            {cols.map((field, ci) => {
                        const merge = meta.merges?.find(m => m.rowIds.includes(row.id) && m.fields.includes(field));
                        const intact = merge && merge.rowIds.every((id, i) => rows.findIndex(r => r.id === id) === rows.findIndex(r => r.id === merge.rowIds[0]) + i) && merge.fields.every((f, i) => cols.indexOf(f) === cols.indexOf(merge.fields[0]) + i) && (!props.groupField || merge.rowIds.every(id => text(rows.find(r => r.id === id)?.values[props.groupField!]) === text(row.values[props.groupField!])));
                        if (intact && (merge.rowIds[0] !== row.id || merge.fields[0] !== field))
                            return null;
                        const value = intact ? merge.display : row.values[field];
                        return <td key={field} data-row-index={ri} data-col-index={ci} data-row-id={row.id} data-field={field} rowSpan={intact ? merge.rowIds.length : undefined} colSpan={intact ? merge.fields.length : undefined} title={merge && !intact ? '部分合并区域，当前显示原值' : undefined} className={`${isSelected(ri, ci) ? 'personal-selected' : ''} ${merge ? 'personal-merged' : ''}`} style={{ ...frozenStyle(ci), ...cellStyleCss(cellStyle(sheet, row.id, field)), textAlign: cellStyle(sheet, row.id, field).align ?? sheet.fields[field].align ?? (sheet.fields[field].type === 'number' ? 'right' : 'left'), ...conditionalStyle(sheet, row, field) }} onMouseDown={event => { if (event.button !== 0)
                            return; choose({ row: ri, col: ci }, event.shiftKey); selecting.current = true; setMenu(null); if (!(event.target as HTMLElement).closest('input,textarea,button,a'))
                            (event.currentTarget.querySelector<HTMLElement>('.spreadsheet-cell') ?? root.current)?.focus(); }} onMouseEnter={() => { if (selecting.current)
                            setSelection(old => old ? { ...old, end: { row: ri, col: ci } } : old); }} onMouseUp={() => { if (dragFill.current)
                            applyDragFill(ri); selecting.current = false; }} onContextMenu={event => { event.preventDefault(); if (!isSelected(ri, ci))
                            choose({ row: ri, col: ci }); openMenu(row.id, event.currentTarget, event.clientX, event.clientY); }}>
                <Cell spreadsheet onNavigate={direction => navigate(ri, ci, direction)} def={intact ? { type: 'longtext' } : sheet.fields[field]} value={value} colorful={config.colorfulTags} onCommit={next => run('编辑单元格', d => { if (intact) {
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
                    })}<td /></tr>}
        </FragmentRow>;
        })}</tbody></table>{!sourceRows.length && <div className="personal-grid-empty">暂无记录<button onClick={() => run('新增行', d => { insertRows(d, undefined, 'below'); })}>新增行</button></div>}</div>
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
      <hr /><button onClick={() => show('merge')}>合并区域 / 取消合并</button><button onClick={() => void copy()}>复制区域</button><button onClick={() => openPaste()}>粘贴预览</button><button onClick={() => show('fill')}>填充区域</button><button onClick={() => run('清空区域', d => fillCells(d, ids, selectedCols, null))}>清空区域</button>{props.onMoveToSheet && <button onClick={() => { props.onMoveToSheet?.(ids); setMenu(null); }}>移动到其他工作表</button>}<hr /><button onClick={() => { setDeleteMode('rows'); show('delete'); }}>删除选中行</button><button onClick={() => { setDeleteMode('columns'); show('delete'); }}>删除选中列</button>
    </FloatingPanel>}
    {dialog && <FloatingPanel anchor={lastAnchor.current ?? belowAnchor(root.current!)} className="personal-dialog" onDismiss={() => setDialog(null)}><h3>{{ insert: '插入行', parent: '父子行设置', merge: '合并单元格', paste: '粘贴预览', fill: '填充区域', summary: '父节点汇总', delete: '删除行', columnGroup: '创建列组' }[dialog]}</h3>
      {dialog === 'columnGroup' && <><label>列组名称<input value={groupName} onChange={event => setGroupName(event.target.value)} /></label><p>选中 {selectedCols.join('、')}。折叠后保留组内首个可见列。</p><button onClick={() => run('创建列组', d => createColumnGroup(d, viewId, groupName, selectedCols))}>创建</button></>}{dialog === 'insert' && <><label>插入位置<select value={side} onChange={e => setSide(e.target.value as 'above' | 'below')}><option value="above">上方</option><option value="below">下方</option></select></label><label>行数<input type="number" min={1} max={10000} value={count} onChange={e => setCount(Number(e.target.value))}/></label><p>排序视图按排序规则展示插入后的行。同级父节点归属自动继承。</p><button onClick={() => run('插入行', d => { insertRows(d, active, side, count); })}>插入</button></>}
      {dialog === 'parent' && <><p>以当前行作为父节点，归属使用稳定行 ID。</p><select value={parentMode} onChange={e => setParentMode(e.target.value as 'following' | 'selected')}><option value="selected">使用选中行作为子节点</option><option value="following">使用随后 N 行作为子节点</option></select>{parentMode === 'following' && <input type="number" min={1} value={count} onChange={e => setCount(Number(e.target.value))}/>}<button onClick={() => run('设置父子节点', d => { if (parentMode === 'following' && (!Number.isInteger(count) || count < 1))
            throw new Error('请输入有效行数'); const at = rows.findIndex(r => r.id === active); const children = parentMode === 'selected' ? ids.filter(id => id !== active) : rows.slice(at + 1, at + 1 + count).map(r => r.id); if (!children.length)
            throw new Error('请选择子行'); assignParent(d, active, children); })}>应用</button><button onClick={() => run('新增子行', d => { const added = insertRows(d, active, 'below'); assignParent(d, active, added); })}>新增空白子行</button></>}
      {dialog === 'merge' && <><p>{ids.length} 行 × {selectedCols.length} 列。原内容会保存供取消合并恢复。</p><div className="personal-preview">{selectedRows.map(row => <div key={row.id}>{selectedCols.map(f => text(row.values[f])).join(' | ')}</div>)}</div><label><input type="checkbox" checked={join} onChange={e => setJoin(e.target.checked)}/>拼接全部内容作为显示值</label><button onClick={() => run('合并区域', d => mergeCells(d, ids, selectedCols, join, rows.map(row => row.id), cols), true)}>合并</button>{selectedMerge && <><label><input type="checkbox" checked={keepDisplay} onChange={e => setKeepDisplay(e.target.checked)}/>编辑结果保留到左上格</label><button onClick={() => run('取消合并', d => unmergeCells(d, selectedMerge.id, keepDisplay))}>取消合并并恢复原值</button></>}</>}
      {dialog === 'paste' && <><p>目标从第 {top + 1} 行「{cols[left] ?? '新增列'}」开始，按当前可见行顺序写入。</p><textarea aria-label="粘贴内容" placeholder="在此粘贴 Excel/WPS 区域" value={pasteText} onChange={e => { setPasteText(e.target.value); setPasteMatrix(null); }} onPaste={e => { e.stopPropagation(); const html = e.clipboardData.getData('text/html'); if (html) {
            const matrix = htmlMatrix(html);
            if (matrix) {
                e.preventDefault();
                setPasteText(e.clipboardData.getData('text/plain'));
                setPasteMatrix(matrix);
            }
        } }}/><label><input type="checkbox" checked={expand} onChange={e => setExpand(e.target.checked)}/>超出列数时新增文本列</label>{pastePlan && <><p>{pastePlan.updates.length} 个单元格，新增 {pastePlan.newRows.length} 行、{pastePlan.newFields.length} 列</p><div className="personal-preview">{pastePlan.updates.slice(0, 30).map((u, i) => <div key={i}>{u.id} · {u.field} → {text(u.value)}</div>)}</div>{pastePlan.errors.map((err, i) => <div key={i} className="personal-grid-error">{err}</div>)}<button disabled={!!pastePlan.errors.length || !pastePlan.updates.length} onClick={() => run('批量粘贴', d => applyPaste(d, pastePlan!), true)}>确认粘贴</button></>}</>}
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
