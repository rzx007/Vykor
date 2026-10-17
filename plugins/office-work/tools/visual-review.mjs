import {mkdir,readFile,writeFile,rename,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {join,extname} from 'node:path';
import {hash} from './engine.mjs';
import {assertFileAvailable,withFiles} from './file-access.mjs';

const reviewPath=(source,sha256,context)=>join(context.plugin.dataDir,'visual-reviews',`${hash(source.toLowerCase())}-${sha256}.json`);
const wordProtocol='word-page-checks-v1';
export function wordPageChecks(checks,expected) {
  const names=['body','header','footer','pagination'];
  if(!checks||typeof checks!=='object'||Array.isArray(checks)||Object.keys(checks).length!==4||Object.keys(checks).some(k=>!names.includes(k)))throw new Error('Word 每页须分别提交 body、header、footer、pagination 的状态和实际观察。');
  const saved={};
  for(const name of names) {
    const item=checks[name];
    if(!item||Object.keys(item).some(k=>!['status','observation'].includes(k))||!['passed','issues','not_applicable','uncertain'].includes(item.status)||typeof item.observation!=='string'||!item.observation.trim()||item.observation.length>3000)throw new Error('每项检查须提供状态和非空 observation；发现异常填 issues，未看清填 uncertain。');
    if(item.status==='not_applicable'&&(!['header','footer'].includes(name)||expected?.[name]!==false))throw new Error('正文和分页不能跳过；文档有页眉页脚或其范围不确定时不能填 not_applicable。');
    if(['header','footer'].includes(name)&&item.status==='passed'&&expected?.[name]===false)throw new Error('文档未设置该页眉页脚，请记录 not_applicable，不要声称已显示。');
    saved[name]={status:item.status,observation:item.observation.trim()};
  }
  return {checks:saved,conclusion:Object.values(saved).some(v=>['issues','uncertain'].includes(v.status))?'issues':'passed',findings:names.map(n=>`${n} [${saved[n].status}]: ${saved[n].observation}`).join('\n')};
}
export async function readVisualReview(source,sha256,context) {
  try {
    const path=reviewPath(source,sha256,context);
    let bytes;
    try {bytes=await readFile(path+'.latest','utf8');}
    catch(error) {if(error.code!=='ENOENT')throw error;bytes=await readFile(path,'utf8');}
    const record=JSON.parse(bytes);
    return record.path===source&&record.sha256===sha256&&(extname(source).toLowerCase()!=='.docx'||record.review_protocol===wordProtocol)?record:undefined;
  } catch(error) {if(error.code==='ENOENT') return undefined;throw error;}
}

export async function recordVisualReview(source,input,context) {
  const sha256=input.expected_sha256;
  if(!/^[a-f0-9]{64}$/.test(sha256??'')) throw new Error('请传入截图返回的 expected_sha256。');
  if(!Array.isArray(input.pages)||!input.pages.length||input.pages.length>200) throw new Error('请提供 1–200 项实际看图后的逐页结论。');
  return withFiles([source],context,async()=>{
    await assertFileAvailable(source);
    const current=async()=>{if(hash(await readFile(source))!==sha256)throw new Error('文件版本已变化，不能把旧截图结论用于当前文件；请重新截图检查。');};
    await current();
    const checked=new Map();let pageCount;
    const word=extname(source).toLowerCase()==='.docx';
    for(const item of input.pages) {
      if(!item||Object.keys(item).some(key=>!(word?['preview_id','checks']:['preview_id','conclusion','findings']).includes(key))||
        !/^[a-f0-9-]{36}$/.test(item.preview_id??'')||(!word&&(!['passed','issues'].includes(item.conclusion)||typeof item.findings!=='string'||!item.findings.trim()||item.findings.length>12000))) throw new Error(word?'Word 每页须提供 preview_id 和四项 checks；由工具汇总结论，不能直接提交 passed。':'每页须提供截图编号、passed/issues 结论及非空的具体发现。');
      let preview;
      try {preview=JSON.parse(await readFile(join(context.plugin.dataDir,'previews',`${item.preview_id}.json`),'utf8'));}
      catch {throw new Error('找不到有效截图记录，请重新生成该页截图。');}
      if(preview.preview_id!==item.preview_id||preview.path!==source||preview.sha256!==sha256||preview.renderer!=='officecli-html'||
        !Number.isSafeInteger(preview.page)||preview.page<1||preview.page>200||
        (word?(preview.document_kind!=='word'||preview.page_number_basis!=='officecli-html'||!['word-paginated-strip-v2','word-grid-page-v3'].includes(preview.capture_method)||!preview.expected_elements):(!Number.isSafeInteger(preview.page_count)||preview.page>preview.page_count))) throw new Error('截图不属于当前文件版本或仍为旧版分页截图，请重新生成后检查。');
      const imagePath=join(context.plugin.dataDir,'previews',`${sha256}-page-${preview.page}-${item.preview_id}.png`);
      if(hash(await readFile(imagePath))!==preview.image_sha256) throw new Error('截图内容已变化，请重新截图检查。');
      if(checked.has(preview.page)) throw new Error('同一页不能重复提交检查结论。');
      if(pageCount!==undefined&&pageCount!==preview.page_count) throw new Error('截图页数记录不一致，请重新截图。');
      pageCount=preview.page_count;
      const findings=word?wordPageChecks(item.checks,preview.expected_elements):{conclusion:item.conclusion,findings:item.findings.trim()};
      checked.set(preview.page,{page:preview.page,preview_id:item.preview_id,image_sha256:preview.image_sha256,...findings,checked_at:new Date().toISOString()});
    }
    // Keep prior pages only for this exact file/version. Rechecking a page
    // replaces that page's findings, without claiming any unlisted page.
    const previous=await readVisualReview(source,sha256,context);
    const pages=new Map((previous?.pages??[]).map(page=>[page.page,page]));
    for(const [page,finding] of checked) pages.set(page,finding);
    const ordered=[...pages.values()].sort((a,b)=>a.page-b.page);
    const record={path:source,sha256,page_count:pageCount,...(word?{document_kind:'word',page_number_basis:'officecli-html',review_protocol:wordProtocol}:{}),renderer:'officecli-html',review_source:'model_reported',scope:'checked_pages_only',checked_pages:ordered.map(page=>page.page),pages:ordered,conclusion:ordered.some(page=>page.conclusion==='issues')?'issues':'passed_for_checked_pages',updated_at:new Date().toISOString()};
    await current();
    if(context.signal.aborted||Date.now()>=context.deadline-1000) throw new Error('保存检查记录已取消或到期。');
    const path=reviewPath(source,sha256,context);
    await mkdir(join(context.plugin.dataDir,'visual-reviews'),{recursive:true});
    // Immutable snapshots are the returned evidence. Only the latest lookup is
    // replaced; existing version-keyed files (including legacy records) stay intact.
    const snapshot=path.replace(/\.json$/,`-${randomUUID()}.json`),temporary=snapshot+'.tmp';
    const bytes=JSON.stringify(record);
    await writeFile(snapshot,bytes,{flag:'wx'});
    try {
      await writeFile(temporary,bytes,{flag:'wx'});
      await rename(temporary,path+'.latest');
    } finally {await rm(temporary,{force:true});}
    return {recorded:true,record_path:snapshot,visual_review:record};
  });
}
