import test from 'node:test';
import assert from 'node:assert/strict';
const { convertPanelValue, replacePanelText, instantiatePanelTemplate, diffPanelSheets } = require('../webview/src/FeaturePanels');

test('replacement is literal, handles case and full cell matches', () => {
  assert.equal(replacePanelText('A.a a', 'a', '$&', false, false), '$&.$& $&');
  assert.equal(replacePanelText('ABC', 'abc', 'x', false, true), 'x');
  assert.equal(replacePanelText('ABC a', 'abc', 'x', false, true), 'ABC a');
});
test('typed conversions reject invalid options and numbers', () => {
  assert.throws(() => convertPanelValue('Infinity', {type:'number'}));
  assert.throws(() => convertPanelValue('later', {type:'select', options:['now']}));
  assert.deepEqual(convertPanelValue(['a','b'], {type:'multi', options:['a','b']}), ['a','b']);
  assert.equal(convertPanelValue('false', {type:'checkbox'}), false);
  assert.throws(() => convertPanelValue('2025-02-31', {type:'date'}));
});
test('template instances regenerate records, hierarchy and merge references', () => {
  const source:any = {fields:{Title:{type:'text'}},views:[],records:[{id:'a',Title:'A'},{id:'b',Title:'B'}],personalGrid:{parents:{b:'a'},collapsed:['a'],merges:[{id:'m',rowIds:['a'],fields:['Title'],original:{a:{Title:'A'}}}]}};
  const result:any = instantiatePanelTemplate(source);
  assert.notEqual(result.records[0].id, 'a');
  assert.equal(result.personalGrid.parents[result.records[1].id], result.records[0].id);
  assert.equal(result.personalGrid.merges[0].rowIds[0], result.records[0].id);
  assert.ok(result.personalGrid.merges[0].original[result.records[0].id]);
  assert.equal(source.records[0].id,'a');
});
test('diff identifies modified records with stable ids', () => {
 const a:any={fields:{a:{type:'text'}},views:[],records:[{id:'r',a:'old'}]};
 const b:any={...a,records:[{id:'r',a:'new'},{id:'s',a:'added'}]};
 const diff=diffPanelSheets(a,b);
 assert.equal(diff.recordsChanged,1); assert.equal(diff.recordsAdded,1);
});


test('every panel renders its normal entry point and details rejects executable attachment URLs', () => {
  const { createElement } = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const { FeaturePanels } = require('../webview/src/FeaturePanels');
  const sheet = {fields:{Title:{type:'text'},Count:{type:'number'},Done:{type:'checkbox'},Link:{type:'link'}},views:[],records:[{id:'r',Title:'Hello',Count:2,Done:false,Link:'javascript:alert(1)'}]};
  const props = {sheet,document:sheet,sheetId:'main',sheetNames:[{id:'main',name:'Main'}],selectedRows:['r'],selectedCols:['Title'],detailId:'r',snapshots:[],onClose(){},transact(){},transactDocument(){},onCreateSnapshot(){},onRestoreSnapshot(){},resolveResource(){return 'javascript:alert(1)';}};
  for (const panel of ['search','format','details','templates','history','move']) {
    const html = renderToStaticMarkup(createElement(FeaturePanels,{...props,panel}));
    assert.match(html, /feature-panel/);
    assert.doesNotMatch(html, /href="javascript:/);
    assert.doesNotMatch(html, /src="javascript:/);
  }
  const search = renderToStaticMarkup(createElement(FeaturePanels,{...props,panel:'search'}));
  assert.match(search, /search-tabs/);
  assert.match(search, /查找全部/);
  assert.match(search, /更多选项/);
  assert.match(search, /定位/);
});

test('history details identify concrete field and cell values in restore direction', () => {
  const { diffPanelDetails } = require('../webview/src/FeaturePanels');
  const current = {fields:{Keep:{type:'text'},Removed:{type:'number'}},views:[],records:[{id:'same',Keep:'current'},{id:'gone',Keep:'remove me'}]};
  const snapshot = {fields:{Keep:{type:'longtext'},Added:{type:'text'}},views:[],records:[{id:'same',Keep:'snapshot',Added:null},{id:'restored',Keep:'restore me'}]};
  const diff = diffPanelDetails(current,snapshot);
  assert.ok(diff.entries.some((entry:any) => entry.kind==='field' && entry.field==='Added' && entry.change==='added'));
  assert.ok(diff.entries.some((entry:any) => entry.kind==='field' && entry.field==='Removed' && entry.change==='removed'));
  assert.ok(diff.entries.some((entry:any) => entry.kind==='cell' && entry.rowId==='same' && entry.field==='Keep' && entry.before==='current' && entry.after==='snapshot'));
  assert.ok(diff.entries.some((entry:any) => entry.kind==='cell' && entry.rowId==='same' && entry.field==='Added' && entry.before===undefined && entry.after===null));
  assert.ok(diff.entries.some((entry:any) => entry.kind==='row' && entry.rowId==='gone' && entry.change==='removed'));
  assert.ok(diff.entries.some((entry:any) => entry.kind==='row' && entry.rowId==='restored' && entry.change==='added'));
});
test('history detail previews bound rendered differences while counting every difference', () => {
  const { diffPanelDetails } = require('../webview/src/FeaturePanels');
  const current = {fields:{Value:{type:'text'}},views:[],records:[]};
  const snapshot = {...current,records:Array.from({length:150},(_,index)=>({id:String(index),Value:'added'}))};
  const diff = diffPanelDetails(current,snapshot,100);
  assert.equal(diff.entries.length,100);
  assert.equal(diff.total,300);
});
test('panel conversions share grouped-number and date rules with paste', () => {
  const { typedValue } = require('../src/core/features');
  assert.equal(convertPanelValue('1,234.5',{type:'number'}),typedValue('1,234.5',{type:'number'}));
  assert.equal(convertPanelValue('2024-02-29',{type:'date'}),typedValue('2024-02-29',{type:'date'}));
  assert.throws(()=>convertPanelValue('2023-02-29',{type:'date'}));
});

test('history preview renders field names, before/after cell text and limit totals', () => {
  const { createElement } = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const { HistorySheetDifference } = require('../webview/src/FeaturePanels');
  const current = {fields:{Title:{type:'text'}},views:[],records:[{id:'record-1',Title:'Current value'}]};
  const snapshot = {...current,records:[{id:'record-1',Title:'Restored value'}]};
  const html = renderToStaticMarkup(createElement(HistorySheetDifference,{current,snapshot}));
  assert.match(html,/record-1 \/ Title/);
  assert.match(html,/Current value/);
  assert.match(html,/Restored value/);
  assert.match(html,/1 \/ 1/);
});
test('details preview Markdown and wiki image, PDF and audio attachments safely', () => {
  const { createElement } = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const { DetailField } = require('../webview/src/FeaturePanels');
  const html = renderToStaticMarkup(createElement(DetailField,{field:'Notes',def:{type:'longtext'},value:'![图片](images/test.png)\n[文档](files/test.pdf)\n![[music/test.mp3]]',onCommit(){},resolveResource(path:string){return `app://local/${path}`;}}));
  assert.match(html,/<img/);
  assert.match(html,/<iframe/);
  assert.match(html,/<audio/);
  assert.match(html,/sandbox=""/);
});
