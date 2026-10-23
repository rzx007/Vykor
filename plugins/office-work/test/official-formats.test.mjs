import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {registerTools} from '../tools/index.mjs';
async function fixture() {
  const cwd=await mkdtemp(join(tmpdir(),'official-formats-'));
  const context={cwd,plugin:{root:fileURLToPath(new URL('..',import.meta.url)),dataDir:join(cwd,'data')},permissions:{filesystem:['read','write'],process:['officecli']},signal:new AbortController().signal};
  const tool=registerTools().find(t=>t.name==='OfficeCLI');
  const invoke=input=>tool.invoke(input,{...context,deadline:Date.now()+60000});
  return {cwd,invoke,call:async input=>{const r=await invoke(input);assert.notEqual(r.isError,true,r.content[0].text);return JSON.parse(r.content[0].text);}};
}
test('real OfficeCLI: PPT native create, table, targeted edit and validation',async()=>{
  const {cwd,call,invoke}=await fixture();
  try {
    let r=await call({command:'create',path:'slides.pptx'});
    r=await call({command:'batch',path:r.path,expected_sha256:r.sha256,operations:[
      {command:'add',parent:'/',type:'slide',props:{title:'保留页',text:'不要修改'}},
      {command:'add',parent:'/',type:'slide',props:{title:'编辑页'}},
      {command:'add',parent:'/slide[2]',type:'shape',props:{text:'待修改',x:'1cm',y:'3cm',width:'8cm',height:'2cm'}},
      {command:'add',parent:'/slide[2]',type:'table',props:{rows:'2',cols:'2',x:'1cm',y:'6cm',width:'20cm',height:'3cm'}},
      {command:'set',path:'/slide[2]/table[1]/tr[1]/tc[1]',props:{text:'项目'}},
      {command:'set',path:'/slide[2]/table[1]/tr[2]/tc[1]',props:{text:'原生表格'}},
    ]});
    const read=await call({command:'get',path:r.path,args:['/slide[2]','--json']});
    const shape=read.result.data.results[0].children.find(n=>n.text==='待修改');assert.ok(shape);
    r=await call({command:'set',path:r.path,expected_sha256:r.sha256,scope_targets:[shape.path],args:[shape.path,'--prop','text=修改完成','--prop','italic=true']});
    assert.equal(r.scope_verified,true);
    assert.equal((await invoke({command:'set',path:r.path,expected_sha256:r.sha256,scope_targets:[shape.path],args:['/slide[1]/shape[1]','--prop','text=越界']})).isError,true);
    const after=await call({command:'get',path:r.path,args:['/','--depth','3','--json']});
    assert.equal(after.sha256,r.sha256);
    assert.match(JSON.stringify(after.result),/保留页/);assert.match(JSON.stringify(after.result),/不要修改/);assert.match(JSON.stringify(after.result),/修改完成/);
    assert.equal((await call({command:'validate',path:r.path})).structure_checked,true);
  } finally {await rm(cwd,{recursive:true,force:true});}
});
test('real OfficeCLI: Excel native text IDs, cross-sheet formulas, charts and local format edits',async()=>{
  const {cwd,call,invoke}=await fixture();
  try {
    let r=await call({command:'create',path:'book.xlsx'});
    r=await call({command:'batch',path:r.path,expected_sha256:r.sha256,operations:[
      {command:'set',path:'/Sheet1',props:{name:'S'}},{command:'add',parent:'/',type:'sheet',props:{name:'T'}},
      {command:'set',path:'/S/A1',props:{value:'编号',type:'string',bold:true}},{command:'set',path:'/S/B1',props:{value:'金额',type:'string',bold:true}},
      {command:'set',path:'/S/A2',props:{value:'0001',type:'string'}},{command:'set',path:'/S/B2',props:{value:'10',type:'number'}},
      {command:'set',path:'/S/A3',props:{value:'0002',type:'string'}},{command:'set',path:'/S/B3',props:{value:'20',type:'number'}},
      {command:'set',path:'/T/A1',props:{formula:"SUM('S'!B2:B3)"}},
      {command:'add',parent:'/S',type:'chart',props:{type:'column',dataRange:'S!A1:B3',title:'金额',anchor:'D2:L18'}},
    ]});
    r=await call({command:'set',path:r.path,expected_sha256:r.sha256,scope_targets:['/S/B2'],args:['/S/B2','--prop','value=15']});
    r=await call({command:'set',path:r.path,expected_sha256:r.sha256,scope_targets:['/S/A2:B3'],args:['/S/A2:B3','--prop','font.bold=true']});
    assert.equal(r.scope_verified,true);
    assert.equal((await invoke({command:'set',path:r.path,expected_sha256:r.sha256,scope_targets:['/S/B2'],args:['/S/B3','--prop','value=999']})).isError,true);
    const data=await call({command:'get',path:r.path,args:['/S/A2:B3','--depth','3','--json']});assert.match(JSON.stringify(data.result),/0001/);assert.match(JSON.stringify(data.result),/15/);
    assert.equal(data.sha256,r.sha256);
    const total=await call({command:'get',path:r.path,args:['/T/A1','--json']});assert.match(JSON.stringify(total.result),/SUM/);
    const chart=await call({command:'get',path:r.path,args:['/S/chart[1]','--json']});assert.match(JSON.stringify(chart.result),/金额/);
    assert.equal((await call({command:'validate',path:r.path})).structure_checked,true);
  } finally {await rm(cwd,{recursive:true,force:true});}
});
