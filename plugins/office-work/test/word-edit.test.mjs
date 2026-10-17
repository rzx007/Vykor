import {test} from 'node:test';
import assert from 'node:assert/strict';
import {wordEdits,checkWordChanges,editWord} from '../tools/word-edit.mjs';

const paragraph=(id,text)=>({path:`/body/p[@paraId=${id}]`,type:'paragraph',text,preview:text,childCount:0,format:{paraId:id,align:'left'},children:[]});
const first=paragraph('00100000','待修改'),last=paragraph('00100002','保留内容');
const body=children=>({type:'body',path:'/body',childCount:children.length,format:{},children});
const input=operations=>({expected_sha256:'a'.repeat(64),operations});

test('Word edit restricts operations and formatting to its declared scope',()=>{
  const valid=wordEdits(input([{path:first.path,props:{find:'待修改',replace:'新结论',bold:true,size:'12.5pt'}},{action:'insert_after',path:last.path,props:{text:'新增内容',style:'Heading2'}}]));
  assert.equal(valid[0].action,'update');assert.equal(valid[1].props.font,'Microsoft YaHei');
  for(const operation of [
    {path:first.path,props:{size:'2pt'}},{path:first.path,props:{bold:'true'}},
    {path:first.path,props:{color:'red'}},{path:first.path,props:{text:'整段覆盖'}},
    {path:first.path,props:{find:'r".*"',replace:'bad'}},
    {path:first.path,props:{}},{action:'remove',path:first.path,props:{}},
    {action:'insert_before',path:'/body/tbl[1]/tr[1]/tc[1]/p[1]',props:{text:'bad'}},
    {path:first.path,props:{style:'ArbitraryStyle'}},
  ])assert.throws(()=>wordEdits(input([operation])));
});

test('Word change check reports paragraph additions, deletions and updates',()=>{
  const before=body([structuredClone(first),structuredClone(last)]),after=structuredClone(before);
  after.children[0].text='新结论';after.children[0].format.bold=true;
  const added=paragraph('00100004','新增内容');
  after.children.splice(1,1,added);
  const operations=[{action:'update',path:first.path,props:{find:'待修改',replace:'新结论',bold:true}},{action:'insert_after',path:first.path,props:{text:'新增内容'}},{action:'remove',path:last.path,props:{expected_text:'保留内容'}}];
  // Insertion anchored to an updated paragraph is intentionally split across calls.
  assert.throws(()=>checkWordChanges(before,after,operations),/同一段落/);
  const inserted=body([structuredClone(first),added,structuredClone(last)]);
  const checked=checkWordChanges(before,inserted,[operations[1]]);
  assert.deepEqual(checked.inserted_paragraphs,[added.path]);
  const removed=checkWordChanges(before,body([structuredClone(first)]),[operations[2]]);
  assert.deepEqual(removed.removed_paragraphs,[last.path]);
  const updated=structuredClone(before);updated.children[0]=after.children[0];
  assert.deepEqual(checkWordChanges(before,updated,[operations[0]]).updated_paragraphs,[first.path]);
});

test('Word check rejects unrelated body changes, wrong formats and insertion positions',()=>{
  const before=body([structuredClone(first),structuredClone(last)]);
  const operations=[{action:'update',path:first.path,props:{find:'待修改',replace:'新结论',align:'right'}}];
  const after=structuredClone(before);after.children[0].text='新结论';after.children[0].format.align='right';
  assert.equal(checkWordChanges(before,after,operations).other_body_content_unchanged,true);
  after.children[1].text='不应改变';assert.throws(()=>checkWordChanges(before,after,operations),/未请求/);
  after.children[1].text=last.text;after.children[0].format.align='left';assert.throws(()=>checkWordChanges(before,after,operations),/格式回读/);
  assert.throws(()=>checkWordChanges(before,body([paragraph('00100004','新段'),first,last]),[{action:'insert_after',path:first.path,props:{text:'新段'}}]),/插入位置/);
});

test('Word edit binds original stable paths before deleting or inserting',async()=>{
  const before=body([structuredClone(first),structuredClone(last)]),added=paragraph('00100004','新增');
  const after=body([added,structuredClone(last)]);let commands,reads=0;
  const run=async(args,ops)=>{
    if(args[0]==='get')return JSON.stringify({success:true,data:{results:[reads++?after:before]}});
    commands=ops;return '{}';
  };
  const operations=wordEdits(input([{action:'remove',path:'/body/p[1]',props:{expected_text:first.text}},{action:'insert_before',path:'/body/p[2]',props:{text:'新增'}}]));
  // Readback fixture mirrors the default formatting written for the inserted paragraph.
  Object.assign(added.format,{style:'Normal',align:'left',size:'11pt',lineSpacing:'1.5x',spaceAfter:'6pt'});added.style='Normal';
  const result=await editWord(run,'fixture.docx',operations);
  assert.equal(commands[0].path,first.path);assert.equal(commands[1].before,last.path);
  assert.deepEqual(result.removed_paragraphs,[first.path]);assert.deepEqual(result.inserted_paragraphs,[added.path]);
});

test('Word refuses incomplete body trees before sending mutation commands',async()=>{
  let writes=0;
  const run=async(args)=>{if(args[0]!=='get')writes++;return JSON.stringify({success:true,data:{results:[body([{...first,childCount:1}])]}});};
  await assert.rejects(()=>editWord(run,'fixture.docx',wordEdits(input([{path:first.path,props:{align:'right'}}]))),/层级/);
  assert.equal(writes,0);
});

test('inserted heading pagination defaults are compared with boolean readback',()=>{
  const before=body([structuredClone(first),structuredClone(last)]);
  const added={...paragraph('00100004','新标题'),style:'Heading2',format:{align:'left',size:'14pt',spaceAfter:'6pt',lineSpacing:'1.5x',keepNext:true,keepLines:true}};
  const op=wordEdits(input([{action:'insert_after',path:first.path,props:{text:'新标题',style:'Heading2'}}]));
  assert.deepEqual(checkWordChanges(before,body([structuredClone(first),added,structuredClone(last)]),op).inserted_paragraphs,[added.path]);
});

test('Word check includes table descendants and protects cell layout',()=>{
  const p={...paragraph('00100004','原文'),path:'/body/tbl[1]/tr[1]/tc[1]/p[@paraId=00100004]'};
  const cell={type:'cell',path:'/body/tbl[1]/tr[1]/tc[1]',text:'原文',childCount:1,format:{width:'4000dxa',size:'11pt'},children:[p]};
  const row={type:'row',path:'/body/tbl[1]/tr[1]',childCount:1,format:{},children:[cell]};
  const table={type:'table',path:'/body/tbl[1]',childCount:1,format:{},children:[row]};
  const before=body([structuredClone(first),table]),after=structuredClone(before);
  const nextCell=after.children[1].children[0].children[0];
  nextCell.text='新文';nextCell.children[0].text='新文';
  const operations=[{action:'update',path:p.path,props:{find:'原文',replace:'新文'}}];
  assert.equal(checkWordChanges(before,after,operations).checked,true);
  nextCell.format.width='2000dxa';assert.throws(()=>checkWordChanges(before,after,operations),/未请求/);
});
