import {test} from 'node:test';
import assert from 'node:assert/strict';
import {registerTools} from '../tools/index.mjs';
import {previewPage} from '../tools/preview.mjs';
import {mkdtemp,readFile,writeFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {hash} from '../tools/engine.mjs';
import {readVisualReview,recordVisualReview} from '../tools/visual-review.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=','base64');
async function fixture(operation) {
  const cwd=await mkdtemp(join(tmpdir(),'office-preview-test-')),source=join(cwd,'source.pptx');
  const context={cwd,plugin:{dataDir:join(cwd,'data')},signal:new AbortController().signal,deadline:Date.now()+30000};
  await writeFile(source,'unchanged original');
  const calls=[];
  const run=async args=>{
    calls.push(args);
    if(args[0]==='get') return JSON.stringify({success:true,data:{results:[{childCount:2}]}});
    if(args[0]==='view') await writeFile(args.at(-1),png);
    return '';
  };
  try {await operation({cwd,source,context,calls,run});} finally {await rm(cwd,{recursive:true,force:true});}
}

test('single-page preview is exposed as an explicit tool',()=>{
  const tool=registerTools().find(tool=>tool.name==='OfficePptPreview');
  assert.ok(tool);
  assert.deepEqual(tool.inputSchema.required,['path','page']);
  assert.equal(tool.inputSchema.properties.page.type,'integer');
});

test('visual findings can be recorded against preview evidence and a file version',()=>{
  const tool=registerTools().find(tool=>tool.name==='OfficePptReview');
  assert.ok(tool);
  assert.deepEqual(tool.inputSchema.required,['path','expected_sha256','pages']);
});

test('preview targets one page and preserves the source and image after work-copy cleanup',async()=>fixture(async({cwd,source,context,calls,run})=>{
  const result=await previewPage(source,2,run,context);
  assert.equal(result.sha256,hash('unchanged original'));
  assert.equal(result.visual_checked,false);
  assert.equal(result.page,2);assert.equal(result.page_count,2);
  assert.equal(result.cleanup_complete,true);
  assert.deepEqual(await readFile(result.image_path),png);
  assert.equal(await readFile(source,'utf8'),'unchanged original');
  assert.deepEqual(calls.find(args=>args[0]==='view').slice(2,11),['screenshot','--page','2','--render','html','--screenshot-width','1280','--screenshot-height','720']);
  assert.equal((await readdir(cwd)).some(name=>name.startsWith('.office-work-')||name.endsWith('.office-work.lock')),false);
}));
test('invalid pages and page overflow never publish a preview',async()=>fixture(async({source,context,calls,run,cwd})=>{
  for(const page of [0,1.5,'2',201]) await assert.rejects(previewPage(source,page,run,context),/单个页码/);
  assert.equal(calls.length,0);
  await assert.rejects(previewPage(source,3,run,context),/超出实际页数/);
  assert.equal(calls.some(args=>args[0]==='view'),false);
  assert.equal((await readdir(cwd)).includes('data'),false);
}));
test('rendering failure remains an error and cleans only its own working copy',async()=>fixture(async({source,context,cwd,run})=>{
  const failing=async args=>{if(args[0]==='view')throw new Error('browser unavailable');return run(args);};
  await assert.rejects(previewPage(source,2,failing,context),/browser unavailable/);
  assert.deepEqual(await readdir(cwd),['source.pptx']);
}));
test('a source changed during rendering is not reported as current visual evidence',async()=>fixture(async({source,context,run,cwd})=>{
  const changing=async args=>{const result=await run(args);if(args[0]==='view')await writeFile(source,'external edit');return result;};
  await assert.rejects(previewPage(source,2,changing,context),/源文件已变化/);
  assert.equal((await readdir(cwd)).includes('data'),false);
}));

test('findings persist with the file version, exact pages and preview evidence',async()=>fixture(async({source,context,run})=>{
  const first=await previewPage(source,1,run,context);
  assert.equal(await readVisualReview(source,first.sha256,context),undefined,'a screenshot is not a visual review');
  const item=(preview,conclusion,findings)=>({preview_id:preview.preview_id,conclusion,findings});
  const tool=registerTools().find(tool=>tool.name==='OfficePptReview');
  const reply=await tool.invoke({path:source,expected_sha256:first.sha256,pages:[item(first,'passed','标题与正文清晰，无明显重叠。')]},{...context,permissions:{filesystem:['read','write'],process:['officecli']}});
  assert.notEqual(reply.isError,true,JSON.stringify(reply));
  const saved=JSON.parse(reply.content[0].text);
  assert.equal(saved.visual_review.sha256,first.sha256);
  assert.deepEqual(saved.visual_review.checked_pages,[1]);
  assert.equal(saved.visual_review.scope,'checked_pages_only');
  assert.equal(saved.visual_review.review_source,'model_reported');
  assert.equal(saved.visual_review.pages[0].image_sha256,first.image_sha256);
  assert.equal(saved.visual_review.pages[0].findings,'标题与正文清晰，无明显重叠。');
  assert.deepEqual(JSON.parse(await readFile(saved.record_path,'utf8')),saved.visual_review);
  const second=await previewPage(source,2,run,context);
  const merged=await recordVisualReview(source,{expected_sha256:first.sha256,pages:[item(second,'issues','表格第二列文字拥挤。')]},context);
  assert.deepEqual(merged.visual_review.checked_pages,[1,2]);
  assert.equal(merged.visual_review.conclusion,'issues');
  const rechecked=await recordVisualReview(source,{expected_sha256:first.sha256,pages:[item(second,'passed','重新查看，文字可读，无明显裁切。')]},context);
  assert.equal(rechecked.visual_review.conclusion,'passed_for_checked_pages');
  assert.equal(rechecked.visual_review.pages[1].findings,'重新查看，文字可读，无明显裁切。');
  await writeFile(source,'new version');
  assert.equal(await readVisualReview(source,hash('new version'),context),undefined);
  await assert.rejects(recordVisualReview(source,{expected_sha256:first.sha256,pages:[item(first,'passed','旧结论')]},context),/版本已变化/);
  assert.deepEqual((await readVisualReview(source,first.sha256,context)).checked_pages,[1,2],'old-version history is retained');
}));

test('review rejects missing screenshots, cross-file evidence and modified images',async()=>fixture(async({cwd,source,context,run})=>{
  const preview=await previewPage(source,2,run,context);
  const pages=[{preview_id:preview.preview_id,conclusion:'issues',findings:'正文存在裁切。'}];
  await assert.rejects(recordVisualReview(source,{expected_sha256:preview.sha256,pages:[{...pages[0],preview_id:'00000000-0000-0000-0000-000000000000'}]},context),/截图记录/);
  await assert.rejects(recordVisualReview(source,{expected_sha256:preview.sha256,pages:[{...pages[0],findings:' '}]},context),/非空/);
  await assert.rejects(recordVisualReview(source,{expected_sha256:preview.sha256,pages:[...pages,...pages]},context),/重复/);
  const other=join(cwd,'other.pptx');await writeFile(other,'unchanged original');
  await assert.rejects(recordVisualReview(other,{expected_sha256:preview.sha256,pages},context),/不属于当前文件版本/);
  await writeFile(preview.image_path,'changed screenshot');
  await assert.rejects(recordVisualReview(source,{expected_sha256:preview.sha256,pages},context),/截图内容已变化/);
  assert.equal(await readVisualReview(source,preview.sha256,context),undefined);
}));
