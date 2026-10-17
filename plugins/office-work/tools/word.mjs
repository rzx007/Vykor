import {copyFile,link,readFile,rename} from 'node:fs/promises';
import {resolve} from 'node:path';
import {engine,hash} from './engine.mjs';
import {exists,filePath,known,receipt,currentReceipt} from './document-files.mjs';
import {assertFileAvailable,operationError,withFiles} from './file-access.mjs';
import {withWorkingFile} from './working-file.mjs';
import {buildWordContent} from './word-content.mjs';
import {wordTarget as target,wordEdits as edits,editWord,readWordBody,sameWordTree} from './word-edit.mjs';
import {pageSettings,pageSettingsCommands,verifyPageSettings,editPageSettings} from './word-page-settings.mjs';
import {wordImage,prepareWordImages,verifyWordImages,insertWordImage,checkImageBounds,verifyImageCaptions} from './word-images.mjs';
import {previewPage} from './preview.mjs';
import {recordVisualReview,readVisualReview} from './visual-review.mjs';

const keys=(value,allowed)=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!allowed.includes(key)))throw new Error('包含不支持的字段。');};
async function get(run,file,path,depth=1) {
  const document=JSON.parse(await run(['get',file,path,'--depth',String(depth),'--json']));
  if(document.success!==true||document.data?.results?.length!==1)throw new Error('未找到唯一的文档元素，请重新读取定位。');
  return document;
}
async function validate(run,file) {
  const result=JSON.parse(await run(['validate',file,'--json']));
  if(result.success!==true)throw new Error('Word 文档结构验证失败，未保存修改。');
  return result;
}
function editOperations(input) {
  if(input.operations?.some(o=>['page_settings','insert_image'].includes(o?.action))) {
    if(!/^[a-f0-9]{64}$/.test(input.expected_sha256??'')||input.operations.length!==1)throw new Error('页眉页脚或插图须单独提交一项操作，并提供最新 expected_sha256。');
    const item=input.operations[0];keys(item,['action','path','props']);
    if(item.action==='page_settings') {
      if(item.path!=='/body/sectPr[1]')throw new Error('页眉页脚设置目标须为 /body/sectPr[1]。');
      return [{...item,props:pageSettings(item.props)}];
    }
    return [{...item,path:target(item.path),props:wordImage(item.props)}];
  }
  return edits(input);
}
async function execute(kind,input,context) {
  const writing=['Create','Edit','Preview','Review'].includes(kind);
  if(!context.permissions.filesystem?.includes('read')||(writing&&!context.permissions.filesystem?.includes('write'))||!context.permissions.process?.includes('officecli'))throw new Error('插件缺少文件或 OfficeCLI 进程权限。');
  const source=await filePath(context,input.path,kind==='Create','.docx');
  if(kind==='Preview')return previewPage(source,input.page,await engine(context),context);
  if(kind==='Review')return recordVisualReview(source,input,context);
  const operations=kind==='Create'?buildWordContent(input):kind==='Edit'?editOperations(input):undefined;
  const settings=kind==='Create'&&input.page_settings!==undefined?pageSettings(input.page_settings):undefined;
  const selected=kind==='Read'?target(input.target,true):'/body';
  if(kind==='Read'&&input.depth!==undefined&&(!Number.isSafeInteger(input.depth)||input.depth<1||input.depth>8))throw new Error('读取 depth 须为 1–8。');
  const inPlace=kind==='Edit'&&await known(context,source)&&(!input.output_path||resolve(context.cwd,input.output_path)===source);
  const destination=!writing||kind==='Create'||inPlace?source:await filePath(context,input.output_path??source.replace(/\.docx$/i,'-edited.docx'),true,'.docx');
  return withFiles([source,destination],context,async()=>{
    await assertFileAvailable(source);await assertFileAvailable(destination);
    if(writing&&!inPlace&&await exists(destination))throw new Error('输出已存在，请编辑或指定新的路径，不能覆盖。');
    const original=kind==='Create'?undefined:hash(await readFile(source));
    if(kind==='Edit'&&original!==input.expected_sha256)throw new Error('文件已变化，请重新读取后修改。');
    const run=await engine(context);
    return withWorkingFile(destination,run,context,async(work,close)=>{
      if(kind==='Create')await run(['create',work]);else await copyFile(source,work);
      if(!writing) {
        const document=await get(run,work,selected,kind==='Read'?input.depth??1:1);
        const validation=kind==='Check'?await validate(run,work):undefined;
        if(hash(await readFile(source))!==original)throw new Error('读取期间文件已变化，请重读。');
        const visualReview=kind==='Check'?await readVisualReview(source,original,context):undefined;
        const record=kind==='Check'?await currentReceipt(context,source,original):undefined;
        return {path:source,sha256:original,document,...(validation?{validation,structure_checked:true,visual_checked:false}:{}),...(visualReview?{visual_review:visualReview}:{}),...(record?.change_check?{change_check:record.change_check}:{}),...(record?.page_settings?{page_settings:record.page_settings}:{}),...(record?.image_sources?{image_sources:record.image_sources}:{})};
      }
      let changeCheck,verifiedSettings,imageSources;
      if(kind==='Create') {
        imageSources=await prepareWordImages(operations,context,work);
        await run(['batch',work,'--stop-on-error'],settings?[...operations,...pageSettingsCommands(settings)]:operations);
        if(imageSources.length){const body=await readWordBody(run,work);checkImageBounds(body,imageSources);verifyImageCaptions(body,imageSources);await verifyWordImages(run,work,imageSources);}
        if(settings)verifiedSettings=await verifyPageSettings(run,work,settings);
      } else if(operations[0].action==='page_settings') {
        const result=await editPageSettings(run,work,operations[0].props);changeCheck=result.change_check;verifiedSettings=result.settings;
      } else if(operations[0].action==='insert_image') {
        const result=await insertWordImage(run,work,operations[0].path,operations[0].props,context,readWordBody,sameWordTree);changeCheck=result.change_check;imageSources=result.image_sources;
      } else changeCheck=await editWord(run,work,operations);
      await validate(run,work);
      await close();
      if(context.signal.aborted||Date.now()>=context.deadline-1000)throw new Error('操作取消，未替换目标文件。');
      await assertFileAvailable(source);await assertFileAvailable(destination);
      if(kind==='Edit'&&hash(await readFile(source))!==original)throw new Error('修改期间源文件已变化，未替换目标文件。');
      const sha256=hash(await readFile(work));
      if(inPlace)await rename(work,destination);else await link(work,destination);
      return receipt(context,destination,sha256,{...(changeCheck?{change_check:{...changeCheck,source_sha256:original,sha256}}:{}),...(verifiedSettings?{page_settings:{...verifiedSettings,sha256}}:{}),...(imageSources?.length?{image_sources:imageSources.map(s=>({...s,sha256}))}:{})});
    });
  });
}
export function registerWordTools() {
  const string={type:'string'};
  const editProps={type:'object',additionalProperties:false,properties:{find:string,replace:string,text:string,expected_text:string,style:{type:'string',enum:['Normal','Heading1','Heading2']},align:{type:'string',enum:['left','center','right','justify']},bold:{type:'boolean'},italic:{type:'boolean'},size:string,color:string,spaceBefore:string,spaceAfter:string,lineSpacing:string,pageBreakBefore:{type:'boolean'},keepNext:{type:'boolean'},keepLines:{type:'boolean'},widowControl:{type:'boolean'},src:string,width:string,height:string,caption:string,source:string,alt:string,header:string,footer:string,page_numbers:{type:'boolean'},colWidths:{type:'array',items:string},repeat_header:{type:'boolean'},allow_row_split:{type:'boolean'},index:{type:'integer',minimum:1},values:{type:'array',items:string},expected_values:{type:'array',items:string}}};
  const block={type:'object',additionalProperties:false,required:['type'],properties:{type:{type:'string',enum:['paragraph','table','image']},text:string,style:{type:'string',enum:['Normal','Heading1','Heading2']},align:{type:'string',enum:['left','center','right','justify']},rows:{type:'array',items:{type:'array',items:{type:['string','number']}}},colWidths:{type:'array',items:string},pageBreakBefore:{type:'boolean'},keepNext:{type:'boolean'},keepLines:{type:'boolean'},widowControl:{type:'boolean'},src:string,width:string,height:string,caption:string,source:string,alt:string}};
  const pageSchema={type:'object',additionalProperties:false,required:['header','footer','page_numbers'],properties:{header:string,footer:string,page_numbers:{type:'boolean'}}};
  const pageCheck={type:'object',additionalProperties:false,required:['status','observation'],properties:{status:{type:'string',enum:['passed','issues','not_applicable','uncertain']},observation:{type:'string',minLength:1,maxLength:3000}}};
  const wordChecks={type:'object',additionalProperties:false,required:['body','header','footer','pagination'],properties:{body:pageCheck,header:pageCheck,footer:pageCheck,pagination:pageCheck}};
  const schemas={Create:{path:string,title:string,page_settings:pageSchema,blocks:{type:'array',minItems:1,maxItems:120,items:block}},Read:{path:string,target:string,depth:{type:'integer',minimum:1,maximum:8}},Edit:{path:string,output_path:string,expected_sha256:string,operations:{type:'array',minItems:1,maxItems:20,items:{type:'object',additionalProperties:false,required:['path','props'],properties:{action:{type:'string',enum:['update','insert_before','insert_after','remove','format_text','table_layout','insert_row','remove_row','insert_column','remove_column','page_settings','insert_image']},path:string,props:editProps}}}},Check:{path:string},Preview:{path:string,page:{type:'integer',minimum:1,maximum:200}},Review:{path:string,expected_sha256:string,pages:{type:'array',minItems:1,maxItems:200,items:{type:'object',additionalProperties:false,required:['preview_id','checks'],properties:{preview_id:string,checks:wordChecks}}}}};
  const descriptions={Create:'创建可编辑 A4 DOCX 报告，有序 blocks 支持 paragraph、table、image，支持分页控制及可选 page_settings 页眉页脚和动态页码；图片仅工作区 PNG/JPEG，保留图注来源，不覆盖已有文件。',Read:'读取 DOCX 正文、表格、单元格及实际段落路径，返回 sha256。depth 可设 1–8，读取表格原文宜用 4；可读 /header[N]、/footer[N] 和 /body/sectPr[1]。',Edit:'Word 局部编辑：段落替换、增删、整段或唯一文字格式；矩形表格列宽、表头、跨页及行列增删。必须使用最新 expected_sha256、实际路径，删除须核对原文。每张表一次一项操作。分页控制用 update；页眉页脚 page_settings 和正文段落后 insert_image 各须单独提交。回读核对并记录版本与范围，用户文件另存。',Check:'回读并检查 DOCX 结构，附带当前文件版本的 visual_review；结构通过不等于视觉通过。',Preview:'生成 A4 纵向 DOCX 指定 HTML 渲染页截图供支持视觉的模型实际查看；不是 Word/WPS 原生分页，截图成功不等于检查通过。',Review:'实际看图后逐页提交 body/header/footer/pagination 四项 checks，每项含 status 与 observation；由工具汇总结论，异常或 uncertain 不会通过。只接受新版完整分页截图，仍为模型报告，不能证明 Word/WPS 保真。'};
  return Object.keys(schemas).map(kind=>({name:'OfficeWord'+kind,description:descriptions[kind],inputSchema:{type:'object',additionalProperties:false,properties:schemas[kind],required:kind==='Create'?['path','title','blocks']:kind==='Edit'?['path','expected_sha256','operations']:kind==='Preview'?['path','page']:kind==='Review'?['path','expected_sha256','pages']:['path']},invoke:async(input,context)=>{
    try {keys(input,Object.keys(schemas[kind]));const result=await execute(kind,input,context);return {content:[{type:'text',text:JSON.stringify(result)},...(kind==='Preview'?[{type:'image',source:{type:'file',mediaType:'image/png',path:result.image_path,sizeBytes:result.image_bytes}}]:[])],executionState:'completed'};}
    catch(error){return {content:[{type:'text',text:JSON.stringify(operationError(error))}],isError:true,failureKind:'precondition'};}
  }}));
}
