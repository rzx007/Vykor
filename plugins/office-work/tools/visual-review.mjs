import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {hash} from './engine.mjs';
import {assertFileAvailable,withFiles} from './file-access.mjs';

const reviewPath=(source,sha256,context)=>join(context.plugin.dataDir,'visual-reviews',`${hash(source.toLowerCase())}-${sha256}.json`);
export async function readVisualReview(source,sha256,context) {
  try {
    const record=JSON.parse(await readFile(reviewPath(source,sha256,context),'utf8'));
    return record.path===source&&record.sha256===sha256?record:undefined;
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
    for(const item of input.pages) {
      if(!item||Object.keys(item).some(key=>!['preview_id','conclusion','findings'].includes(key))||
        !/^[a-f0-9-]{36}$/.test(item.preview_id??'')||!['passed','issues'].includes(item.conclusion)||
        typeof item.findings!=='string'||!item.findings.trim()||item.findings.length>12000) throw new Error('每页须提供截图编号、passed/issues 结论及非空的具体发现。');
      let preview;
      try {preview=JSON.parse(await readFile(join(context.plugin.dataDir,'previews',`${item.preview_id}.json`),'utf8'));}
      catch {throw new Error('找不到有效截图记录，请重新生成该页截图。');}
      if(preview.preview_id!==item.preview_id||preview.path!==source||preview.sha256!==sha256||preview.renderer!=='officecli-html'||
        !Number.isSafeInteger(preview.page)||preview.page<1||!Number.isSafeInteger(preview.page_count)||preview.page>preview.page_count) throw new Error('截图不属于当前文件版本，不能保存检查结论。');
      const imagePath=join(context.plugin.dataDir,'previews',`${sha256}-page-${preview.page}-${item.preview_id}.png`);
      if(hash(await readFile(imagePath))!==preview.image_sha256) throw new Error('截图内容已变化，请重新截图检查。');
      if(checked.has(preview.page)) throw new Error('同一页不能重复提交检查结论。');
      if(pageCount!==undefined&&pageCount!==preview.page_count) throw new Error('截图页数记录不一致，请重新截图。');
      pageCount=preview.page_count;
      checked.set(preview.page,{page:preview.page,preview_id:item.preview_id,image_sha256:preview.image_sha256,conclusion:item.conclusion,findings:item.findings.trim(),checked_at:new Date().toISOString()});
    }
    // Keep prior pages only for this exact file/version. Rechecking a page
    // replaces that page's findings, without claiming any unlisted page.
    const previous=await readVisualReview(source,sha256,context);
    const pages=new Map((previous?.pages??[]).map(page=>[page.page,page]));
    for(const [page,finding] of checked) pages.set(page,finding);
    const ordered=[...pages.values()].sort((a,b)=>a.page-b.page);
    const record={path:source,sha256,page_count:pageCount,renderer:'officecli-html',review_source:'model_reported',scope:'checked_pages_only',checked_pages:ordered.map(page=>page.page),pages:ordered,conclusion:ordered.some(page=>page.conclusion==='issues')?'issues':'passed_for_checked_pages',updated_at:new Date().toISOString()};
    await current();
    if(context.signal.aborted||Date.now()>=context.deadline-1000) throw new Error('保存检查记录已取消或到期。');
    const path=reviewPath(source,sha256,context);
    await mkdir(join(context.plugin.dataDir,'visual-reviews'),{recursive:true});
    await writeFile(path,JSON.stringify(record));
    return {recorded:true,record_path:path,visual_review:record};
  });
}
