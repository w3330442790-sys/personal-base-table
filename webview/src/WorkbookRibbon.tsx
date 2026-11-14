import { useEffect, useRef, useState, type ReactNode } from "react";
import type { BaseDoc } from "../../src/core/types";
import { cellStyle } from "../../src/core/cell-style";
import { columnLabel } from "../../src/core/formulas";
import { readGridMeta } from "../../src/core/features";
import type { ToolbarControls } from "./App";
import { Icon } from "./icons";
import { FloatingPanel } from "./FloatingPanel";
import { belowAnchor, type FloatingAnchor } from "./floating";

type Category = "开始" | "插入" | "数据" | "公式" | "视图" | "工具";
type Panel = "search" | "format" | "details" | "templates" | "history" | "move" | "data" | "import";
export interface Action {
  label: string;
  run: () => void;
  disabled?: boolean;
  pressed?: boolean;
  title?: string;
  icon?: ReactNode;
  color?: string;
}
interface Group { name: string; actions: Action[] }

const CATEGORIES: Category[] = ["开始", "插入", "数据", "公式", "视图", "工具"];
const COLLAPSE_KEY = "personal-base-table.ribbon-collapsed";

export function WorkbookRibbon({ controls, sheet, selectedRows, selectedCols, sequence, onSequence, onCommand, onPanel, onCreateSheet, onFormulaCommit }: {
  controls: ToolbarControls;
  sheet: BaseDoc;
  selectedRows: string[];
  selectedCols: string[];
  sequence: boolean;
  onSequence: (value: boolean) => void;
  onCommand: (kind: string, value?: string | number) => void;
  onPanel: (panel: Panel) => void;
  onCreateSheet: () => void;
  onFormulaCommit: (row: string, field: string, value: string) => void;
}) {
  const [category, setCategory] = useState<Category>("开始");
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(COLLAPSE_KEY) === "1"; } catch { return false; }
  });
  const [template, setTemplate] = useState<{ id: number; value: string } | null>(null);
  const [more, setMore] = useState<FloatingAnchor | null>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const selected = !!selectedRows.length && !!selectedCols.length;
  const firstRow = selectedRows[0];
  const firstField = selectedCols[0];
  const style = cellStyle(sheet, firstRow, firstField);
  const command = (kind: string, value?: string | number) => () => onCommand(kind, value);
  const applyCollapsed = (value: boolean) => {
    setCollapsed(value);
    try { localStorage.setItem(COLLAPSE_KEY, value ? "1" : "0"); } catch { /* 忽略无 localStorage 的宿主 */ }
  };
  const toggleCollapsed = () => {
    setMore(null);
    applyCollapsed(!collapsed);
  };
  const format = (kind: "bold" | "italic" | "underline" | "strikethrough", label: string, glyph: ReactNode): Action => ({
    label, title: label, run: command(kind), disabled: !selected,
    pressed: selected && selectedRows.every(id => selectedCols.every(field => cellStyle(sheet, id, field)[kind])),
    icon: <span className={`ribbon-glyph glyph-${kind}`}>{glyph}</span>,
  });
  const formulaTemplate = (name: string) => {
    const row = sheet.records.findIndex(record => record.id === firstRow);
    const letter = columnLabel(Object.keys(sheet.fields).indexOf(firstField));
    const range = `${letter}1:${letter}${Math.max(1, row)}`;
    setTemplate({ id: Date.now(), value: name === "COUNTIF" ? (row > 0 ? `=COUNTIF(${range},">0")` : '=COUNTIF(0,">0")') : row > 0 ? `=${name}(${range})` : `=${name}()` });
  };
  const groups: Record<Category, Group[]> = {
    开始: [
      { name: "剪贴板", actions: [
        { label: "复制", run: command("copy"), disabled: !selected, icon: <Icon name="copy" size={16} /> },
        { label: "粘贴", run: command("paste"), icon: <Icon name="paste" size={16} /> },
        { label: "只贴内容", title: "只粘贴内容", run: command("pasteValues"), icon: <Icon name="paste" size={16} /> },
        { label: "只贴格式", title: "只粘贴格式", run: command("pasteFormats"), icon: <Icon name="paste" size={16} /> },
      ] },
      { name: "字体", actions: [
        format("bold", "增粗", <b>B</b>), format("italic", "斜体", <i>I</i>), format("underline", "下划线", <u>U</u>), format("strikethrough", "删除线", <s>S</s>),
        { label: "字色", title: "字体颜色", run() {}, icon: <Icon name="palette" size={16} />, disabled: !selected, color: style.color },
        { label: "填充色", title: "单元格填充色", run() {}, icon: <Icon name="fill" size={16} />, disabled: !selected, color: style.background },
      ] },
      { name: "对齐", actions: [
        { label: "左对齐", run: command("left"), disabled: !selected, icon: <Icon name="alignLeft" size={16} /> },
        { label: "居中", run: command("center"), disabled: !selected, icon: <Icon name="alignCenter" size={16} /> },
        { label: "右对齐", run: command("right"), disabled: !selected, icon: <Icon name="alignRight" size={16} /> },
        { label: "自动换行", run: controls.toggleWrap, icon: <Icon name="wrap" size={16} /> },
        { label: "合并", title: "合并单元格", run: command("merge"), disabled: !selected, icon: <Icon name="merge" size={16} /> },
      ] },
      { name: "单元格", actions: [
        { label: "撤销", run: controls.undo, disabled: !controls.canUndo, icon: <Icon name="undo" size={16} /> },
        { label: "重做", run: controls.redo, disabled: !controls.canRedo, icon: <Icon name="redo" size={16} /> },
        { label: "清除格式", run: command("clearFormat"), disabled: !selected, icon: <Icon name="eraser" size={16} /> },
        { label: "清空内容", run: command("clearContents"), disabled: !selected, icon: <Icon name="clear" size={16} /> },
        { label: "查找", title: "查找替换", run: () => onPanel("search"), icon: <Icon name="search" size={16} /> },
      ] },
    ],
    插入: [{ name: "表格", actions: [
      { label: "新建工作表", run: onCreateSheet, icon: <Icon name="table" size={16} /> },
      { label: "新增行", run: controls.addRow, icon: <Icon name="add" size={16} /> },
      { label: "插入行", run: command("insertRow"), icon: <Icon name="insertLeft" size={16} /> },
      { label: "新增列", run: controls.addField, icon: <Icon name="columns" size={16} /> },
    ] }, { name: "层级与模板", actions: [
      { label: "父子节点", title: "设置父子节点", run: command("parent"), disabled: !selected, icon: <Icon name="tree" size={16} /> },
      { label: "列组", title: "创建列组", run: command("groupColumns"), disabled: selectedCols.length < 2, icon: <Icon name="group" size={16} /> },
      { label: "模板", title: "模板管理", run: () => onPanel("templates"), icon: <Icon name="template" size={16} /> },
    ] }],
    数据: [{ name: "整理数据", actions: [
      { label: "筛选", run: controls.filter, icon: <Icon name="filter" size={16} /> },
      { label: "排序", run: controls.sort, icon: <Icon name="sort" size={16} /> },
      { label: "分组", run: controls.group, icon: <Icon name="group" size={16} /> },
      { label: "字段设置", run: controls.fields, icon: <Icon name="fields" size={16} /> },
    ] }, { name: "数据工具", actions: [
      { label: "去重", title: "重复项高亮与去重", run: () => onPanel("data"), icon: <Icon name="copy" size={16} /> },
      { label: "导入", title: "从 CSV / TSV 新建工作表", run: () => onPanel("import"), icon: <Icon name="insertLeft" size={16} /> },
      { label: "条件格式", run: () => onPanel("format"), icon: <Icon name="palette" size={16} /> },
      { label: "跨表移动", run: () => onPanel("move"), disabled: !selectedRows.length, icon: <Icon name="insertRight" size={16} /> },
    ] }, { name: "填充", actions: [
      { label: "序列填充", run: () => onSequence(!sequence), pressed: sequence, icon: <Icon name="sequence" size={16} /> },
    ] }],
    公式: [{ name: "插入函数", actions: [
      { label: "求和", title: "在编辑栏插入 SUM 函数，确认后保存", run: () => formulaTemplate("SUM"), disabled: !selected, icon: <span className="ribbon-glyph">Σ</span> },
      { label: "平均值", run: () => formulaTemplate("AVERAGE"), disabled: !selected, icon: <span className="ribbon-glyph">x̄</span> },
      { label: "条件计数", run: () => formulaTemplate("COUNTIF"), disabled: !selected, icon: <span className="ribbon-glyph">ƒ</span> },
    ] }, { name: "层级统计", actions: [
      { label: "父节点汇总", run: command("summary"), icon: <Icon name="tree" size={16} /> },
    ] }],
    视图: [{ name: "冻结", actions: [
      { label: "冻结行", title: "冻结指定行", run: command("freezeRows"), icon: <Icon name="snow" size={16} /> },
      { label: "取消冻结行", run: command("unfreezeRows"), icon: <Icon name="snow" size={16} /> },
      { label: "冻结列", title: "冻结到选中列", run: () => controls.freezeColumn(firstField), disabled: !selected, icon: <Icon name="snow" size={16} /> },
      { label: "取消冻结列", run: () => controls.freezeColumn(undefined), icon: <Icon name="snow" size={16} /> },
    ] }, { name: "尺寸", actions: [
      { label: "自动列宽", run: command("autoColumnWidth"), icon: <Icon name="width" size={16} /> },
      { label: "自动行高", run: command("autoRowHeight"), icon: <Icon name="rowHeight" size={16} /> },
      { label: "紧凑行高", run: () => controls.setRowHeight("compact"), icon: <Icon name="rowHeight" size={16} /> },
      { label: "标准行高", run: () => controls.setRowHeight("medium"), icon: <Icon name="rowHeight" size={16} /> },
      { label: "宽松行高", run: () => controls.setRowHeight("tall"), icon: <Icon name="rowHeight" size={16} /> },
    ] }],
    工具: [{ name: "工作簿", actions: [
      { label: "行详情", run: () => onPanel("details"), disabled: !selectedRows.length, icon: <Icon name="edit" size={16} /> },
      { label: "模板管理", run: () => onPanel("templates"), icon: <Icon name="template" size={16} /> },
      { label: "历史快照", run: () => onPanel("history"), icon: <Icon name="history" size={16} /> },
      { label: "导出", run: controls.export, icon: <Icon name="download" size={16} /> },
    ] }],
  };
  const matching = query.trim() ? Object.entries(groups).flatMap(([name, entries]) => entries.flatMap(group => group.actions.filter(action => `${name}${group.name}${action.label}${action.title ?? ""}`.includes(query.trim())).map(action => ({ group: `${name} · ${group.name}`, action })))) : null;

  const button = (action: Action) => {
    const color = action.color?.length === 7 ? action.color : undefined;
    if (action.label === "字色" || action.label === "填充色") {
      return <label key={action.label} className={`ribbon-command ribbon-color${action.disabled ? " is-disabled" : ""}`} title={action.title ?? action.label}>
        <span className="ribbon-command-icon">{action.icon}<i className="ribbon-color-bar" style={{ background: color }} /></span>
        <span className="ribbon-command-label">{action.label}</span>
        <input aria-label={action.title ?? action.label} type="color" value={color ?? (action.label === "字色" ? "#222222" : "#ffffff")} disabled={action.disabled}
          onInput={event => onCommand(action.label === "字色" ? "fontColor" : "fillColor", event.currentTarget.value)}
          onChange={event => onCommand(action.label === "字色" ? "fontColor" : "fillColor", event.target.value)} />
      </label>;
    }
    return <button type="button" key={action.label} className="ribbon-command" title={action.title ?? action.label} aria-label={action.label} aria-pressed={action.pressed} disabled={action.disabled}
      onMouseDown={event => { if (["筛选", "排序", "分组", "字段设置"].includes(action.label)) event.stopPropagation(); }}
      onClick={action.run}>{action.icon && <span className="ribbon-command-icon">{action.icon}</span>}<span className="ribbon-command-label">{action.label}</span></button>;
  };

  const wide = controls.views.length > 1;
  return <div className={`workbook-ribbon${collapsed ? " ribbon-collapsed" : ""}`}>
    <div className="ribbon-bar">
      <div className="ribbon-tabs" role="tablist" aria-label="功能分类">
        {CATEGORIES.map(name => <button role="tab" type="button" key={name} aria-selected={category === name && !query} onClick={() => { setCategory(name); setQuery(""); setMore(null); if (collapsed) applyCollapsed(false); }}>{name}</button>)}
      </div>
      <div className="ribbon-bar-tools">
        {wide && <label className="ribbon-view" title="切换已保存的筛选方案">
          <Icon name="filter" size={13} />
          <select aria-label="已有筛选方案" value={controls.viewIndex} onChange={event => controls.selectView(Number(event.target.value))}>{controls.views.map((view, index) => <option key={index} value={index}>{view.name}</option>)}</select>
        </label>}
        <div className={`ribbon-search${searching ? " is-open" : ""}`}>
          <button type="button" className="ribbon-icon-button" title="搜索功能" aria-label="搜索功能" aria-expanded={searching} onClick={() => { setSearching(value => !value); setQuery(""); requestAnimationFrame(() => searchInput.current?.focus()); }}><Icon name="search" size={15} /></button>
          {searching && <input ref={searchInput} type="search" aria-label="搜索功能" placeholder="搜索功能，例如：冻结" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === "Escape") { setSearching(false); setQuery(""); } }} />}
        </div>
        <button type="button" className="ribbon-icon-button" aria-label={collapsed ? "展开功能区" : "收起功能区"} title={collapsed ? "展开功能区" : "收起功能区"} aria-expanded={!collapsed} onClick={toggleCollapsed}><Icon name={collapsed ? "expand" : "collapse"} size={15} /></button>
      </div>
    </div>
    {!collapsed && <div className="ribbon-groups-wrap">
      <div className="ribbon-groups">
        {matching ? <div className="ribbon-search-results">{matching.length ? matching.map(({ action, group }) => <span key={`${group}-${action.label}`} title={group}>{button(action)}</span>) : <span className="ribbon-empty">没有匹配功能</span>}</div> : groups[category].map(group => <section className="ribbon-group" key={group.name} aria-label={group.name}><div className="ribbon-group-body">{group.actions.map(button)}</div></section>)}
      </div>
      {!matching && <button ref={moreButton} type="button" className="ribbon-more-button" title="更多命令" aria-label="更多命令" aria-expanded={!!more} onClick={() => setMore(more ? null : moreButton.current ? belowAnchor(moreButton.current) : null)}><Icon name="more" size={16} /></button>}
    </div>}
    {more && <FloatingPanel anchor={more} role="menu" className="ribbon-more-panel" onDismiss={() => setMore(null)}>
      {groups[category].map(group => <section key={group.name}>
        <small>{group.name}</small>
        {group.actions.filter(action => action.label !== "字色" && action.label !== "填充色").map(action => <button key={action.label} type="button" disabled={action.disabled} onClick={() => { setMore(null); action.run(); }}>{action.icon}<span>{action.title ?? action.label}</span></button>)}
      </section>)}
    </FloatingPanel>}
    <FormulaBar sheet={sheet} row={firstRow} field={firstField} template={template} onCommit={onFormulaCommit} />
  </div>;
}

function FormulaBar({ sheet, row, field, template, onCommit }: { sheet: BaseDoc; row: string; field: string; template: { id: number; value: string } | null; onCommit: (row: string, field: string, value: string) => void }) {
  const record = sheet.records.find(record => record.id === row);
  const merge = readGridMeta(sheet).merges?.find(region => region.rowIds.includes(row) && region.fields.includes(field));
  const raw = merge ? merge.display : record?.[field];
  const value = raw == null ? "" : String(raw);
  const [draft, setDraft] = useState(value);
  const input = useRef<HTMLInputElement>(null);
  const cancel = useRef(false);
  const saved = useRef("");
  useEffect(() => { setDraft(value); saved.current = ""; }, [row, field, value]);
  useEffect(() => { if (template) { setDraft(template.value); saved.current = ""; requestAnimationFrame(() => input.current?.focus()); } }, [template]);
  const commit = () => { const key = `${row}|${field}|${draft}`; if (record && draft !== value && saved.current !== key) { saved.current = key; onCommit(row, field, draft); } };
  const address = record ? `${columnLabel(Object.keys(sheet.fields).indexOf(field))}${sheet.records.indexOf(record) + 1}` : "";
  return <form className="ribbon-formula-bar" onSubmit={event => { event.preventDefault(); commit(); input.current?.blur(); }}>
    <output className="ribbon-name-box" aria-label="当前单元格" title="当前单元格地址">{address}</output>
    <span className="ribbon-fx" aria-hidden="true">fx</span>
    <input ref={input} aria-label="单元格内容与公式" placeholder="输入内容或公式，例如 =SUM(C1:C5)" value={draft} disabled={!record}
      onFocus={() => { cancel.current = false; }}
      onChange={event => { saved.current = ""; setDraft(event.target.value); }}
      onBlur={() => { if (!cancel.current) commit(); cancel.current = false; }}
      onKeyDown={event => { if (event.nativeEvent.isComposing || event.keyCode === 229) return; if (event.key === "Escape") { event.preventDefault(); cancel.current = true; setDraft(value); input.current?.blur(); } }} />
    <div className="tablet-formula-actions">
      <button type="button" aria-label="确认编辑" disabled={!record} onClick={() => { commit(); input.current?.blur(); }}>✓</button>
      <button type="button" aria-label="取消编辑" disabled={!record} onPointerDown={event => { event.preventDefault(); }} onClick={() => { cancel.current = true; setDraft(value); input.current?.blur(); }}>✕</button>
    </div>
  </form>;
}
