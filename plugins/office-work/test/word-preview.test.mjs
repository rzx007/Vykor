import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inflateSync,deflateSync} from 'node:zlib';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {extractWordPage} from '../tools/word-page-image.mjs';
import {wordPageChecks,recordVisualReview,readVisualReview} from '../tools/visual-review.mjs';
import {previewPage} from '../tools/preview.mjs';
import {hash} from '../tools/engine.mjs';

const crc=b=>{let n=0xffffffff;for(const v of b){n^=v;for(let i=0;i<8;i++)n=n>>>1^(n&1?0xedb88320:0);}return (n^0xffffffff)>>>0;};
function chunk(name,data){const b=Buffer.alloc(data.length+12);b.writeUInt32BE(data.length);b.write(name,4);data.copy(b,8);b.writeUInt32BE(crc(b.subarray(4,-4)),b.length-4);return b;}
const paeth=(a,b,c)=>{const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);return pa<=pb&&pa<=pc?a:pb<=pc?b:c;};
function png(width=850,height=2365,boxes=[{left:28,top:20,width:794,height:1123},{left:28,top:1183,width:794,height:1123}]) {
 const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
 const raw=Buffer.alloc(height*(width*3+1));let previous=Buffer.alloc(width*3);
 for(let y=0;y<height;y++) {
  const row=Buffer.alloc(width*3,240),filter=y%5,offset=y*(width*3+1);raw[offset]=filter;
  for(const b of boxes)if(y>=b.top&&y<b.top+b.height)for(let x=b.left;x<Math.min(width,b.left+b.width);x++){
   row.fill(255,x*3,x*3+3);
   if(y-b.top>40&&y-b.top<b.height-10&&x-b.left>50&&x-b.left<b.width-10){row[x*3]=y%251;row[x*3+1]=x%251;row[x*3+2]=37;}
  }
  for(let i=0;i<row.length;i++){const a=i>=3?row[i-3]:0,b=previous[i],c=i>=3?previous[i-3]:0;const p=filter===0?0:filter===1?a:filter===2?b:filter===3?Math.floor((a+b)/2):paeth(a,b,c);raw[offset+i+1]=(row[i]-p)&255;}
  previous=row;
 }
 return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}
function pixels(bytes){let offset=8;const idat=[];while(offset<bytes.length){const n=bytes.readUInt32BE(offset);if(bytes.toString('ascii',offset+4,offset+8)==='IDAT')idat.push(bytes.subarray(offset+8,offset+8+n));offset+=12+n;}return inflateSync(Buffer.concat(idat));}
const strip=png();
const checks=()=>({body:{status:'passed',observation:'正文末行位于页脚上方，无截断。'},header:{status:'passed',observation:'本页右上方实际可见页眉。'},footer:{status:'passed',observation:'页脚位于底部。'},pagination:{status:'passed',observation:'本页起止内容与相邻页连续。'}});

test('Word grid extraction preserves selected page pixels for every PNG filter',()=>{
 const before=hash(strip);
 for(const [page,top]of [[1,20],[2,1183]]) {
  const r=extractWordPage(strip,page),data=pixels(r.bytes);
  assert.equal(r.rendered_pages,2);assert.equal(r.bytes.readUInt32BE(16),794);assert.equal(r.bytes.readUInt32BE(20),1123);
  const at=100*(794*3+1)+1+100*3;assert.deepEqual([...data.subarray(at,at+3)],[(top+100)%251,128,37]);
 }
 assert.equal(hash(strip),before);assert.throws(()=>extractWordPage(strip,3),/超出/);
});
test('Word extraction accepts single pages and scaled multi-column grids',()=>{
 for(const [width,height,boxes]of [[794,1123,[{left:0,top:0,width:794,height:1123}]],[700,980,[{left:12,top:12,width:320,height:453},{left:350,top:12,width:320,height:453},{left:190,top:490,width:320,height:453}]]]) {
  const r=extractWordPage(png(width,height,boxes),boxes.length);assert.equal(r.rendered_pages,boxes.length);assert.equal(r.bytes.readUInt32BE(16),boxes[0].width);
 }
});
test('Word grid extraction rejects partial pages, absent pages and corrupt PNGs',()=>{
 assert.throws(()=>extractWordPage(png(850,720),1),/不受支持/);
 assert.throws(()=>extractWordPage(png(850,1200,[]),1),/不受支持/);
 const broken=Buffer.from(strip);broken[40]^=1;assert.throws(()=>extractWordPage(broken,1));
});
test('Word review derives non-passing conclusions from issues and uncertainty',()=>{
  assert.equal(wordPageChecks(checks(),{header:true,footer:true}).conclusion,'passed');
  for(const status of ['issues','uncertain']){const c=checks();c.header={status,observation:'该页未显示页眉或无法看清。'};assert.equal(wordPageChecks(c,{header:true,footer:true}).conclusion,'issues');}
  const skipped=checks();skipped.header.status='not_applicable';assert.throws(()=>wordPageChecks(skipped,{header:true,footer:true}),/不能填/);
  assert.throws(()=>wordPageChecks({body:checks().body},{header:true,footer:true}),/分别提交/);
});
test('Word preview uses the official paginated grid and saves only the selected page',async()=>{
  const cwd=await mkdtemp(join(tmpdir(),'word-paginated-')),source=join(cwd,'source.docx'),calls=[];
  const context={cwd,plugin:{dataDir:join(cwd,'data')},signal:new AbortController().signal,deadline:Date.now()+30000};
  await writeFile(source,'source');
  const run=async args=>{calls.push(args);if(args[0]==='get')return JSON.stringify({success:true,data:{results:[{format:{pageWidth:'21cm',pageHeight:'29.7cm',headerRef:'/header[1]',footerRef:'/footer[1]'}}]}});if(args[0]==='view')await writeFile(args.at(-1),strip);return '';};
  try {
    const result=await previewPage(source,2,run,context);
    assert.equal(calls.find(c=>c[0]==='view')[4],'2');assert.equal(result.capture_method,'word-grid-page-v3');
    assert.equal(calls.find(c=>c[0]==='view')[8],'1280');assert.equal(calls.find(c=>c[0]==='view')[10],'1200');
    assert.deepEqual(result.expected_elements,{header:true,footer:true});assert.equal(result.page,2);assert.equal(result.page_count,undefined);
    assert.deepEqual(await readFile(result.image_path),extractWordPage(strip,2).bytes);assert.equal(result.cleanup_complete,true);assert.equal(await readFile(source,'utf8'),'source');
  }finally{await rm(cwd,{recursive:true,force:true});}
});
test('Word records require new evidence, ignore legacy approvals and preserve their files',async()=>{
  const cwd=await mkdtemp(join(tmpdir(),'word-review-')),source=join(cwd,'source.docx'),context={plugin:{dataDir:join(cwd,'data')},signal:new AbortController().signal,deadline:Date.now()+30000};
  const sha=hash('source'),id=randomUUID(),dir=join(context.plugin.dataDir,'previews'),path=join(dir,`${sha}-page-1-${id}.png`);
  const receipt={path:source,sha256:sha,preview_id:id,page:1,image_sha256:hash(strip),renderer:'officecli-html',document_kind:'word',page_number_basis:'officecli-html',capture_method:'word-grid-page-v3',expected_elements:{header:true,footer:true}};
  const record=join(context.plugin.dataDir,'visual-reviews',`${hash(source.toLowerCase())}-${sha}.json`);
  try {
    await writeFile(source,'source');await mkdir(dir,{recursive:true});await writeFile(path,strip);await writeFile(join(dir,id+'.json'),JSON.stringify(receipt));
    await mkdir(join(context.plugin.dataDir,'visual-reviews'),{recursive:true});const legacy=JSON.stringify({path:source,sha256:sha,checked_pages:[1],pages:[],conclusion:'passed_for_checked_pages'});await writeFile(record,legacy);
    assert.equal(await readVisualReview(source,sha,context),undefined);assert.equal(await readFile(record,'utf8'),legacy);
    const call=pages=>recordVisualReview(source,{expected_sha256:sha,pages},context);
    await assert.rejects(()=>call([{preview_id:id,conclusion:'passed',findings:'页眉缺失。'}]),/四项/);
    const c=checks();c.body={status:'issues',observation:'正文越过页脚区域，不能通过。'};
    const saved=await call([{preview_id:id,checks:c}]);assert.equal(saved.visual_review.conclusion,'issues');assert.equal(saved.visual_review.review_protocol,'word-page-checks-v1');
    assert.equal(saved.visual_review.pages[0].checks.body.status,'issues');assert.equal((await readVisualReview(source,sha,context)).sha256,sha);
    const original=await readFile(saved.record_path,'utf8');
    const rechecked=await call([{preview_id:id,checks:checks()}]);
    assert.notEqual(rechecked.record_path,saved.record_path);
    assert.equal(await readFile(saved.record_path,'utf8'),original);
    assert.equal(await readFile(record,'utf8'),legacy);
    assert.equal((await readVisualReview(source,sha,context)).conclusion,'passed_for_checked_pages');
    delete receipt.capture_method;await writeFile(join(dir,id+'.json'),JSON.stringify(receipt));
    await assert.rejects(()=>call([{preview_id:id,checks:checks()}]),/旧版分页截图/);
  }finally{await rm(cwd,{recursive:true,force:true});}
});
