import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRunner} from '../tools/engine.mjs';
import {withWorkingFile} from '../tools/working-file.mjs';

const context=()=>({cwd:process.cwd(),signal:new AbortController().signal,deadline:Date.now()+30000});

test('Word working copies keep the .docx extension',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'office-word-copy-'));
  try {
    await withWorkingFile(join(dir,'source.docx'),async()=>{},context(),async work=>{
      assert.ok(work.endsWith('.docx'));await writeFile(work,'private');return {};
    });
    assert.deepEqual(await readdir(dir),[]);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('close tolerates startup slower than two seconds, including after caller cancellation',async()=>{
  const ctx=context();const controller=new AbortController();controller.abort();ctx.signal=controller.signal;
  const run=createRunner(process.execPath,ctx);
  assert.equal(await run(['-e','setTimeout(()=>process.stdout.write("closed"),2200)'],undefined,true),'closed');
});

test('temporary close failure retries once, then cleans its own working directory',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'office-cleanup-'));let closes=0;
  try {
    const result=await withWorkingFile(join(dir,'source.pptx'),async()=>{
      if(++closes===1)throw Object.assign(new Error('close timeout'),{code:'office_close_timeout'});
    },context(),async work=>{await writeFile(work,'private copy');return {read:true};});
    assert.equal(result.read,true);assert.equal(closes,2);assert.deepEqual(await readdir(dir),[]);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('operation failure remains the primary error; recovered close still releases the copy',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'office-cleanup-'));let closes=0;
  try {
    await assert.rejects(withWorkingFile(join(dir,'source.pptx'),async()=>{
      if(++closes===1)throw new Error('close failed');
    },context(),async work=>{await writeFile(work,'private');throw new Error('original operation failed');}),/original operation failed/);
    assert.equal(closes,2);assert.deepEqual(await readdir(dir),[]);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('permanent close failure retains the private copy, reports both errors and stops retrying',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'office-cleanup-'));let closes=0;
  try {
    await assert.rejects(withWorkingFile(join(dir,'source.pptx'),async()=>{closes++;throw new Error('close failed');},context(),async work=>{
      await writeFile(work,'private');throw new Error('original operation failed');
    }),error=>error.code==='office_cleanup_failed'&&/original operation failed/.test(error.message)&&/close failed/.test(error.message));
    assert.equal(closes,2);assert.equal((await readdir(dir)).length,1);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('delete failure after publication returns the saved result with a cleanup warning',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'office-cleanup-'));
  try {
    const result=await withWorkingFile(join(dir,'source.pptx'),async()=>{},context(),async work=>{
      await writeFile(work,'private');return {path:'published.pptx',sha256:'saved'};
    },async()=>{throw new Error('directory busy');});
    assert.equal(result.path,'published.pptx');assert.equal(result.sha256,'saved');
    assert.equal(result.cleanup_complete,false);assert.match(result.cleanup_warning,/directory busy/);
  }finally{await rm(dir,{recursive:true,force:true});}
});
