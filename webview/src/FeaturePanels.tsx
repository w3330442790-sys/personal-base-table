import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { BaseDoc, FieldDef } from '../../src/core/types';
import type { StyleMap } from '../../src/core/cell-style';
import { genId } from '../../src/core/types';
import { typedValue } from '../../src/core/features';
import { DataToolsPanel } from './DataToolsPanel';
import { ImportPanel } from './ImportPanel';
import { parseCellAddress } from './address';
import { floatingPosition, visibleOwnerBounds, visibleViewport } from './floating';
import { addSheet, clone as copy, getSheet as sheetAt, workbook as personal, remapRecords } from '../../src/core/workbook';

type Rule = { id: string; field: string; op: string; value?: unknown; target: 'cell' | 'row'; color?: string; background?: string };
type Merge = { id: string; rowIds: string[]; fields: string[]; original: Record<string, unknown>; display?: unknown };
type Grid = { cellStyles?: StyleMap; rules?: Rule[]; summary?: { completionField?: string; numberField?: string; operation?: 'sum' | 'average' | 'min' | 'max' }; parents?: Record<string, string>; collapsed?: string[]; merges?: Merge[] };
type Template = { id: string; name: string; data: BaseDoc };
type Personal = { version: 1; id: string; main: { id: string; name: string }; sheets: Array<{ id: string; name: string; data: BaseDoc }>; order: string[]; templates?: Template[] };
type ExtendedDoc = BaseDoc & { personalGrid?: Grid; personal?: Personal };
export interface FeaturePanelsProps {
  panel: 'search' | 'format' | 'details' | 'templates' | 'history' | 'move' | 'data' | 'import' | null;
  onClose: () => void;
  sheet: BaseDoc;
  document: BaseDoc;
  sheetId: string;
  sheetNames: Array<{ id: string; name: string }>;
  selectedRows: string[];
  selectedCols: string[];
  detailId: string | null;
  transact: (label: string, change: (sheet: BaseDoc) => void, destructive?: boolean) => void;
  transactDocument: (label: string, change: (doc: BaseDoc) => void, destructive?: boolean) => void;
  snapshots: Array<{ id: string; label: string; createdAt: string; doc?: BaseDoc }>;
  onCreateSnapshot: () => void;
  onRestoreSnapshot: (id: string) => void;
  onReadSnapshot?: (id: string) => void;
  onNavigate?: (sheetId: string, rowId: string, field: string) => void;
  onOpenLink?: (target: string) => void;
  resolveResource?: (path: string) => string;
  onImportTable?: (doc: BaseDoc, name: string) => void;
  searchTab?: SearchTab;
}
const text = (value: unknown): string => Array.isArray(value) ? value.map(String).join(', ') : String(value ?? '');
const grid = (sheet: BaseDoc): Grid => ((sheet as ExtendedDoc).personalGrid ??= {});

export function convertPanelValue(value: unknown, def: FieldDef): unknown {
  if (value == null || value === '' || (Array.isArray(value) && !value.length)) return null;
  const raw = text(value).trim();
  switch (def.type) {
    case 'number':
    case 'date':
    case 'checkbox': return typedValue(value, def);
    case 'select':
      if (!(def.options ?? []).includes(String(value))) throw new Error('值不在字段选项内');
      return String(value);
    case 'multi': {
      const values = Array.isArray(value) ? value.map(String) : raw.split(/[,，]/).map(part => part.trim()).filter(Boolean);
      if (values.some(option => !(def.options ?? []).includes(option))) throw new Error('多选值不在字段选项内');
      return [...new Set(values)];
    }
    default: return String(value);
  }
}
export function replacePanelText(source: string, query: string, replacement: string, matchCase: boolean, whole: boolean): string {
  if (!query) return source;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return source.replace(new RegExp(whole ? `^${escaped}$` : escaped, matchCase ? 'g' : 'gi'), () => replacement);
}
export function instantiatePanelTemplate(source: BaseDoc): BaseDoc {
  return remapRecords(source);
}
export function diffPanelSheets(current: BaseDoc, snapshot: BaseDoc) {
  const added = (a: Record<string, unknown>, b: Record<string, unknown>) => Object.keys(b).filter(key => !Object.prototype.hasOwnProperty.call(a, key)).length;
  const changed = (a: Record<string, unknown>, b: Record<string, unknown>) => Object.keys(b).filter(key => Object.prototype.hasOwnProperty.call(a, key) && JSON.stringify(a[key]) !== JSON.stringify(b[key])).length;
  const a = Object.fromEntries(current.records.map(row => [String(row.id), row]));
  const b = Object.fromEntries(snapshot.records.map(row => [String(row.id), row]));
  return { fieldsAdded: added(current.fields, snapshot.fields), fieldsRemoved: added(snapshot.fields, current.fields), fieldsChanged: changed(current.fields, snapshot.fields), recordsAdded: added(a, b), recordsRemoved: added(b, a), recordsChanged: changed(a, b), settingsChanged: JSON.stringify(current.views) !== JSON.stringify(snapshot.views) || JSON.stringify((current as ExtendedDoc).personalGrid) !== JSON.stringify((snapshot as ExtendedDoc).personalGrid) };
}

export interface PanelDifference {
  kind: 'field' | 'row' | 'cell';
  change: 'added' | 'removed' | 'changed';
  field?: string;
  rowId?: string;
  before: unknown;
  after: unknown;
}
/** Values are oriented from the current document to the selected restore target. */
export function diffPanelDetails(current: BaseDoc, snapshot: BaseDoc, limit = 100): { entries: PanelDifference[]; total: number } {
  const entries: PanelDifference[] = [];
  let total = 0;
  const collect = (entry: PanelDifference) => {
    total++;
    if (entries.length < limit) entries.push(entry);
  };
  const compare = (before: Record<string, unknown>, after: Record<string, unknown>, kind: 'field' | 'cell', rowId?: string) => {
    for (const field of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (field === 'id' && kind === 'cell') continue;
      const had = Object.prototype.hasOwnProperty.call(before, field);
      const has = Object.prototype.hasOwnProperty.call(after, field);
      if (had === has && JSON.stringify(before[field]) === JSON.stringify(after[field])) continue;
      collect({ kind, rowId, field, change: !had ? 'added' : !has ? 'removed' : 'changed', before: before[field], after: after[field] });
    }
  };
  compare(current.fields, snapshot.fields, 'field');
  const beforeRows = new Map(current.records.map(row => [String(row.id), row]));
  const afterRows = new Map(snapshot.records.map(row => [String(row.id), row]));
  for (const rowId of new Set([...beforeRows.keys(), ...afterRows.keys()])) {
    const before = beforeRows.get(rowId);
    const after = afterRows.get(rowId);
    if (!before || !after) collect({ kind: 'row', rowId, change: before ? 'removed' : 'added', before: before ? rowId : undefined, after: after ? rowId : undefined });
    compare(before ?? {}, after ?? {}, 'cell', rowId);
  }
  return { entries, total };
}
function differenceValue(value: unknown): string {
  if (value === undefined) return '（不存在）';
  if (value === null) return '空值 null';
  if (value === '') return '空字符串 ""';
  return typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
}
export function HistorySheetDifference({ current, snapshot }: { current: BaseDoc; snapshot: BaseDoc }) {
  const diff = diffPanelSheets(current, snapshot);
  const details = diffPanelDetails(current, snapshot);
  const changes = { added: '新增', removed: '删除', changed: '修改' };
  return <>
    <p>字段新增 {diff.fieldsAdded}、删除 {diff.fieldsRemoved}、修改 {diff.fieldsChanged}</p>
    <p>记录新增 {diff.recordsAdded}、删除 {diff.recordsRemoved}、修改 {diff.recordsChanged}</p>
    {diff.settingsChanged && <p>视图或工作表设置有变化</p>}
    <p>显示 {details.entries.length} / {details.total} 项差异（当前值 → 恢复后）</p>
    <ol className="feature-differences">{details.entries.map((entry, index) => <li key={index}>
      <strong>{changes[entry.change]}{entry.kind === 'field' ? `字段「${entry.field}」` : entry.kind === 'row' ? `记录 ${entry.rowId}` : `记录 ${entry.rowId} / ${entry.field}`}</strong>
      <div className="feature-diff-values"><div><span>当前</span><pre>{differenceValue(entry.before)}</pre></div><div><span>恢复后</span><pre>{differenceValue(entry.after)}</pre></div></div>
    </li>)}</ol>
    {details.total > details.entries.length && <p>此工作表另有 {details.total - details.entries.length} 项差异，预览最多显示前 100 项。</p>}
  </>;
}

const titles = { search: '查找与替换', format: '条件格式与父行汇总', details: '行详情', templates: '模板', history: '历史快照', move: '跨表移动', data: '重复项与去重', import: '导入表格' };
export function FeaturePanels(props: FeaturePanelsProps) {
  const [searchTab, setSearchTab] = useState<SearchTab>('find');
  const panelRef = useRef<HTMLElement>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; left: number; top: number } | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number; maxWidth: number; maxHeight: number } | null>(null);
  const constrain = (left: number, top: number) => {
    const panel = panelRef.current;
    const owner = panel?.closest<HTMLElement>('.personal-workbook') ?? panel?.parentElement;
    const view = panel?.ownerDocument.defaultView;
    if (!panel || !owner || !view) return { left, top, maxWidth: 0, maxHeight: 0 };
    const rect = owner.getBoundingClientRect();
    const bounds = visibleOwnerBounds({ left: rect.left + owner.clientLeft, top: rect.top + owner.clientTop, width: owner.clientWidth, height: owner.clientHeight }, visibleViewport(view));
    const maxWidth = Math.max(0, bounds.width - 16);
    const maxHeight = Math.max(0, Math.min(owner.clientHeight - 64, bounds.height - 16));
    panel.style.maxWidth = `${maxWidth}px`;
    panel.style.maxHeight = `${maxHeight}px`;
    // Absolute offsets start at the containing block's padding edge, including scroll.
    const container = (panel.offsetParent as HTMLElement | null) ?? owner;
    const containerRect = container.getBoundingClientRect();
    const localLeft = rect.left + owner.clientLeft + bounds.left - containerRect.left - container.clientLeft + container.scrollLeft;
    const localTop = rect.top + owner.clientTop + bounds.top - containerRect.top - container.clientTop + container.scrollTop;
    return { ...floatingPosition(left, top, panel.offsetWidth, panel.offsetHeight, bounds.width, bounds.height, localLeft, localTop), maxWidth, maxHeight };
  };
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const owner = panel?.closest<HTMLElement>('.personal-workbook') ?? panel?.parentElement;
    const ownerWindow = panel?.ownerDocument.defaultView;
    if (!panel || !owner || !ownerWindow) return;
    const reclamp = () => setPosition(current => {
      const next = constrain(current?.left ?? panel.offsetLeft, current?.top ?? panel.offsetTop);
      return current && next.left === current.left && next.top === current.top && next.maxWidth === current.maxWidth && next.maxHeight === current.maxHeight ? current : next;
    });
    reclamp();
    const observer = ownerWindow.ResizeObserver ? new ownerWindow.ResizeObserver(reclamp) : null;
    observer?.observe(owner);
    observer?.observe(panel);
    ownerWindow.addEventListener('resize', reclamp);
    panel.ownerDocument.addEventListener('scroll', reclamp, true);
    ownerWindow.visualViewport?.addEventListener('resize', reclamp);
    ownerWindow.visualViewport?.addEventListener('scroll', reclamp);
    return () => {
      observer?.disconnect();
      ownerWindow.removeEventListener('resize', reclamp);
      panel.ownerDocument.removeEventListener('scroll', reclamp, true);
      ownerWindow.visualViewport?.removeEventListener('resize', reclamp);
      ownerWindow.visualViewport?.removeEventListener('scroll', reclamp);
      dragRef.current = null;
    };
  }, [props.panel]);
  const beginDrag = (event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || !event.isPrimary || (event.target as Element).closest('button, a, input, select, textarea')) return;
    const panel = panelRef.current;
    if (!panel) return;
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, left: panel.offsetLeft, top: panel.offsetTop };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  const moveDrag = (event: React.PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setPosition(constrain(drag.left + event.clientX - drag.startX, drag.top + event.clientY - drag.startY));
  };
  const endDrag = (event: React.PointerEvent<HTMLElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  if (!props.panel) return null;
  return <aside ref={panelRef} className={`feature-panel${props.panel === 'search' ? ' search-panel' : ''}`} role="dialog" aria-label={titles[props.panel]} style={position ? { ...position, right: 'auto' } : undefined} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); props.onClose(); } }}>
    <header title="拖动标题栏移动窗口" onPointerDown={beginDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={() => { dragRef.current = null; }}>
      {props.panel === 'search' ? <div className="search-tabs search-header-tabs" role="tablist" aria-label="查找操作">
        {([
          ['find', '查找'],
          ['replace', '替换'],
          ['goto', '定位'],
        ] as const).map(([value, label]) => <button key={value} type="button" role="tab" aria-selected={searchTab === value} onClick={() => setSearchTab(value)}>{label}</button>)}
      </div> : <h2>{titles[props.panel]}</h2>}
      <button aria-label="关闭面板" onClick={props.onClose}>×</button>
    </header>
    <div className="feature-panel-body">
      {props.panel === 'search' && <SearchPanel {...props} searchTab={searchTab} />}
      {props.panel === 'format' && <FormatPanel {...props} />}
      {props.panel === 'details' && <DetailsPanel key={`${props.sheetId}:${props.detailId}`} {...props} />}
      {props.panel === 'templates' && <TemplatesPanel {...props} />}
      {props.panel === 'history' && <HistoryPanel {...props} />}
      {props.panel === 'move' && <MovePanel key={props.sheetId} {...props} />}
      {props.panel === 'data' && <DataToolsPanel key={props.sheetId} sheet={props.sheet} selectedRows={props.selectedRows} selectedCols={props.selectedCols} transact={props.transact} />}
      {props.panel === 'import' && props.onImportTable && <ImportPanel onClose={props.onClose} onImportTable={props.onImportTable} />}
    </div>
  </aside>;
}
function ErrorMessage({ message }: { message: string }) { return message ? <p className="feature-error" role="alert">{message}</p> : null; }

type SearchTab = 'find' | 'replace' | 'goto';
type SearchMatch = { sheetId: string; sheetName: string; rowId: string; field: string; before: unknown; after: unknown; invalid: string };

function SearchPanel(props: FeaturePanelsProps & { searchTab: SearchTab }) {
  const tab = props.searchTab;
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [scope, setScope] = useState('sheet');
  const [matchCase, setMatchCase] = useState(false);
  const [whole, setWhole] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [active, setActive] = useState<number | null>(null);
  const [goto, setGoto] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [error, setError] = useState('');
  const matches: SearchMatch[] = [];
  const names = scope === 'workbook' ? props.sheetNames : props.sheetNames.filter(item => item.id === props.sheetId);
  if (query) for (const name of names) {
    const sheet = sheetAt(props.document, name.id);
    for (const record of sheet.records) for (const [field, def] of Object.entries(sheet.fields)) {
      if (scope === 'column' && !props.selectedCols.includes(field)) continue;
      if (scope === 'selection' && (!props.selectedCols.includes(field) || !props.selectedRows.includes(String(record.id)))) continue;
      const before = record[field];
      const replace = (value: unknown) => replacePanelText(text(value), query, replacement, matchCase, whole);
      const present = (value: unknown) => replacePanelText(text(value), query, '\u0000', matchCase, whole) !== text(value);
      if (!(Array.isArray(before) ? before.some(present) : present(before))) continue;
      let after: unknown;
      let invalid = '';
      try {
        if ((sheet as ExtendedDoc).personalGrid?.merges?.some(merge => merge.rowIds.includes(String(record.id)) && merge.fields.includes(field))) throw new Error('此单元格属于合并区域，请先取消合并再替换');
        after = convertPanelValue(Array.isArray(before) ? before.map(replace) : replace(before), def);
      }
      catch (failure) { invalid = String((failure as Error).message); }
      matches.push({ sheetId: name.id, sheetName: name.name, rowId: String(record.id), field, before, after, invalid });
    }
  }
  const invalidCount = matches.filter(item => item.invalid).length;
  const current = matches[Math.min(active ?? 0, Math.max(0, matches.length - 1))];
  const updateQuery = (value: string) => { setQuery(value); setActive(null); setError(''); };
  const changeScope = (value: string) => { setScope(value); setActive(null); setError(''); };
  const remember = (value: string) => {
    const trimmed = value.trim();
    if (trimmed) setHistory(previous => [trimmed, ...previous.filter(item => item !== trimmed)].slice(0, 8));
  };
  const requireMatches = (): boolean => {
    setError('');
    if (!query.trim()) { setError('请输入查找内容'); return false; }
    if (scope === 'column' && !props.selectedCols.length) { setError('请先选择要查找的列'); return false; }
    if (scope === 'selection' && (!props.selectedCols.length || !props.selectedRows.length)) { setError('请先选择要查找的区域'); return false; }
    if (!matches.length) { setError('没有找到匹配的单元格'); return false; }
    return true;
  };
  const navigate = (index: number) => {
    const item = matches[index];
    if (!item) return;
    setActive(index);
    setError('');
    remember(query);
    props.onNavigate?.(item.sheetId, item.rowId, item.field);
  };
  const findNext = () => {
    if (!requireMatches()) return;
    navigate(active === null ? 0 : (active + 1) % matches.length);
  };
  const findPrevious = () => {
    if (!requireMatches()) return;
    navigate(active === null ? matches.length - 1 : (active - 1 + matches.length) % matches.length);
  };
  const findAll = () => {
    if (!requireMatches()) return;
    setActive(0);
    remember(query);
  };
  const applyReplace = (items: SearchMatch[]) => {
    setError('');
    if (!items.length) { setError('没有可替换的单元格'); return; }
    if (items.some(item => item.invalid)) { setError('请修正预览中的类型冲突后再替换'); return; }
    try {
      props.transactDocument(items.length === 1 ? '替换单元格' : '全部替换', doc => {
        for (const item of items) {
          const sheet = sheetAt(doc, item.sheetId);
          const record = sheet.records.find(row => row.id === item.rowId);
          if (!record || JSON.stringify(record[item.field]) !== JSON.stringify(item.before)) throw new Error('记录已变化，请重新预览');
          record[item.field] = convertPanelValue(item.after, sheet.fields[item.field]);
        }
      }, true);
      remember(query);
      setActive(null);
    } catch (failure) { setError((failure as Error).message); }
  };
  const replaceCurrent = () => {
    if (!current) { setError('没有可替换的单元格'); return; }
    if (!requireMatches()) return;
    applyReplace([current]);
  };
  const replaceAll = () => {
    if (!requireMatches()) return;
    if (invalidCount) { setError('请修正预览中的类型冲突后再替换'); return; }
    applyReplace(matches);
  };
  const goTo = () => {
    setError('');
    const target = parseCellAddress(goto, Object.keys(props.sheet.fields), props.sheet.records.map(record => ({ id: String(record.id) })));
    if (!target) { setError('请输入有效的 A1 地址（例如 C5）'); return; }
    props.onNavigate?.(props.sheetId, target.rowId, target.field);
  };
  return <div className="search-dialog">
    {tab === 'goto' ? <div className="search-card">
      <label className="search-row"><span>单元格</span><input autoFocus value={goto} placeholder="例如 C5" onChange={event => { setGoto(event.target.value); setError(''); }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); goTo(); } }} /></label>
      <p className="search-hint">输入当前工作表中的 A1 地址，定位到对应记录和字段。</p>
      <ErrorMessage message={error} />
      <div className="search-footer"><span className="search-spacer" /><button type="button" className="primary" onClick={goTo}>定位</button></div>
    </div> : <>
      <div className="search-card">
        <label className="search-row">
          <span>查找</span>
          <input list="personal-base-table-search-history" autoFocus placeholder="输入要查找的内容" value={query} onChange={event => updateQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); findNext(); } }} />
        </label>
        <datalist id="personal-base-table-search-history">{history.map(value => <option key={value} value={value} />)}</datalist>
        {tab === 'replace' && <label className="search-row"><span>替换为</span><input value={replacement} onChange={event => setReplacement(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); replaceCurrent(); } }} /></label>}
        <div className="search-scope">
          <span>范围</span>
          <label><input type="radio" checked={scope !== 'workbook'} onChange={() => changeScope('sheet')} />当前工作表</label>
          <label><input type="radio" checked={scope === 'workbook'} onChange={() => changeScope('workbook')} />所有工作表</label>
        </div>
        <button type="button" className="search-more" aria-expanded={advanced} onClick={() => setAdvanced(value => !value)}>更多选项 <span aria-hidden="true">{advanced ? '⌃' : '⌄'}</span></button>
        {advanced && <div className="search-options">
          <label><span>范围</span><select value={scope === 'workbook' ? 'sheet' : scope} disabled={scope === 'workbook'} onChange={event => changeScope(event.target.value)}><option value="sheet">整张工作表</option><option value="column">选中列</option><option value="selection">选中区域</option></select></label>
          <label><input type="checkbox" checked={matchCase} onChange={event => { setMatchCase(event.target.checked); setActive(null); }} />区分大小写</label>
          <label><input type="checkbox" checked={whole} onChange={event => { setWhole(event.target.checked); setActive(null); }} />全字匹配（整个单元格或选项）</label>
        </div>}
        <ErrorMessage message={error} />
        <div className="search-footer">
          <button type="button" onClick={findAll} disabled={!query.trim()}>查找全部</button>
          {tab === 'replace' && <button type="button" onClick={replaceAll} disabled={!matches.length || invalidCount > 0}>全部替换</button>}
          <span className="search-count" role="status">{query.trim() ? `${matches.length} 个结果${invalidCount ? ` · ${invalidCount} 个类型冲突` : ''}` : ''}</span>
          <span className="search-spacer" />
          <button type="button" aria-label="上一个结果" title="上一个结果" onClick={findPrevious} disabled={!matches.length}>‹</button>
          <button type="button" aria-label="下一个结果" title="下一个结果" onClick={findNext} disabled={!matches.length}>›</button>
          <button type="button" className="primary" onClick={tab === 'replace' ? replaceCurrent : findNext} disabled={!query.trim() || (tab === 'replace' && (!current || !!current.invalid))}>{tab === 'replace' ? '替换' : '查找'}</button>
        </div>
      </div>
      {matches.length > 0 && <ol className="search-results" aria-label="查找结果">
        {matches.map((item, index) => <li key={`${item.sheetId}:${item.rowId}:${item.field}`} className={index === active ? 'active' : ''}>
          <button type="button" className="search-result" title="定位到此单元格" onClick={() => navigate(index)}>
            <span className="search-result-path">{item.sheetName} / {item.field} / {item.rowId}</span>
            <span className="search-result-value">{text(item.before)}</span>
            {tab === 'replace' && <span className="search-result-value">→ {text(item.after)}</span>}
          </button>
          {item.invalid && <p className="feature-error">{item.invalid}</p>}
        </li>)}
      </ol>}
    </>}
  </div>;
}

const operators = [['contains', '包含'], ['notContains', '不包含'], ['is', '等于'], ['isNot', '不等于'], ['empty', '为空'], ['notEmpty', '非空'], ['gt', '大于'], ['lt', '小于'], ['gte', '大于等于'], ['lte', '小于等于'], ['checked', '已勾选'], ['unchecked', '未勾选'], ['before', '日期早于'], ['after', '日期晚于']];
function FormatPanel(props: FeaturePanelsProps) {
  const settings = (props.sheet as ExtendedDoc).personalGrid ?? {};
  const fields = Object.keys(props.sheet.fields);
  const update = (id: string, change: Partial<Rule>) => props.transact('修改条件格式', sheet => { const rule = grid(sheet).rules?.find(item => item.id === id); if (rule) Object.assign(rule, change); });
  const add = (preset: number) => props.transact('新增条件格式', sheet => {
    const field = (preset === 1 ? fields.find(name => sheet.fields[name].type === 'checkbox') : fields.find(name => ['text', 'longtext', 'select', 'multi'].includes(sheet.fields[name].type))) ?? fields[0] ?? '';
    (grid(sheet).rules ??= []).push({ id: genId(), field, op: preset === 1 ? 'unchecked' : 'contains', value: preset === 0 ? '重点' : preset === 2 ? '易混' : '', target: 'row', color: preset === 1 ? '#b45309' : '#b91c1c', background: preset === 2 ? '#fef3c7' : '' });
  });
  return <>
    <p>规则按列表顺序应用，后面的规则优先。使用上移或下移按钮调整顺序。</p>
    <div className="feature-actions">{['重点', '未完成', '易混项'].map((name, index) => <button key={name} disabled={!fields.length} onClick={() => add(index)}>新增{name}规则</button>)}</div>
    {(settings.rules ?? []).map((rule, index) => <fieldset key={rule.id}><legend>规则 {index + 1}</legend>
      <label>作用字段<select value={rule.field} onChange={event => update(rule.id, { field: event.target.value })}>{fields.map(field => <option key={field}>{field}</option>)}</select></label>
      <label>条件<select value={rule.op} onChange={event => update(rule.id, { op: event.target.value })}>{operators.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      {!['empty', 'notEmpty', 'checked', 'unchecked'].includes(rule.op) && <label>条件值<input value={text(rule.value)} onChange={event => update(rule.id, { value: event.target.value })} /></label>}
      <label>应用范围<select value={rule.target} onChange={event => update(rule.id, { target: event.target.value as Rule['target'] })}><option value="cell">单元格</option><option value="row">整行</option></select></label>
      <label>文字颜色<input type="color" value={rule.color || '#000000'} onChange={event => update(rule.id, { color: event.target.value })} /></label>
      <label>背景颜色<input type="color" value={rule.background || '#ffffff'} onChange={event => update(rule.id, { background: event.target.value })} /></label>
      <div className="feature-actions"><button onClick={() => update(rule.id, { color: '', background: '' })}>清除配色</button>
        {[-1, 1].map(direction => <button key={direction} disabled={index + direction < 0 || index + direction >= (settings.rules?.length ?? 0)} onClick={() => props.transact('调整规则顺序', sheet => { const rules = grid(sheet).rules!; [rules[index], rules[index + direction]] = [rules[index + direction], rules[index]]; })}>{direction === -1 ? '上移' : '下移'}</button>)}
        <button onClick={() => props.transact('删除条件格式', sheet => { grid(sheet).rules = grid(sheet).rules?.filter(item => item.id !== rule.id); })}>删除规则</button></div>
    </fieldset>)}
    <fieldset><legend>父行汇总（全部后代叶子行）</legend>
      <label>完成状态字段<select value={settings.summary?.completionField ?? ''} onChange={event => props.transact('设置完成汇总', sheet => { (grid(sheet).summary ??= {}).completionField = event.target.value; })}><option value="">不显示完成进度</option>{Object.entries(props.sheet.fields).filter(([, def]) => ['checkbox', 'select'].includes(def.type)).map(([field]) => <option key={field}>{field}</option>)}</select></label>
      <label>数字字段<select value={settings.summary?.numberField ?? ''} onChange={event => props.transact('设置数字汇总', sheet => { (grid(sheet).summary ??= {}).numberField = event.target.value; })}><option value="">不汇总数字</option>{Object.entries(props.sheet.fields).filter(([, def]) => def.type === 'number').map(([field]) => <option key={field}>{field}</option>)}</select></label>
      <label>汇总方式<select value={settings.summary?.operation ?? 'sum'} onChange={event => props.transact('设置汇总方式', sheet => { (grid(sheet).summary ??= {}).operation = event.target.value as 'sum'; })}><option value="sum">求和</option><option value="average">平均</option><option value="min">最小值</option><option value="max">最大值</option></select></label>
    </fieldset>
  </>;
}

function safeResource(target: string, resolver?: (path: string) => string): string | undefined {
  if (/^(javascript|data|vbscript):/i.test(target.trim())) return undefined;
  const resolved = /^https?:\/\//i.test(target) ? target : resolver?.(target);
  if (!resolved || /^(javascript|data|vbscript):/i.test(resolved.trim())) return undefined;
  return resolved;
}
function DetailsPanel(props: FeaturePanelsProps) {
  const record = props.sheet.records.find(row => row.id === props.detailId);
  const [error, setError] = useState('');
  if (!record) return <p>请先选择要查看的记录。</p>;
  const commit = (field: string, value: unknown) => {
    setError('');
    try {
      const next = convertPanelValue(value, props.sheet.fields[field]);
      props.transact('修改行详情', sheet => {
        const merge = grid(sheet).merges?.find(item => item.rowIds.includes(props.detailId!) && item.fields.includes(field));
        if (merge) { merge.display = next; return; }
        const row = sheet.records.find(item => item.id === props.detailId);
        if (row) row[field] = next;
      });
    } catch (failure) { setError((failure as Error).message); }
  };
  return <><p className="feature-muted">记录 {String(record.id)}</p><ErrorMessage message={error} />{Object.entries(props.sheet.fields).map(([field, def]) => {
    const merge = (props.sheet as ExtendedDoc).personalGrid?.merges?.find(item => item.rowIds.includes(String(record.id)) && item.fields.includes(field));
    return <div key={field}>{merge && <p>「{field}」属于合并区域，修改将更新区域显示值。</p>}<DetailField field={field} def={def} value={merge ? merge.display : record[field]} onCommit={value => commit(field, value)} {...{ onOpenLink: props.onOpenLink, resolveResource: props.resolveResource }} /></div>;
  })}</>;
}
export function DetailField({ field, def, value, onCommit, onOpenLink, resolveResource }: { field: string; def: FieldDef; value: unknown; onCommit: (value: unknown) => void; onOpenLink?: (target: string) => void; resolveResource?: (path: string) => string }) {
  const [draft, setDraft] = useState(text(value));
  useEffect(() => setDraft(text(value)), [value]);
  const references = [...text(value).matchAll(/!?\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g)];
  const direct = def.type === 'link' && text(value) && !references.length ? [{ target: text(value), label: text(value) }] : [];
  const markdown = [...text(value).matchAll(/!?\[([^\]]*)\]\((<[^>]+>|[^)]+)\)/g)].map(match => {
    const target = match[2].replace(/^<|>$/g, '').replace(/\s+["'][^"']*["']$/, '').trim();
    return { target, label: match[1] || target };
  });
  const links = [...references.map(match => ({ target: match[1], label: match[2] || match[1] })), ...markdown, ...direct];
  return <fieldset><legend>{field}</legend>
    {def.type === 'checkbox' ? <label className="feature-inline"><input aria-label={field} type="checkbox" checked={value === true} onChange={event => onCommit(event.target.checked)} />已完成</label>
      : def.type === 'select' ? <select aria-label={field} value={text(value)} onChange={event => onCommit(event.target.value)}><option value="">空值</option>{def.options?.map(option => <option key={option}>{option}</option>)}</select>
      : def.type === 'multi' ? <div>{def.options?.map(option => <label className="feature-inline" key={option}><input type="checkbox" checked={Array.isArray(value) && value.includes(option)} onChange={event => onCommit(event.target.checked ? [...(Array.isArray(value) ? value : []), option] : (Array.isArray(value) ? value : []).filter(item => item !== option))} />{option}</label>)}</div>
      : <>{def.type === 'longtext' ? <textarea aria-label={field} rows={6} value={draft} onChange={event => setDraft(event.target.value)} /> : <input aria-label={field} type={def.type === 'number' ? 'number' : def.type === 'date' ? 'date' : 'text'} value={draft} onChange={event => setDraft(event.target.value)} />}<button disabled={draft === text(value)} onClick={() => onCommit(draft)}>保存{field}</button></>}
    {links.map(({ target, label }, index) => { const url = safeResource(target, resolveResource); return <div key={`${target}:${index}`} className="feature-attachment">
      {onOpenLink && !/^(javascript|data|vbscript):/i.test(target.trim()) && <button onClick={() => onOpenLink(target)}>打开 {label}</button>}
      {url && /\.(png|jpe?g|gif|webp|svg)(?:[?#].*)?$/i.test(target) && <img src={url} alt={label} loading="lazy" />}
      {url && /\.pdf(?:[?#].*)?$/i.test(target) && <iframe src={url} title={`预览 ${label}`} sandbox="" loading="lazy" />}
      {url && /\.(mp3|wav|ogg|m4a|flac)(?:[?#].*)?$/i.test(target) && <audio src={url} controls preload="metadata">{label}</audio>}
      {url && /\.(mp4|webm|mov)(?:[?#].*)?$/i.test(target) && <video src={url} controls preload="metadata">{label}</video>}
      {url && !onOpenLink && <a href={url} target="_blank" rel="noreferrer">{label}</a>}
    </div>; })}
  </fieldset>;
}

function descendantIds(sheet: BaseDoc, selected: string[]): Set<string> {
  const ids = new Set(selected);
  const parents = (sheet as ExtendedDoc).personalGrid?.parents ?? {};
  let changed = true;
  while (changed) {
    changed = false;
    for (const [child, parent] of Object.entries(parents)) if (ids.has(parent) && !ids.has(child)) { ids.add(child); changed = true; }
  }
  return ids;
}
function templateData(sheet: BaseDoc, mode: string, selected: string[]): BaseDoc {
  const result = copy(sheet) as ExtendedDoc;
  delete result.personal;
  if (mode === 'fields') result.records = [];
  if (mode === 'subtree') {
    const ids = descendantIds(sheet, selected);
    result.records = result.records.filter(row => ids.has(String(row.id)));
  }
  const ids = new Set(result.records.map(row => String(row.id)));
  if (result.personalGrid) {
    if (result.personalGrid.cellStyles) result.personalGrid.cellStyles = Object.fromEntries(Object.entries(result.personalGrid.cellStyles).filter(([id]) => ids.has(id)));
    result.personalGrid.parents = Object.fromEntries(Object.entries(result.personalGrid.parents ?? {}).filter(([child, parent]) => ids.has(child) && ids.has(parent)));
    result.personalGrid.collapsed = (result.personalGrid.collapsed ?? []).filter(id => ids.has(id));
    result.personalGrid.merges = (result.personalGrid.merges ?? []).filter(merge => merge.rowIds.every(id => ids.has(id)));
  }
  return result;
}
function TemplatesPanel(props: FeaturePanelsProps) {
  const [name, setName] = useState('');
  const [mode, setMode] = useState('fields');
  const [error, setError] = useState('');
  const templates = (props.document as ExtendedDoc).personal?.templates ?? [];
  const save = () => {
    setError('');
    if (!name.trim()) { setError('请输入模板名称'); return; }
    if (mode === 'subtree' && !props.selectedRows.length) { setError('请先选择父行或记录'); return; }
    props.transactDocument('保存模板', doc => { (personal(doc).templates ??= []).push({ id: genId(), name: name.trim(), data: templateData(props.sheet, mode, props.selectedRows) }); });
    setName('');
  };
  const insert = (template: Template) => {
    setError('');
    try {
      const instance = instantiatePanelTemplate(template.data) as ExtendedDoc;
      for (const [field, def] of Object.entries(instance.fields)) {
        if (!props.sheet.fields[field]) throw new Error(`目标表缺少字段「${field}」，可使用新建工作表`);
        if (props.sheet.fields[field].type !== def.type) throw new Error(`字段「${field}」类型不同`);
      }
      for (const row of instance.records) for (const field of Object.keys(instance.fields)) row[field] = convertPanelValue(row[field], props.sheet.fields[field]);
      props.transact('插入模板记录', sheet => {
        sheet.records.push(...instance.records);
        const target = grid(sheet);
        target.parents = { ...target.parents, ...instance.personalGrid?.parents };
        if (instance.personalGrid?.cellStyles) target.cellStyles = { ...target.cellStyles, ...instance.personalGrid.cellStyles };
        target.collapsed = [...(target.collapsed ?? []), ...(instance.personalGrid?.collapsed ?? [])];
        target.merges = [...(target.merges ?? []), ...(instance.personalGrid?.merges ?? [])];
      });
    } catch (failure) { setError((failure as Error).message); }
  };
  return <>
    <label>模板名称<input value={name} onChange={event => setName(event.target.value)} /></label>
    <label>保存内容<select value={mode} onChange={event => setMode(event.target.value)}><option value="fields">字段、视图和规则</option><option value="all">完整工作表（含记录）</option><option value="subtree">选中记录及全部子行</option></select></label>
    <button onClick={save}>保存为模板</button><ErrorMessage message={error} />
    {!templates.length && <p>此文件还没有模板。</p>}
    {templates.map(template => <fieldset key={template.id}><legend>{template.name}</legend><p>{Object.keys(template.data.fields).length} 个字段，{template.data.records.length} 条记录</p>
      <div className="feature-actions"><button onClick={() => props.transactDocument('从模板新建工作表', doc => { addSheet(doc, template.name, instantiatePanelTemplate(template.data)); })}>新建工作表</button>
        <button disabled={!template.data.records.length} onClick={() => insert(template)}>插入记录到当前表</button>
        <button onClick={() => props.transactDocument('删除模板', doc => { personal(doc).templates = personal(doc).templates?.filter(item => item.id !== template.id); })}>删除模板</button></div>
    </fieldset>)}
  </>;
}

function MovePanel(props: FeaturePanelsProps) {
  const destinations = props.sheetNames.filter(item => item.id !== props.sheetId);
  const [targetId, setTargetId] = useState(destinations[0]?.id ?? '');
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const target = destinations.some(item => item.id === targetId) ? sheetAt(props.document, targetId) : null;
  const selected = descendantIds(props.sheet, props.selectedRows);
  const rows = props.sheet.records.filter(row => selected.has(String(row.id)));
  const fields = Object.keys(props.sheet.fields);
  const mappedField = (field: string) => mapping[field] ?? (target?.fields[field] ? field : '');
  const issues: string[] = [];
  const mappedTargets = fields.map(mappedField).filter(Boolean);
  if (new Set(mappedTargets).size !== mappedTargets.length) issues.push('多个来源字段不能映射到同一个目标字段');
  for (const row of rows) for (const field of fields) {
    const destination = mappedField(field);
    if (!destination) {
      if (row[field] != null && text(row[field]) !== '') issues.push(`${String(row.id)} / ${field} 有值，需要选择目标字段`);
      continue;
    }
    try { convertPanelValue(row[field], target!.fields[destination]); }
    catch (failure) { issues.push(`${String(row.id)} / ${field} → ${destination}：${(failure as Error).message}`); }
  }
  const merges = (props.sheet as ExtendedDoc).personalGrid?.merges ?? [];
  if (merges.some(merge => merge.rowIds.some(id => selected.has(id)) && !merge.rowIds.every(id => selected.has(id)))) issues.push('选区与合并区域部分重叠，请先取消合并');
  if (merges.some(merge => merge.rowIds.every(id => selected.has(id)) && merge.fields.some(field => !mappedField(field)))) issues.push('合并区域中的字段需要完整映射');
  if (merges.some(merge => merge.rowIds.every(id => selected.has(id)) && merge.fields.some(field => target?.fields[mappedField(field)]?.type !== props.sheet.fields[field]?.type))) issues.push('合并区域的目标字段类型必须与来源一致');
  const move = () => {
    setError('');
    if (!target || !rows.length || issues.length) return;
    try {
      props.transactDocument('跨工作表移动记录', doc => {
        const source = sheetAt(doc, props.sheetId);
        const destination = sheetAt(doc, targetId);
        const sourceRows = source.records.filter(row => selected.has(String(row.id)));
        if (JSON.stringify(sourceRows) !== JSON.stringify(rows)) throw new Error('记录已变化，请重新预览');
        const occupied = new Set(destination.records.map(row => String(row.id)));
        const ids = new Map(sourceRows.map(row => { const oldId = String(row.id); return [oldId, occupied.has(oldId) ? genId() : oldId]; }));
        const moved = sourceRows.map(row => {
          const next: Record<string, unknown> = { id: ids.get(String(row.id)) };
          for (const field of fields) { const mapped = mappedField(field); if (mapped) next[mapped] = convertPanelValue(row[field], destination.fields[mapped]); }
          return next;
        });
        const originalGrid = grid(source);
        const destinationGrid = grid(destination);
        if (originalGrid.cellStyles) {
          const movedStyles: StyleMap = {};
          for (const [id, styles] of Object.entries(originalGrid.cellStyles)) {
            if (!ids.has(id)) continue;
            const cells = Object.fromEntries(Object.entries(styles).filter(([field]) => mappedField(field)).map(([field, style]) => [mappedField(field), copy(style)]));
            if (Object.keys(cells).length) movedStyles[ids.get(id)!] = cells;
          }
          if (Object.keys(movedStyles).length) destinationGrid.cellStyles = { ...destinationGrid.cellStyles, ...movedStyles };
          originalGrid.cellStyles = Object.fromEntries(Object.entries(originalGrid.cellStyles).filter(([id]) => !ids.has(id)));
          if (!Object.keys(originalGrid.cellStyles).length) delete originalGrid.cellStyles;
        }
        const parents = originalGrid.parents ?? {};
        destinationGrid.parents ??= {};
        for (const [child, parent] of Object.entries(parents)) if (ids.has(child) && ids.has(parent)) destinationGrid.parents[ids.get(child)!] = ids.get(parent)!;
        originalGrid.parents = Object.fromEntries(Object.entries(parents).filter(([child, parent]) => !ids.has(child) && !ids.has(parent)));
        destinationGrid.collapsed = [...(destinationGrid.collapsed ?? []), ...(originalGrid.collapsed ?? []).filter(id => ids.has(id)).map(id => ids.get(id)!)];
        originalGrid.collapsed = (originalGrid.collapsed ?? []).filter(id => !ids.has(id));
        const movedMerges = (originalGrid.merges ?? []).filter(merge => merge.rowIds.every(id => ids.has(id))).map(merge => ({
          ...copy(merge), id: genId(), rowIds: merge.rowIds.map(id => ids.get(id)!), fields: merge.fields.map(mappedField),
          original: Object.fromEntries(Object.entries(merge.original ?? {}).map(([id, values]) => [ids.get(id) ?? id, values && typeof values === 'object' && !Array.isArray(values) ? Object.fromEntries(Object.entries(values).map(([field, value]) => [mappedField(field) || field, value])) : values])),
        }));
        originalGrid.merges = (originalGrid.merges ?? []).filter(merge => !merge.rowIds.some(id => ids.has(id)));
        destinationGrid.merges = [...(destinationGrid.merges ?? []), ...movedMerges];
        destination.records.push(...moved);
        source.records = source.records.filter(row => !ids.has(String(row.id)));
      }, true);
    } catch (failure) { setError((failure as Error).message); }
  };
  return <>
    <p>移动 {rows.length} 条记录（包含选中父行的全部后代）。非空字段必须映射，类型冲突会阻止移动。</p>
    <label>目标工作表<select value={targetId} onChange={event => { setTargetId(event.target.value); setMapping({}); }}>{destinations.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    {!destinations.length && <p>请先新增一张工作表。</p>}
    {target && fields.map(field => <label key={field}>{field} →<select value={mappedField(field)} onChange={event => setMapping({ ...mapping, [field]: event.target.value })}><option value="">不映射（仅限空值）</option>{Object.entries(target.fields).map(([name, def]) => <option key={name} value={name}>{name} ({def.type})</option>)}</select></label>)}
    <ul className="feature-errors">{issues.slice(0, 50).map((issue, index) => <li key={index}>{issue}</li>)}</ul>
    {issues.length > 50 && <p>另有 {issues.length - 50} 个冲突。</p>}
    <ErrorMessage message={error} /><button disabled={!target || !rows.length || !!issues.length} onClick={move}>确认移动 {rows.length} 条记录</button>
  </>;
}

function HistoryPanel(props: FeaturePanelsProps) {
  const [selectedId, setSelectedId] = useState('');
  const snapshot = props.snapshots.find(item => item.id === selectedId);
  const snapshotDoc = snapshot?.doc;
  const archivedSheets = snapshotDoc ? [{ id: 'main', name: (snapshotDoc as ExtendedDoc).personal?.main.name ?? '工作表 1' }, ...((snapshotDoc as ExtendedDoc).personal?.sheets ?? []).map(item => ({ id: item.id, name: item.name }))] : [];
  const ids = [...new Set([...props.sheetNames.map(item => item.id), ...archivedSheets.map(item => item.id)])];
  return <>
    <button onClick={props.onCreateSnapshot}>创建手动快照</button>
    {!props.snapshots.length && <p>没有可用快照。</p>}
    <ul className="feature-snapshots">{props.snapshots.map(item => <li key={item.id}><button aria-pressed={selectedId === item.id} onClick={() => { setSelectedId(item.id); if (!item.doc) props.onReadSnapshot?.(item.id); }}>{item.label}<br /><time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time></button></li>)}</ul>
    {snapshot && <section aria-label="快照差异预览"><h3>恢复差异</h3>
      {!snapshotDoc && <><p>快照内容尚未加载，或快照文件不可用。</p>{props.onReadSnapshot && <button onClick={() => props.onReadSnapshot?.(snapshot.id)}>重新加载快照</button>}</>}
      {snapshotDoc && <>
        {ids.map(id => {
          const current = props.sheetNames.find(item => item.id === id);
          const archived = archivedSheets.find(item => item.id === id);
          const empty: BaseDoc = { fields: {}, views: [], records: [] };
          return <fieldset key={id}><legend>{current?.name ?? archived?.name}</legend>
            {!current && <p>将恢复此工作表</p>}{!archived && <p>将删除此工作表</p>}
            <HistorySheetDifference current={current ? sheetAt(props.document, id) : empty} snapshot={archived ? sheetAt(snapshotDoc, id) : empty} />
          </fieldset>;
        })}
        <p>恢复将替换整个文件，并先为当前状态创建快照。</p><button onClick={() => props.onRestoreSnapshot(snapshot.id)}>恢复此快照</button>
      </>}
    </section>}
  </>;
}
