import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {registerWordTools} from '../tools/word.mjs';
import {wordEdits,checkWordChanges} from '../tools/word-edit.mjs';
import {tableCommands,checkTableChange} from '../tools/word-table.mjs';

const parse=operation=>wordEdits({expected_sha256:'a'.repeat(64),operations:[operation]})[0];
test('Word table and inline input stays bounded',()=>{
  assert.equal(parse({action:'format_text',path:'/body/p[1]',props:{find:'片段',bold:true}}).props.bold,true);
  for(const props of [{find:'片段'},{find:'片段',align:'center'},{find:'',bold:true}])assert.throws(()=>parse({action:'format_text',path:'/body/p[1]',props}));
  for(const operation of [
    {action:'table_layout',path:'/body/tbl[1]',props:{colWidths:['0.1cm','15cm']}},
    {action:'table_layout',path:'/body/tbl[1]',props:{repeat_header:'yes'}},
    {action:'table_layout',path:'/body/tbl[1]',props:{}},
    {action:'insert_column',path:'/body/tbl[1]',props:{index:1,values:['x']}},
    {action:'remove_row',path:'/body/tbl[1]',props:{index:0,expected_values:['x']}},
  ])assert.throws(()=>parse(operation));
});

const paragraph=(path,text,format={})=>({type:'paragraph',path,text,childCount:1,format:{},children:[{type:'run',path:path+'/r[1]',text,childCount:0,format,children:[]}]});
test('Word inline audit protects text outside the matched range',()=>{
  const p=paragraph('/body/p[@paraId=00100000]','前目标后',{size:'11pt'});
  const before={type:'body',path:'/body',childCount:1,format:{},children:[p]},after=structuredClone(before);
  after.children[0].children=['前','目标','后'].map((text,i)=>({type:'run',path:`${p.path}/r[${i+1}]`,text,childCount:0,format:{size:'11pt',...(i===1?{bold:true}:{})},children:[]}));
  after.children[0].childCount=3;
  const op=parse({action:'format_text',path:p.path,props:{find:'目标',bold:true}});
  assert.deepEqual(checkWordChanges(before,after,[op]).formatted_text_ranges,[{path:p.path,find:'目标',start:1,end:3}]);
  after.children[0].children[2].format.bold=true;
  assert.throws(()=>checkWordChanges(before,after,[op]),/其他文字/);
});

test('Word table planning refuses merged cells, overflow and mismatched deletion evidence',()=>{
  const table={type:'table',path:'/body/tbl[1]',children:[{type:'row',format:{},children:[{type:'cell',text:'原文',format:{width:'9025dxa'},children:[paragraph('/body/tbl[1]/tr[1]/tc[1]/p[1]','原文')]}]}]};
  const body={children:[table,{type:'section',format:{pageWidth:'21cm',marginLeft:'2.54cm',marginRight:'2.54cm'}}]};
  assert.throws(()=>tableCommands(table,parse({action:'table_layout',path:table.path,props:{colWidths:['18cm']}}),body),/正文宽度/);
  assert.throws(()=>tableCommands(table,parse({action:'remove_row',path:table.path,props:{index:1,expected_values:['错误']}}),body),/至少|保留/);
  assert.throws(()=>tableCommands(table,parse({action:'insert_row',path:table.path,props:{index:2,values:['多','余']}}),body),/数量/);
  table.children[0].children[0].format.colspan=2;
  assert.throws(()=>tableCommands(table,parse({action:'table_layout',path:table.path,props:{repeat_header:true}}),body),/合并/);
});

test('explicit column widths replace grid-derived widths without accepting other changes',()=>{
  const before={type:'table',path:'/body/tbl[1]',childCount:1,format:{rows:'1',cols:'1',_gridCols:'1',width:'9025',layout:'fixed',colWidths:'9025dxa'},children:[{type:'row',childCount:1,format:{},children:[{type:'cell',text:'原文',childCount:1,format:{width:'9025dxa',_widthDerived:true},children:[paragraph('/body/tbl[1]/tr[1]/tc[1]/p[1]','原文')]}]}]};
  const after=structuredClone(before);Object.assign(after.format,{width:'2835',colWidths:'2835dxa'});
  after.children[0].children[0].format={width:'2835dxa'};
  const op=parse({action:'table_layout',path:before.path,props:{colWidths:['5cm']}});
  checkTableChange(before,after,op,(a,b)=>{assert.deepEqual(a,b);return true;});
  const body=table=>({type:'body',path:'/body',childCount:1,format:{},children:[table]});
  assert.deepEqual(checkWordChanges(body(before),body(after),[op]).table_changes,[{path:before.path,action:'table_layout',rows_before:1,rows_after:1,columns_before:1,columns_after:1}]);
  after.children[0].children[0].text='意外修改';
  assert.throws(()=>checkTableChange(before,after,op,(a,b)=>{assert.deepEqual(a,b);return true;}));
});

test('real Word table layout, row/column changes and inline formatting preserve surrounding content',async()=>{
  const cwd=await mkdtemp(join(tmpdir(),'office-word-advanced-'));
  const context={cwd,plugin:{root:resolve('plugins/office-work'),dataDir:join(cwd,'data')},permissions:{filesystem:['read','write'],process:['officecli']},signal:new AbortController().signal};
  const tools=Object.fromEntries(registerWordTools().map(t=>[t.name,t]));
  const call=async(name,input)=>tools[name].invoke(input,{...context,deadline:Date.now()+60000});
  const parsed=result=>{assert.notEqual(result.isError,true,result.content[0].text);return JSON.parse(result.content[0].text);};
  try {
    let current=parsed(await call('OfficeWordCreate',{path:'report.docx',title:'Word 功能验收',blocks:[{type:'paragraph',text:'保留前文，目标片段，保留后文。'},{type:'table',rows:[['方案','边界'],['A','原始约束'],['B','原始结论']]},{type:'paragraph',text:'未请求的证据限制。'}]}));
    const read=async(target,depth=4)=>parsed(await call('OfficeWordRead',{path:current.path,target,depth}));
    const edit=async(operation)=>{const source=current.sha256,result=await call('OfficeWordEdit',{path:current.path,expected_sha256:source,operations:[operation]});assert.notEqual(result.isError,true,operation.action+': '+result.content[0].text);current=parsed(result);assert.equal(current.change_check.source_sha256,source);assert.equal(current.change_check.sha256,current.sha256);return current;};
    const body=(await read('/body',1)).document.data.results[0];
    const selected=body.children.find(n=>n.text==='保留前文，目标片段，保留后文。').path;
    await edit({action:'format_text',path:selected,props:{find:'目标片段',bold:true,color:'#123456'}});
    const text=(await read(selected)).document.data.results[0];
    assert.equal(text.text,'保留前文，目标片段，保留后文。');
    assert.equal(text.children.filter(r=>r.format.bold===true).map(r=>r.text).join(''),'目标片段');
    await edit({action:'table_layout',path:'/body/tbl[1]',props:{colWidths:['5cm','10.92cm'],repeat_header:false,allow_row_split:true}});
    let table=(await read('/body/tbl[1]')).document.data.results[0];
    assert.equal(table.children[0].format.header,undefined);assert.equal(table.children[1].format.cantSplit,undefined);
    await edit({action:'insert_row',path:table.path,props:{index:2,values:['新增方案','新增证据']}});
    table=(await read(table.path)).document.data.results[0];
    assert.deepEqual(table.children.map(r=>r.children.map(c=>c.text)),[['方案','边界'],['新增方案','新增证据'],['A','原始约束'],['B','原始结论']]);
    await edit({action:'insert_column',path:table.path,props:{index:2,values:['状态','待复核','有效','有限'],colWidths:['4cm','3cm','8.92cm']}});
    table=(await read(table.path)).document.data.results[0];
    assert.deepEqual(table.children[1].children.map(c=>c.text),['新增方案','待复核','新增证据']);
    const saved=await readFile(current.path);
    const bad=await call('OfficeWordEdit',{path:current.path,expected_sha256:current.sha256,operations:[{action:'remove_column',path:table.path,props:{index:2,expected_values:['错误','待复核','有效','有限'],colWidths:['5cm','10.92cm']}}]});
    assert.equal(bad.isError,true);assert.deepEqual(await readFile(current.path),saved);
    await edit({action:'remove_column',path:table.path,props:{index:2,expected_values:['状态','待复核','有效','有限'],colWidths:['5cm','10.92cm']}});
    await edit({action:'remove_row',path:table.path,props:{index:2,expected_values:['新增方案','新增证据']}});
    await edit({action:'table_layout',path:table.path,props:{repeat_header:true,allow_row_split:false}});
    table=(await read(table.path)).document.data.results[0];
    assert.deepEqual(table.children.map(r=>r.children.map(c=>c.text)),[['方案','边界'],['A','原始约束'],['B','原始结论']]);
    assert.equal(table.children[0].format.header,true);assert.ok(table.children.every(r=>r.format.cantSplit===true));
    const final=parsed(await call('OfficeWordCheck',{path:current.path}));
    assert.equal(final.document.data.results[0].children.find(n=>n.text==='未请求的证据限制。').text,'未请求的证据限制。');
    assert.deepEqual(final.change_check.updated_tables,['/body/tbl[1]']);
    assert.equal((await read(selected)).document.data.results[0].children.filter(r=>r.format.bold===true).map(r=>r.text).join(''),'目标片段');
    assert.equal((await readdir(cwd)).some(n=>n.startsWith('.office-work-')||n.endsWith('.office-work.lock')),false);
  }finally{await rm(cwd,{recursive:true,force:true});}
});
