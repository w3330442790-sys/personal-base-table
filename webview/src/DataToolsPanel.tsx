import React, { useState } from 'react';
import type { BaseDoc } from '../../src/core/types';
import { findDuplicateRows, removeDuplicates } from '../../src/core/spreadsheet-data';

export interface DataToolsPanelProps {
    sheet: BaseDoc;
    selectedRows: string[];
    selectedCols: string[];
    transact: (label: string, change: (sheet: BaseDoc) => void, destructive?: boolean) => void;
}

export function DataToolsPanel({ sheet, selectedRows, selectedCols, transact }: DataToolsPanelProps) {
    const [fields, setFields] = useState<string[]>(selectedCols.length ? selectedCols : Object.keys(sheet.fields));
    const [scope, setScope] = useState<'sheet' | 'selection'>('sheet');
    const [confirmation, setConfirmation] = useState('');
    const [error, setError] = useState('');
    const chosen = fields.filter(field => !!sheet.fields[field]);
    const ids = scope === 'selection' ? selectedRows.filter(id => sheet.records.some(row => String(row.id) === id)) : undefined;
    const preview = chosen.length ? findDuplicateRows(sheet, chosen, ids) : { groups: [], duplicateIds: [] };
    const fingerprint = JSON.stringify({ sheet, fields: chosen, ids });
    const highlighted = ((sheet.personalGrid as { duplicateFields?: string[] } | undefined)?.duplicateFields ?? []);
    const showValue = (value: unknown) => value == null || value === '' ? '（空）' : typeof value === 'object' ? JSON.stringify(value) : String(value);
    const toggleHighlight = () => {
        setError('');
        try {
            transact('重复值高亮', current => {
                const meta = (current.personalGrid ??= {}) as { duplicateFields?: string[] };
                if (highlighted.length) delete meta.duplicateFields;
                else meta.duplicateFields = [...chosen];
            });
        } catch (failure) { setError((failure as Error).message); }
    };
    const remove = () => {
        setError('');
        try {
            transact('删除重复记录', current => {
                if (JSON.stringify({ sheet: current, fields: chosen, ids }) !== confirmation) throw new Error('记录或选区已变化，请重新确认预览');
                removeDuplicates(current, chosen, ids);
            }, true);
            setConfirmation('');
        } catch (failure) { setError((failure as Error).message); setConfirmation(''); }
    };
    return <>
        <p>按所选字段的值比较重复记录。空字符串、空值和未填写视为相同；每组保留工作表顺序中的第一条。</p>
        <fieldset><legend>比较字段</legend>
            {Object.keys(sheet.fields).map(field => <label key={field}><input type="checkbox" checked={chosen.includes(field)} onChange={event => { setFields(event.target.checked ? [...chosen, field] : chosen.filter(item => item !== field)); setConfirmation(''); }} />{field}</label>)}
        </fieldset>
        <label>去重范围<select value={scope} onChange={event => { setScope(event.target.value as 'sheet' | 'selection'); setConfirmation(''); }}><option value="sheet">当前工作表</option><option value="selection">选中记录（{selectedRows.length} 条）</option></select></label>
        {!chosen.length && <p role="alert">请至少选择一个比较字段。</p>}
        <p>{ids?.length ?? sheet.records.length} 条记录中有 {preview.groups.length} 组重复，将删除 {preview.duplicateIds.length} 条、保留 {(ids?.length ?? sheet.records.length) - preview.duplicateIds.length} 条。</p>
        <button disabled={!chosen.length && !highlighted.length} aria-pressed={!!highlighted.length} onClick={toggleHighlight}>{highlighted.length ? '关闭重复值高亮' : '在整张表高亮重复值'}</button>
        {!!preview.groups.length && <section aria-label="重复记录预览"><h3>删除预览</h3>
            <ul>{preview.groups.slice(0, 10).map(group => <li key={group[0]}>
                <strong>保留 {group[0]}</strong> · {chosen.map(field => `${field}：${showValue(sheet.records.find(row => String(row.id) === group[0])?.[field])}`).join('；')}
                <p>删除：{group.slice(1).join('、')}</p>
            </li>)}</ul>
            {preview.groups.length > 10 && <p>另有 {preview.groups.length - 10} 组；确认将处理全部 {preview.groups.length} 组。</p>}
        </section>}
        <p>删除重复父行时，其未重复的子孙记录会保留并提升层级。此操作可撤销。</p>
        {confirmation === fingerprint && preview.duplicateIds.length > 0 ? <div className="feature-actions"><button onClick={remove}>确认删除 {preview.duplicateIds.length} 条重复记录</button><button onClick={() => setConfirmation('')}>取消</button></div> : <button disabled={!preview.duplicateIds.length} onClick={() => setConfirmation(fingerprint)}>检查后删除重复记录…</button>}
        {error && <p className="feature-error" role="alert">{error}</p>}
    </>;
}
export default DataToolsPanel;
