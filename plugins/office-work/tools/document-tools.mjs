import {readFile,copyFile} from 'node:fs/promises';
import {engine,hash} from './engine.mjs';
import {filePath,currentReceipt} from './document-files.mjs';
import {withFiles,assertFileAvailable,operationError} from './file-access.mjs';
import {withWorkingFile} from './working-file.mjs';
import {previewPage} from './preview.mjs';
import {recordVisualReview,readVisualReview} from './visual-review.mjs';
import {previewExcel,recordExcelReview,excelVisualReview} from './excel-visual.mjs';
import {formulaReport} from './excel-content.mjs';
import {readOfficeParts} from './office-package.mjs';
import {workbookSupport} from './excel-preservation.mjs';

const string={type:'string'},status={type:'object',additionalProperties:false,required:['status','observation'],properties:{status:{type:'string',enum:['passed','issues','not_applicable','uncertain']},observation:{type:'string',minLength:1,maxLength:3000}}};
const wordChecks={type:'object',additionalProperties:false,required:['body','header','footer','pagination'],properties:Object.fromEntries(['body','header','footer','pagination'].map(k=>[k,status]))};
const findings={preview_id:string,conclusion:{type:'string',enum:['passed','issues']},findings:{type:'string',minLength:1,maxLength:6000}};
const formats={Word:'.docx',Ppt:'.pptx',Excel:'.xlsx'};
async function execute(format,kind,input,context) {
  if(!context.permissions.filesystem?.includes('read')||kind!=='Check'&&!context.permissions.filesystem?.includes('write')||!context.permissions.process?.includes('officecli'))throw new Error('插件缺少文件或 OfficeCLI 权限。');
  const source=await filePath(context,input.path,false,formats[format]);
  if(kind==='Review')return format==='Excel'?recordExcelReview(source,input,context):recordVisualReview(source,input,context);
  if(kind==='Preview')return format==='Excel'?previewExcel(source,input,context):previewPage(source,input.page,await engine(context),context);
  return withFiles([source],context,async()=>{
    await assertFileAvailable(source);
    const bytes=await readFile(source),sha=hash(bytes),run=await engine({...context,maxOutputBytes:2000000});
    return withWorkingFile(source,run,context,async work=>{
      await copyFile(source,work);
      const validation=JSON.parse(await run(['validate',work,'--json']));
      if(validation.success!==true)throw new Error('Office 文档结构检查失败。');
      const document=JSON.parse(await run(['get',work,format==='Word'?'/body':'/','--depth',format==='Excel'?'3':'1','--json']));
      if(document.success!==true)throw new Error('检查回读失败。');
      let extra={};
      if(format==='Excel') {
        const parts=readOfficeParts(bytes,'xl/workbook.xml');
        let capabilities;try{capabilities={editable:true,...workbookSupport(parts)};}catch(e){capabilities={editable:false,reason:e.message};}
        extra={formula_check:formulaReport(document.data.results[0]),workbook_capabilities:capabilities,issues:JSON.parse(await run(['view',work,'issues','--json']))};
      }
      const visual=format==='Excel'?await excelVisualReview(source,sha,context):await readVisualReview(source,sha,context);
      const record=await currentReceipt(context,source,sha);
      if(hash(await readFile(source))!==sha)throw new Error('检查期间文件已变化，请重新读取。');
      return {path:source,sha256:sha,document,validation,...extra,structure_checked:true,visual_checked:false,...(visual?{visual_review:visual}:{}),...Object.fromEntries(['change_check','page_diff','preservation','page_settings','image_sources'].filter(k=>record?.[k]!==undefined).map(k=>[k,record[k]]))};
    });
  });
}
export function registerDocumentTools() {
  return Object.keys(formats).flatMap(format=>['Check','Preview','Review'].map(kind=>{
    const entries=format==='Word'?{preview_id:string,checks:wordChecks}:findings;
    const list={type:'array',minItems:1,maxItems:format==='Excel'?30:200,items:{type:'object',additionalProperties:false,required:format==='Word'?['preview_id','checks']:['preview_id','conclusion','findings'],properties:entries}};
    const properties=kind==='Check'?{path:string}:kind==='Preview'?{path:string,...(format==='Excel'?{sheet:string,range:string}:{page:{type:'integer',minimum:1,maximum:200}})}:{path:string,expected_sha256:string,[format==='Excel'?'regions':'pages']:list};
    return {name:'Office'+format+kind,description:kind==='Check'?'检查文档结构与当前文件版本的交付、修改范围及看图记录；不修改源文件，结构通过不等于视觉通过。':kind==='Preview'?'生成指定页或 Excel 区域截图，返回绑定文件版本的图片证据；截图成功不等于已看图或通过，不修改源文件。':'保存实际看图后的逐页或区域发现，绑定源文件版本；每轮保留独立记录，不覆盖检查历史。',inputSchema:{type:'object',additionalProperties:false,required:Object.keys(properties),properties},invoke:async(input,context)=>{
      try {
        if(!input||Object.keys(input).some(k=>!(k in properties)))throw new Error('包含不支持的检查字段。');
        const result=await execute(format,kind,input,context);
        return {content:[{type:'text',text:JSON.stringify(result)},...(kind==='Preview'?[{type:'image',source:{type:'file',mediaType:'image/png',path:result.image_path,sizeBytes:result.image_bytes}}]:[])],executionState:'completed'};
      }catch(error){return {content:[{type:'text',text:JSON.stringify(operationError(error))}],isError:true,failureKind:'precondition'};}
    }};
  }));
}
