import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,copyFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {registerTools} from '../tools/index.mjs';
import {hash} from '../tools/engine.mjs';

const checks=(status,observation)=>({body:{status,observation},header:{status:'not_applicable',observation:'文档无页眉。'},footer:{status:'not_applicable',observation:'文档无页脚。'},pagination:{status:'passed',observation:'模拟分页观察。'}});

test('Word exposes six document tools',()=>{
  const names=registerTools().filter(tool=>tool.name.startsWith('OfficeWord')).map(tool=>tool.name);
  assert.deepEqual(names,['OfficeWordCreate','OfficeWordRead','OfficeWordEdit','OfficeWordCheck','OfficeWordPreview','OfficeWordReview']);
});

test('real Word tools preserve other paragraphs, version checks and user originals',async()=>{
  const cwd=await mkdtemp(join(tmpdir(),'office-word-tools-'));
  const context={cwd,plugin:{root:resolve('plugins/office-work'),dataDir:join(cwd,'data')},permissions:{filesystem:['read','write'],process:['officecli']},signal:new AbortController().signal};
  const tools=Object.fromEntries(registerTools().map(tool=>[tool.name,tool]));
  assert.ok(tools.OfficeWordCreate);
  const call=(name,input)=>tools[name].invoke(input,{...context,deadline:Date.now()+60000});
  const parsed=result=>{assert.notEqual(result.isError,true,result.content[0].text);return JSON.parse(result.content[0].text);};
  try {
    const created=parsed(await call('OfficeWordCreate',{path:'report.docx',title:'插件持久化方案评估',blocks:[{type:'paragraph',text:'研究结论',style:'Heading1'},{type:'paragraph',text:'原始建议是采用稳定 dataDir。'},{type:'paragraph',text:'重复词 重复词'},{type:'table',rows:[['方案','边界'],['结果引用','待补充']]},{type:'paragraph',text:'证据限制：以宿主契约为准。'},{type:'paragraph',text:'未修改段落必须保留。'}]}));
    const body=parsed(await call('OfficeWordRead',{path:created.path}));
    const paragraphs=body.document.data.results[0].children.filter(node=>node.type==='paragraph');
    assert.equal(paragraphs[0].style,'Title');
    assert.equal(paragraphs[1].style,'Heading1');
    const table=parsed(await call('OfficeWordRead',{path:created.path,target:'/body/tbl[1]'}));
    assert.equal(table.document.data.results[0].type,'table');
    const previewA=parsed(await call('OfficeWordPreview',{path:created.path,page:1}));
    assert.equal(previewA.page_number_basis,'officecli-html');
    assert.equal(previewA.page_count,undefined);
    const reviewA={path:created.path,expected_sha256:created.sha256,pages:[{preview_id:previewA.preview_id,checks:checks('issues','自动化测试模拟观察；不代表人工验收。')}]};
    parsed(await call('OfficeWordReview',reviewA));
    assert.equal((await call('OfficeWordPreview',{path:created.path,page:200})).isError,true);
    const selected=paragraphs.find(p=>p.text==='原始建议是采用稳定 dataDir。');
    assert.match(selected.path,/@paraId=/);
    let edited=parsed(await call('OfficeWordEdit',{path:created.path,expected_sha256:body.sha256,operations:[{path:selected.path,props:{find:'稳定 dataDir',replace:'宿主结构化存储'}}]}));
    assert.equal(edited.path,created.path);
    const read=parsed(await call('OfficeWordRead',{path:created.path,target:selected.path}));
    assert.equal(read.document.data.results[0].text,'原始建议是采用宿主结构化存储。');
    assert.equal(read.document.data.results[0].style,'Normal');
    const untouched=parsed(await call('OfficeWordRead',{path:created.path,target:paragraphs.at(-1).path}));
    assert.equal(untouched.document.data.results[0].text,'未修改段落必须保留。');
    const beforeNewReview=parsed(await call('OfficeWordCheck',{path:created.path}));
    assert.equal(beforeNewReview.visual_review,undefined);
    assert.equal((await call('OfficeWordReview',reviewA)).isError,true);
    const cell=parsed(await call('OfficeWordRead',{path:created.path,target:'/body/tbl[1]/tr[2]/tc[2]/p[1]'}));
    edited=parsed(await call('OfficeWordEdit',{path:created.path,expected_sha256:edited.sha256,operations:[{path:cell.document.data.results[0].path,props:{find:'待补充',replace:'仅限缓存用途'}}]}));
    const cellAfter=parsed(await call('OfficeWordRead',{path:created.path,target:'/body/tbl[1]/tr[2]/tc[2]/p[1]'}));
    assert.equal(cellAfter.document.data.results[0].text,'仅限缓存用途');
    const previewB=parsed(await call('OfficeWordPreview',{path:created.path,page:1}));
    parsed(await call('OfficeWordReview',{path:created.path,expected_sha256:edited.sha256,pages:[{preview_id:previewB.preview_id,checks:checks('issues','新版自动化测试模拟观察。')}]}));
    const checked=parsed(await call('OfficeWordCheck',{path:created.path}));
    assert.equal(checked.structure_checked,true);assert.equal(checked.visual_checked,false);
    assert.equal(checked.sha256,edited.sha256);assert.deepEqual(checked.visual_review.checked_pages,[1]);assert.equal(checked.visual_review.sha256,edited.sha256);
    const repeated=paragraphs.find(p=>p.text==='重复词 重复词');
    assert.equal((await call('OfficeWordEdit',{path:created.path,expected_sha256:edited.sha256,operations:[{path:repeated.path,props:{find:'重复词',replace:'bad'}}]})).isError,true);
    edited=parsed(await call('OfficeWordEdit',{path:created.path,expected_sha256:edited.sha256,operations:[
      {path:selected.path,props:{align:'justify',bold:true,italic:true,size:'12.5pt',color:'#123456',spaceBefore:'12pt',spaceAfter:'8pt',lineSpacing:'2x'}},
      {action:'insert_before',path:paragraphs.at(-1).path,props:{text:'新增的验收说明。'}},
      {action:'insert_after',path:paragraphs[1].path,props:{text:'新增小标题',style:'Heading2'}},
      {action:'remove',path:repeated.path,props:{expected_text:repeated.text}},
    ]}));
    assert.equal(edited.change_check.scope,'officecli_body_tree');
    assert.deepEqual(edited.change_check.updated_paragraphs,[selected.path]);
    assert.deepEqual(edited.change_check.removed_paragraphs,[repeated.path]);
    assert.equal(edited.change_check.inserted_paragraphs.length,2);
    assert.equal(edited.change_check.sha256,edited.sha256);
    const final=parsed(await call('OfficeWordCheck',{path:created.path}));
    assert.deepEqual(final.change_check,edited.change_check);assert.equal(final.visual_review,undefined);
    const finalChildren=final.document.data.results[0].children;
    assert.equal(finalChildren.at(-2).text,'未修改段落必须保留。');
    assert.equal(finalChildren.at(-3).text,'新增的验收说明。');
    assert.equal(finalChildren[2].text,'新增小标题');
    const valid=await readFile(created.path);
    const edit=operations=>call('OfficeWordEdit',{path:created.path,expected_sha256:edited.sha256,operations});
    assert.equal((await edit([{path:selected.path,props:{find:'不存在的内容',replace:'bad'}}])).isError,true);
    assert.equal((await edit([{action:'remove',path:selected.path,props:{expected_text:'错误的原文'}}])).isError,true);
    assert.equal((await edit([{action:'remove',path:cell.document.data.results[0].path,props:{expected_text:'仅限缓存用途'}}])).isError,true);
    assert.equal((await edit([{path:selected.path,props:{find:'宿主结构化存储',replace:'先改'}},{path:'/body/p[99]',props:{find:'x',replace:'y'}}])).isError,true);
    assert.equal((await edit([{path:selected.path,props:{find:'r".*"',replace:'bad'}}])).isError,true);
    assert.equal((await edit([{path:'/body/sectPr[1]',props:{find:'x',replace:'y'}}])).isError,true);
    assert.equal((await call('OfficeWordEdit',{path:created.path,expected_sha256:created.sha256,operations:[{path:selected.path,props:{find:'宿主结构化存储',replace:'过期'}}]})).isError,true);
    assert.deepEqual(await readFile(created.path),valid);
    await copyFile(created.path,join(cwd,'user.docx'));
    const copy=parsed(await call('OfficeWordEdit',{path:'user.docx',expected_sha256:hash(valid),operations:[{path:selected.path,props:{find:'宿主结构化存储',replace:'另存验证'}}]}));
    assert.equal(copy.path,join(cwd,'user-edited.docx'));
    assert.deepEqual(await readFile(join(cwd,'user.docx')),valid);
    assert.equal((await call('OfficeWordCreate',{path:'report.docx',title:'覆盖',blocks:[{type:'paragraph',text:'bad'}]})).isError,true);
    assert.equal((await call('OfficeWordRead',{path:resolve(cwd,'../outside.docx')})).isError,true);
    assert.equal((await call('OfficeWordRead',{path:'report.pptx'})).isError,true);
    assert.equal((await readdir(cwd)).some(name=>name.startsWith('.office-work-')||name.endsWith('.office-work.lock')),false);
  } finally {await rm(cwd,{recursive:true,force:true});}
});
