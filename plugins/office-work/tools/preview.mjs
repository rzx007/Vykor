import {copyFile,mkdir,readFile,stat,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {hash} from './engine.mjs';
import {assertFileAvailable,withFiles} from './file-access.mjs';
import {withWorkingFile} from './working-file.mjs';

export async function previewPage(source,page,run,context) {
  if(!Number.isSafeInteger(page)||page<1||page>200) throw new Error('截图须指定 1–200 的单个页码。');
  return withFiles([source],context,async()=>{
    await assertFileAvailable(source);
    const before=hash(await readFile(source));
    return withWorkingFile(source,run,context,async(work,close)=>{
      await copyFile(source,work);
      const document=JSON.parse(await run(['get',work,'/','--json']));
      const pageCount=document.data?.results?.[0]?.childCount;
      if(document.success===false||!Number.isSafeInteger(pageCount)||pageCount<page) throw new Error('截图页码超出实际页数，未生成预览。');
      const output=join(dirname(work),'preview.png');
      // Use HTML explicitly: never start PowerPoint or silently switch renderers.
      await run(['view',work,'screenshot','--page',String(page),'--render','html','--screenshot-width','1280','--screenshot-height','720','-o',output]);
      await close();
      const size=(await stat(output)).size;
      if(size>8*1024*1024) throw new Error('截图超过 8 MB，未返回图片。');
      const bytes=await readFile(output);
      if(bytes.length<24||!bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))) throw new Error('OfficeCLI 未生成有效 PNG 截图。');
      if(hash(await readFile(source))!==before) throw new Error('截图期间源文件已变化，请重新读取后预览。');
      if(context.signal.aborted||Date.now()>=context.deadline-1000) throw new Error('截图操作取消或已到期限。');
      const directory=join(context.plugin.dataDir,'previews');
      await mkdir(directory,{recursive:true});
      // Keep the returned image outside the disposable working copy, immutable
      // for conversation replay; callers cannot choose an overwrite target.
      const previewId=randomUUID();
      const imagePath=join(directory,`${before}-page-${page}-${previewId}.png`);
      await writeFile(imagePath,bytes,{flag:'wx'});
      const result={path:source,sha256:before,page,page_count:pageCount,preview_id:previewId,image_sha256:hash(bytes),renderer:'officecli-html',image_path:imagePath,image_bytes:bytes.length,rendered:true,visual_checked:false,source_unchanged:true};
      await writeFile(join(directory,`${previewId}.json`),JSON.stringify(result),{flag:'wx'});
      return result;
    });
  });
}
