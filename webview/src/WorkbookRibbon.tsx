import { useEffect, useRef, useState, type ReactNode } from "react";
import type { BaseDoc } from "../../src/core/types";
import { cellStyle } from "../../src/core/cell-style";
import { columnLabel } from "../../src/core/formulas";
import { readGridMeta } from "../../src/core/features";
import type { ToolbarControls } from "./App";

type Category = "开始" | "插入" | "数据" | "公式" | "视图" | "工具";
type Panel = "search" | "format" | "details" | "templates" | "history" | "move" | "data";
interface Action { label: string; run: () => void; disabled?: boolean; pressed?: boolean; title?: string; content?: ReactNode }
interface Group { name: string; actions: Action[] }

export function WorkbookRibbon({ controls, sheet, selectedRows, selectedCols, onCommand, onPanel, onCreateSheet, onFormulaCommit, busy }: {
  controls: ToolbarControls;
  sheet: BaseDoc;
  selectedRows: string[];
  selectedCols: string[];
  onCommand: (kind: string, value?: string | number) => void;
  onPanel: (panel: Panel) => void;
  onCreateSheet: () => void;
  onFormulaCommit: (row: string, field: string, value: string) => void;
  busy: boolean;
}) {
  const [category, setCategory] = useState<Category>("开始");
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState(false);
  const [template, setTemplate] = useState<{ id: number; value: string } | null>(null);
  const selected = !!selectedRows.length && !!selectedCols.length;
  const firstRow = selectedRows[0];
  const firstField = selectedCols[0];
  const style = cellStyle(sheet, firstRow, firstField);
  const command = (kind: string, value?: string | number) => () => onCommand(kind, value);
  const format = (kind: "bold" | "italic" | "underline" | "strikethrough", label: string, symbol: ReactNode): Action => ({ label, run: command(kind), disabled: !selected, pressed: selected && selectedRows.every(id => selectedCols.every(field => cellStyle(sheet, id, field)[kind])), content: symbol });
  const formulaTemplate = (name: string) => {
    const row = sheet.records.findIndex(record => record.id === firstRow);
    const letter = columnLabel(Object.keys(sheet.fields).indexOf(firstField));
    const range = `${letter}1:${letter}${Math.max(1, row)}`;
    setTemplate({ id: Date.now(), value: name === "COUNTIF" ? (row > 0 ? `=COUNTIF(${range},">0")` : '=COUNTIF(0,">0")') : row > 0 ? `=${name}(${range})` : `=${name}()` });
  };
  const groups: Record<Category, Group[]> = {
    开始: [
      { name: "剪贴板", actions: [{ label: "复制", run: command("copy"), disabled: !selected }, { label: "粘贴", run: command("paste") }, { label: "只粘贴内容", run: command("pasteValues") }, { label: "只粘贴格式", run: command("pasteFormats") }] },
      { name: "字体", actions: [format("bold", "增粗", <b>B</b>), format("italic", "斜体", <i>I</i>), format("underline", "下划线", <u>U</u>), format("strikethrough", "删除线", <s>S</s>),
        { label: "字体颜色", run() {}, content: <label className="ribbon-color">字体色<input aria-label="字体颜色" type="color" value={style.color?.length === 7 ? style.color : "#222222"} disabled={!selected} onInput={event => onCommand("fontColor", event.currentTarget.value)} onChange={event => onCommand("fontColor", event.target.value)} /></label> },
        { label: "填充色", run() {}, content: <label className="ribbon-color">填充色<input aria-label="填充色" type="color" value={style.background?.length === 7 ? style.background : "#ffffff"} disabled={!selected} onInput={event => onCommand("fillColor", event.currentTarget.value)} onChange={event => onCommand("fillColor", event.target.value)} /></label> }] },
      { name: "对齐与编辑", actions: [{ label: "左对齐", run: command("left"), disabled: !selected }, { label: "居中", run: command("center"), disabled: !selected }, { label: "右对齐", run: command("right"), disabled: !selected }, { label: "自动换行", run: controls.toggleWrap }, { label: "合并单元格", run: command("merge"), disabled: !selected }, { label: "查找替换", run: () => onPanel("search") }] },
      { name: "撤销与格式", actions: [{ label: "撤销", run: controls.undo, disabled: !controls.canUndo }, { label: "重做", run: controls.redo, disabled: !controls.canRedo }, { label: "清除格式", run: command("clearFormat"), disabled: !selected }, { label: "清空内容", run: command("clearContents"), disabled: !selected }] },
    ],
    插入: [{ name: "表格", actions: [{ label: "新建工作表", run: onCreateSheet }, { label: "新增行", run: controls.addRow }, { label: "插入行", run: command("insertRow") }, { label: "新增列", run: controls.addField }] }, { name: "层级与模板", actions: [{ label: "父子节点", run: command("parent"), disabled: !selected }, { label: "创建列组", run: command("groupColumns"), disabled: selectedCols.length < 2 }, { label: "模板", run: () => onPanel("templates") }] }],
    数据: [{ name: "整理数据", actions: [{ label: "筛选", run: controls.filter }, { label: "排序", run: controls.sort }, { label: "分组", run: controls.group }, { label: "字段设置", run: controls.fields }] }, { name: "数据工具", actions: [{ label: "重复项高亮与去重", run: () => onPanel("data") }, { label: "条件格式", run: () => onPanel("format") }, { label: "跨表移动", run: () => onPanel("move"), disabled: !selectedRows.length }] }],
    公式: [{ name: "插入函数", actions: [{ label: "Σ 求和", title: "在编辑栏插入 SUM 函数，确认后保存", run: () => formulaTemplate("SUM"), disabled: !selected }, { label: "平均值", run: () => formulaTemplate("AVERAGE"), disabled: !selected }, { label: "条件计数", run: () => formulaTemplate("COUNTIF"), disabled: !selected }] }, { name: "层级统计", actions: [{ label: "父节点汇总", run: command("summary") }] }],
    视图: [{ name: "冻结", actions: [{ label: "冻结指定行", run: command("freezeRows") }, { label: "取消冻结行", run: command("unfreezeRows") }, { label: "冻结到选中列", run: () => controls.freezeColumn(firstField), disabled: !selected }, { label: "取消冻结列", run: () => controls.freezeColumn(undefined) }] }, { name: "尺寸", actions: [{ label: "自动列宽", run: command("autoColumnWidth") }, { label: "自动行高", run: command("autoRowHeight") }, { label: "紧凑行高", run: () => controls.setRowHeight("compact") }, { label: "标准行高", run: () => controls.setRowHeight("medium") }, { label: "宽松行高", run: () => controls.setRowHeight("tall") }] }],
    工具: [{ name: "工作簿", actions: [{ label: "行详情", run: () => onPanel("details"), disabled: !selectedRows.length }, { label: "模板管理", run: () => onPanel("templates") }, { label: "历史快照", run: () => onPanel("history") }, { label: "导出", run: controls.export }] }],
  };
  const matching = query.trim() ? Object.entries(groups).flatMap(([name, entries]) => entries.flatMap(group => group.actions.filter(action => `${name}${group.name}${action.label}`.includes(query.trim())).map(action => ({ group: `${name} · ${group.name}`, action })))) : null;
  const button = (action: Action) => action.label === "字体颜色" || action.label === "填充色" ? <span key={action.label}>{action.content}</span> : <button type="button" key={action.label} title={action.title ?? action.label} aria-label={action.label} aria-pressed={action.pressed} disabled={action.disabled} onMouseDown={event => { if (["筛选", "排序", "分组", "字段设置"].includes(action.label)) event.stopPropagation(); }} onClick={action.run}>{action.content ?? action.label}</button>;

  return <div className={`workbook-ribbon${collapsed ? " ribbon-collapsed" : ""}`}>
    <div className="ribbon-tabs" role="tablist" aria-label="功能分类"><strong>我的多维表格</strong>{(Object.keys(groups) as Category[]).map(name => <button role="tab" key={name} aria-selected={category === name && !query} onClick={() => { setCategory(name); setQuery(""); setCollapsed(false); }}>{name}</button>)}<input type="search" aria-label="搜索功能" placeholder="搜索功能" value={query} onChange={event => { setQuery(event.target.value); setCollapsed(false); }} /><button type="button" className="ribbon-collapse-toggle" aria-label={collapsed ? "展开功能区" : "收起功能区"} aria-expanded={!collapsed} onClick={() => setCollapsed(value => !value)}>{collapsed ? "展开 ▾" : "收起 ▴"}</button><span className="ribbon-status" role="status">{busy ? "正在保存…" : "已就绪"}</span></div>
    <div className="ribbon-groups">{matching ? <div className="ribbon-search-results">{matching.length ? matching.map(({ action, group }) => <span key={`${group}-${action.label}`} title={group}>{button(action)}</span>) : <span>没有匹配功能</span>}</div> : groups[category].map(group => <section className="ribbon-group" key={group.name} aria-label={group.name}><div>{group.actions.map(button)}</div><small>{group.name}</small></section>)}</div>
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
  const cancelled = useRef(false);
  const saved = useRef("");
  useEffect(() => { setDraft(value); saved.current = ""; }, [row, field, value]);
  useEffect(() => { if (template) { setDraft(template.value); saved.current = ""; requestAnimationFrame(() => input.current?.focus()); } }, [template]);
  const commit = () => { const key = `${row}|${field}|${draft}`; if (record && draft !== value && saved.current !== key) { saved.current = key; onCommit(row, field, draft); } };
  const address = record ? `${columnLabel(Object.keys(sheet.fields).indexOf(field))}${sheet.records.indexOf(record) + 1}` : "选择单元格";
  return <form className="ribbon-formula-bar" onSubmit={event => { event.preventDefault(); commit(); input.current?.blur(); }}><output aria-label="当前单元格">{address}</output><span aria-hidden="true">fx</span><input ref={input} aria-label="单元格内容与公式" placeholder="输入内容或公式，例如 =SUM(C1:C5)" value={draft} disabled={!record} onFocus={() => { cancelled.current = false; }} onChange={event => { saved.current = ""; setDraft(event.target.value); }} onBlur={() => { if (!cancelled.current) commit(); cancelled.current = false; }} onKeyDown={event => { if (event.nativeEvent.isComposing || event.keyCode === 229) return; if (event.key === "Escape") { event.preventDefault(); cancelled.current = true; setDraft(value); input.current?.blur(); } }} /><div className="tablet-formula-actions"><button type="button" disabled={!record} onClick={() => { commit(); input.current?.blur(); }}>确认</button><button type="button" disabled={!record} onPointerDown={event => { event.preventDefault(); }} onClick={() => { cancelled.current = true; setDraft(value); input.current?.blur(); }}>取消</button></div></form>;
}
