import {copyFile,mkdir,readFile,stat,writeFile} from 'node:fs/promises';
import {dirname,join,extname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {hash} from './engine.mjs';
import {assertFileAvailable,withFiles} from './file-access.mjs';
import {withWorkingFile} from './working-file.mjs';
import {extractWordPage} from './word-page-image.mjs';

export async function previewPage(source,page,run,context) {
  if(!Number.isSafeInteger(page)||page<1||page>200) throw new Error('截图须指定 1–200 的单个页码。');
  return withFiles([source],context,async()=>{
    await assertFileAvailable(source);
    const before=hash(await readFile(source));
    return withWorkingFile(source,run,context,async(work,close)=>{
      await copyFile(source,work);
      const word=extname(source).toLowerCase()==='.docx';
      const document=JSON.parse(await run(['get',work,word?'/body/sectPr[1]':'/','--json']));
      const info=document.data?.results?.[0],pageCount=word?undefined:info?.childCount;
      if(document.success===false||(!word&&(!Number.isSafeInteger(pageCount)||pageCount<page))) throw new Error('截图页码超出实际页数，未生成预览。');
      if(word&&(Math.abs(parseFloat(info?.format?.pageWidth)-21)>0.02||Math.abs(parseFloat(info?.format?.pageHeight)-29.7)>0.02||!info?.format?.pageWidth||!info?.format?.pageHeight))throw new Error('Word 截图当前仅支持统一 A4 纵向报告。');
      const output=join(dirname(work),'preview.png');
      // The official grid path paginates and clones inherited headers/footers
      // before composing complete page boxes. Crop the requested page locally.
      await run(['view',work,'screenshot',...(word?['--grid','2']:['--page',String(page)]),'--render','html','--screenshot-width','1280','--screenshot-height',word?'1200':'720','-o',output]);
      await close();
      const size=(await stat(output)).size;
      if(size>8*1024*1024) throw new Error('截图超过 8 MB，未返回图片。');
      let bytes=await readFile(output),wordCapture;
      if(word){wordCapture=extractWordPage(bytes,page);bytes=wordCapture.bytes;}
      if(bytes.length<24||!bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))) throw new Error('OfficeCLI 未生成有效 PNG 截图。');
      // A selected A4 HTML page may be scaled by the CLI image-size limit.
      // Missing pages leave a viewport-sized screenshot: do not save that as evidence.
      if(word&&(bytes.readUInt32BE(16)<100||Math.abs(bytes.readUInt32BE(16)/bytes.readUInt32BE(20)-794/1123)>0.005))throw new Error('未得到有效的 A4 单页截图，页码可能超出范围；未保存检查证据。');
      if(hash(await readFile(source))!==before) throw new Error('截图期间源文件已变化，请重新读取后预览。');
      if(context.signal.aborted||Date.now()>=context.deadline-1000) throw new Error('截图操作取消或已到期限。');
      const directory=join(context.plugin.dataDir,'previews');
      await mkdir(directory,{recursive:true});
      // Keep the returned image outside the disposable working copy, immutable
      // for conversation replay; callers cannot choose an overwrite target.
      const previewId=randomUUID();
      const imagePath=join(directory,`${before}-page-${page}-${previewId}.png`);
      await writeFile(imagePath,bytes,{flag:'wx'});
      const expected=key=>{const f=info?.format??{};return f.titlePage||f[`${key}Ref.first`]||f[`${key}Ref.even`]?null:Boolean(f[`${key}Ref.default`]??f[`${key}Ref`]);};
      const result={path:source,sha256:before,page,page_count:pageCount,...(word?{document_kind:'word',page_number_basis:'officecli-html',capture_method:'word-grid-page-v3',rendered_pages:wordCapture.rendered_pages,expected_elements:{header:expected('header'),footer:expected('footer')}}:{}),preview_id:previewId,image_sha256:hash(bytes),renderer:'officecli-html',image_path:imagePath,image_bytes:bytes.length,rendered:true,visual_checked:false,source_unchanged:true};
      await writeFile(join(directory,`${previewId}.json`),JSON.stringify(result),{flag:'wx'});
      return result;
    });
  });
}
