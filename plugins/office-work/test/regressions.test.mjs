import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { withFiles, assertFileAvailable } from '../tools/file-access.mjs';

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
