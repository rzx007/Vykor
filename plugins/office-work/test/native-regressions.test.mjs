import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createRunner,hash} from '../tools/engine.mjs';
import {readOfficeParts} from '../tools/office-package.mjs';
import {registerTools} from '../tools/index.mjs';
import {withFiles} from '../tools/file-access.mjs';
import {withWorkingFile} from '../tools/working-file.mjs';
async function fixture(){
 const cwd=await mkdtemp(join(tmpdir(),'office-v0121-'));
 const context={cwd,plugin:{root:fileURLToPath(new URL('..',import.meta.url)),dataDir:join(cwd,'data')},permissions:{filesystem:['read','write'],process:['officecli']},signal:new AbortController().signal,deadline:Date.now()+180000,commandTimeoutMs:30000};
 const run=createRunner(join(context.plugin.root,'bin','officecli-win-x64.exe'),context);
 const call=async(name,input)=>{const r=await registerTools().find(t=>t.name===name).invoke(input,context);assert.notEqual(r.isError,true,r.content[0].text);return JSON.parse(r.content[0].text);};
 return {cwd,context,run,call};
}
async function noCopies(cwd){assert.deepEqual((await readdir(cwd)).filter(n=>n.startsWith('.office-work-')||n.endsWith('.office-work.lock')),[]);}
test('real OfficeCLI: native Word preview supports a single page and a paginated second page without changing the source',async()=>{
 const {cwd,run,call,context}=await fixture(),file=join(cwd,'test.docx');
 try {
  await run(['create',file]);await run(['add',file,'/body','--type','paragraph','--prop','text=First page']);await run(['add',file,'/','--type','header','--prop','type=default','--prop','text=Test header']);await run(['add',file,'/','--type','footer','--prop','type=default','--prop','text=Page ','--prop','field=page']);await run(['close',file],undefined,true);
  let sha=hash(await readFile(file));const first=await call('OfficeWordPreview',{path:file,page:1});
  assert.equal(first.rendered_pages,1);assert.equal(first.cleanup_complete,true);assert.equal(hash(await readFile(file)),sha);await noCopies(cwd);
  await run(['add',file,'/body','--type','paragraph','--prop','text=Second page','--prop','pageBreakBefore=true']);await run(['close',file],undefined,true);
  sha=hash(await readFile(file));const second=await call('OfficeWordPreview',{path:file,page:2});
  assert.equal(second.rendered_pages,2);assert.equal(second.page,2);assert.equal(second.cleanup_complete,true);assert.equal(hash(await readFile(file)),sha);await noCopies(cwd);
  assert.deepEqual(second.expected_elements,{header:true,footer:true});console.log('Word evidence',cwd,first.image_path,second.image_path);
  const invalid=await registerTools().find(t=>t.name==='OfficeWordPreview').invoke({path:file,page:3},context);assert.equal(invalid.isError,true);await noCopies(cwd);
 }finally{await run(['close',file],undefined,true);await rm(cwd,{recursive:true,force:true});}
});
test('real OfficeCLI: native Excel invalidates a dependent cache on edit; read-only checks do not repair the saved source; cleanup waits for operations',async()=>{
 const {cwd,run,call,context}=await fixture(),file=join(cwd,'test.xlsx');
 try{
  await run(['create',file]);await run(['set',file,'/Sheet1/A1','--prop','value=2']);await run(['set',file,'/Sheet1/B1','--prop','formula=A1*3']);
  await run(['get',file,'/','--depth','3','--json']);await run(['close',file],undefined,true);
  await run(['set',file,'/Sheet1/A1','--prop','value=4']);await run(['close',file],undefined,true);
  const bytes=await readFile(file),sha=hash(bytes),parts=readOfficeParts(bytes,'xl/workbook.xml'),xml=parts.get('xl/worksheets/sheet1.xml');
  const cell=xml.match(/<[^<> ]*:c\b[^>]*r="B1"[^>]*>[\s\S]*?<\/[^<> ]*:c>/)?.[0];
  assert.ok(cell);assert.doesNotMatch(cell,/<(?:\w+:)?v[ >]/);console.log('native saved B1 cache absent after input edit');
  const result=await call('OfficeExcelCheck',{path:file});assert.equal(result.cleanup_complete,true);assert.equal(result.formula_check.cached_values_current,false);assert.ok(result.formula_check.missing_cache_cells.length);assert.equal(hash(await readFile(file)),sha);await noCopies(cwd);
  const copies=[];const read=()=>withFiles([file],context,()=>withWorkingFile(file,run,context,async work=>{
   const {copyFile}=await import('node:fs/promises');await copyFile(file,work);copies.push(work);
   assert.ok((await readdir(cwd)).some(n=>n.endsWith('.office-work.lock')));
   await run(['get',work,'/','--json']);return {sha256:sha};
  }));
  const results=await Promise.all([read(),read()]);assert.ok(results.every(r=>r.cleanup_complete));assert.equal(copies.length,2);await noCopies(cwd);assert.equal(hash(await readFile(file)),sha);
 }finally{await run(['close',file],undefined,true);await rm(cwd,{recursive:true,force:true});}
});
