import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { tableLayout, assertTableTextClearance } from '../tools/table-layout.mjs';
import { withFiles, assertFileAvailable } from '../tools/file-access.mjs';

test('table layout reserves readable font and content-dependent row heights within the canvas', () => {
  const layout=tableLayout({rows:[['方案','关键边界'],['文件','需要保留原子写入、损坏恢复与迁移限制。'.repeat(3)]],width:'24cm',y:'3.5cm',colWidths:'8cm,16cm'});
  assert.equal(layout.size,16);
  assert.ok(layout.rowHeights[1]>layout.rowHeights[0]);
  assert.ok(layout.rowHeights[1]>29.2);
  assert.equal(layout.rowHeights.reduce((a,b)=>a+b,0),layout.height);
  assert.throws(()=>tableLayout({rows:[['标题'],['长内容'.repeat(300)]],width:'5cm',y:'3.5cm'}),/精简|拆页/);
  assert.throws(()=>tableLayout({rows:[['标题'],['长内容'.repeat(30)]],height:'1cm'}),/行高|高度/);
  assert.throws(()=>tableLayout({rows:[['a','b']],width:'10cm',colWidths:'2cm,3cm'}),/列宽/);
});

test('table clearance uses final row heights and rejects the v023 evidence-note overlap',()=>{
  const layout=tableLayout({rows:[['方案','定位','关键边界'],['1｜dataDir 自管文件','大文件、二进制、超量数据','VS Code 定位本地目录存大文件；Raycast 指引大量数据写入 support 目录'],['2｜宿主结构化存储','配置与小型业务状态','Chrome local 10 MB、sync 约 100 KB／项 8 KB；Raycast 限 string / number / boolean'],['3｜工具结果引用','由宿主契约决定','缺少直接实现证据；淘汰规则属缓存自身契约，不可推广']],colWidths:'4.6cm,15cm,11.1cm',width:'30.7cm',x:'1.6cm',y:'3.5cm',size:'16pt'});
  const note={text:'证据限制',x:'1.6cm',y:'10.6cm',width:'30.7cm',height:'3.6cm'};
  assert.equal(layout.height,237);
  assert.throws(()=>assertTableTextClearance(layout,[note],3,1),/第 3 页.*第 1 个表格.*第 1 个文本框.*12\.08cm/);
  assert.doesNotThrow(()=>assertTableTextClearance(layout,[{...note,y:'12.1cm'}],3,1));
  assert.equal(note.y,'10.6cm','validation must not move author content');
});

test('table clearance allows separate text and decorative backgrounds',()=>{
  const layout={x:100,y:100,width:200,height:200};
  assert.doesNotThrow(()=>assertTableTextClearance(layout,[
    {text:'heading',x:'100pt',y:'20pt',width:'200pt',height:'50pt'},
    {text:'side note',x:'320pt',y:'100pt',width:'100pt',height:'200pt'},
    {fill:'eeeeee',x:'100pt',y:'100pt',width:'200pt',height:'200pt'},
  ],1,1));
  assert.throws(()=>assertTableTextClearance(layout,[{text:'too tall',x:'100pt',y:'200pt',width:'200pt',height:'250pt'}],1,1),/精简.*拆页/);
});

test('same-file calls wait, release after errors, respect deadline and cancellation without removing another lock', async () => {
  const dir=await mkdtemp(join(tmpdir(),'office-lock-'));
  const file=join(dir,'demo.pptx');
  const context=()=>({signal:new AbortController().signal,deadline:Date.now()+30000});
  const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  try {
    const events=[];
    await Promise.all([1,2,3].map(n=>withFiles([file],context(),async()=>{events.push('start'+n);await sleep(30);events.push('end'+n);})));
    for(let i=0;i<events.length;i+=2) assert.equal(events[i].slice(5),events[i+1].slice(3));
    await assert.rejects(withFiles([file],context(),async()=>{throw new Error('operation failed');}),/operation failed/);
    await withFiles([file],context(),async()=>{});
    await writeFile(file+'.office-work.lock','external');
    await assert.rejects(withFiles([file],{...context(),deadline:Date.now()+100},async()=>{}),/等待|繁忙/);
    const controller=new AbortController();controller.abort();
    await assert.rejects(withFiles([file],{...context(),signal:controller.signal},async()=>{}),/取消/);
    assert.deepEqual(await readdir(dir),['demo.pptx.office-work.lock']);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('Office owner file produces actionable feedback before invoking the engine', async () => {
  const dir=await mkdtemp(join(tmpdir(),'office-owner-'));
  try {
    const file=join(dir,'demo.pptx'); await writeFile(file,'unchanged');
    await assertFileAvailable(file);
    await writeFile(join(dir,'~$demo.pptx'),'owner');
    await assert.rejects(assertFileAvailable(file),error=>error.code==='office_file_in_use'&&/PowerPoint|WPS/.test(error.message)&&/关闭/.test(error.message));
  } finally {await rm(dir,{recursive:true,force:true});}
});
