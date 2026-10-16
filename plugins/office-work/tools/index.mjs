import { readFile, writeFile, mkdir, realpath, copyFile, rename, access, link, stat } from 'node:fs/promises';
import { resolve, relative, dirname, basename, join, extname, isAbsolute } from 'node:path';
import { engine, hash } from './engine.mjs';
import { tableLayout, assertTableTextClearance } from './table-layout.mjs';
import { assertFileAvailable, withFiles, operationError } from './file-access.mjs';
import { withWorkingFile } from './working-file.mjs';
import { snapshotPptx, checkPageDiff } from './page-diff.mjs';
import { previewPage } from './preview.mjs';
import { recordVisualReview, readVisualReview } from './visual-review.mjs';

const json = value => ({content:[{type:'text',text:JSON.stringify(value)}],executionState:'completed'});
const exists = async path => { try { await access(path); return true; } catch { return false; } };
const bounded = (array, max, label) => { if (!Array.isArray(array) || !array.length || array.length > max) throw new Error(`${label} 数量须为 1–${max}。`); return array; };
const keys = (obj,allowed) => { if (!obj || typeof obj !== 'object' || Array.isArray(obj) || Object.keys(obj).some(k=>!allowed.includes(k))) throw new Error('包含不支持的字段。'); };
const text = value => { if (typeof value !== 'string' || value.length > 12000) throw new Error('文本须为字符串且不超过 12000 字符。'); return value; };
const styleKeys = ['text','name','x','y','width','height','font','size','color','fill','line','bold','align','geometry','rowHeight','colWidths'];
function props(value, allowed=styleKeys) {
  keys(value,allowed);
  return Object.fromEntries(Object.entries(value).map(([key,val])=>{
    if (!['string','boolean','number'].includes(typeof val) || (typeof val==='number'&&!Number.isFinite(val))) throw new Error('属性只支持文本、布尔和有限数字。');
    return [key,text(String(val))];
  }));
}
function target(value, root=false) {
  if (root && (value === undefined || value === '/')) return '/';
  if (typeof value !== 'string' || !/^\/slide\[[1-9]\d*\](?:\/(?:shape|table|picture|paragraph|run|tr|tc)\[(?:[1-9]\d*|@id=[1-9]\d*)\])*$/.test(value) || value.length>240) throw new Error('请使用读取工具返回的具体元素路径。');
  return value;
}
function under(root, path) { const rel=relative(root,path); return !rel.startsWith('..')&&!isAbsolute(rel); }
async function filePath(context, raw, output=false) {
  if (typeof raw !== 'string' || !raw || raw.length>1000 || extname(raw).toLowerCase()!=='.pptx') throw new Error('仅支持工作区内的 .pptx 路径。');
  const cwd=await realpath(context.cwd), requested=resolve(cwd,raw);
  if (!under(cwd,requested)) throw new Error('文件须位于当前工作区。');
  if (await exists(requested)) {
    const actual=await realpath(requested);
    if (!under(cwd,actual)) throw new Error('文件链接指向工作区之外。');
    const info=await stat(actual);
    if (!info.isFile()||info.size>64*1024*1024) throw new Error('仅支持不超过 64 MB 的 PPTX 文件。');
    return actual;
  }
  if (!output) throw new Error('文件不存在。');
  let ancestor=dirname(requested);
  while (!await exists(ancestor)) ancestor=dirname(ancestor);
  if (!under(cwd,await realpath(ancestor))) throw new Error('输出目录链接指向工作区之外。');
  await mkdir(dirname(requested),{recursive:true});
  return join(await realpath(dirname(requested)),basename(requested));
}
function build(slides) {
  const ops=[];
  for (const [i,s] of bounded(slides,24,'幻灯片').entries()) {
    keys(s,['title','body','background','shapes','tables','images']);
    const p={title:text(s.title)};
    if (s.body!==undefined) p.text=text(s.body);
    if (s.background!==undefined) p.background=text(s.background);
    ops.push({command:'add',parent:'/',type:'slide',props:p});
    for (const shape of (s.shapes===undefined?[]:bounded(s.shapes,40,'形状'))) ops.push({command:'add',parent:`/slide[${i+1}]`,type:'shape',props:props(shape)});
    for (const image of (s.images===undefined?[]:bounded(s.images,10,'图片'))) ops.push({command:'add',parent:`/slide[${i+1}]`,type:'picture',props:props(image,['src','name','x','y','width','height'])});
    for (const [t,table] of (s.tables===undefined?[]:bounded(s.tables,5,'表格')).entries()) {
      keys(table,['rows','x','y','width','height','name','size','rowHeight','colWidths']);
      const rows=bounded(table.rows,20,'表格行'), cols=bounded(rows[0],12,'表格列').length;
      if (rows.some(r=>!Array.isArray(r)||r.length!==cols)) throw new Error('表格各行列数须相同。');
      const layout=tableLayout(table);
      assertTableTextClearance(layout,s.shapes,i+1,t+1);
      ops.push({command:'add',parent:`/slide[${i+1}]`,type:'table',props:{
        ...(table.name!==undefined?{name:text(table.name)}:{}),rows:String(rows.length),cols:String(cols),
        x:`${layout.x}pt`,y:`${layout.y}pt`,width:`${layout.width}pt`,height:`${layout.height}pt`,
        colWidths:layout.widths.map(w=>`${w}pt`).join(','),
      }});
      rows.forEach((row,r)=>{
        ops.push({command:'set',path:`/slide[${i+1}]/table[${t+1}]/tr[${r+1}]`,props:{height:`${layout.rowHeights[r]}pt`}});
        row.forEach((cell,c)=>{
        if (typeof cell!=='string'&&(typeof cell!=='number'||!Number.isFinite(cell))) throw new Error('表格单元格仅支持文本和有限数字。');
        ops.push({command:'set',path:`/slide[${i+1}]/table[${t+1}]/tr[${r+1}]/tc[${c+1}]`,props:{text:text(String(cell)),size:`${layout.size}pt`,font:'Microsoft YaHei',bold:String(r===0),padding:'6pt',valign:'top',wrap:'true'}});
        });
      });
    }
  }
  if (JSON.stringify(ops).length>160000) throw new Error('内容过多，请缩小本次演示稿。');
  return ops;
}
async function recordPath(context,file) { return join(context.plugin.dataDir,'presentations',`${hash(file.toLowerCase())}.json`); }
async function known(context,file) { try { const r=JSON.parse(await readFile(await recordPath(context,file),'utf8')); return r.path===file&&r.cwd===await realpath(context.cwd); } catch { return false; } }
async function receipt(context,file,sha256,pageDiff) {
  const result={path:file,sha256,structure_checked:true,visual_checked:false,...(pageDiff?{page_diff:pageDiff}:{})};
  try { const p=await recordPath(context,file); await mkdir(dirname(p),{recursive:true}); await writeFile(p,JSON.stringify({...result,cwd:await realpath(context.cwd),updated_at:new Date().toISOString()})); }
  catch { result.warning='文件已保存，但当前成果记录保存失败；后续编辑会另存副本。'; }
  return result;
}

async function execute(kind,input,context) {
  const writing=kind==='Create'||kind==='Edit'||kind==='Preview'||kind==='Review';
  if (!context.permissions.filesystem?.includes('read') || (writing&&!context.permissions.filesystem?.includes('write')) || !context.permissions.process?.includes('officecli')) throw new Error('插件缺少文件或 OfficeCLI 进程权限。');
  const source=await filePath(context,input.path,kind==='Create');
  await assertFileAvailable(source);
  if (kind==='Review') return recordVisualReview(source,input,context);
  const run=await engine(context);
  if (kind==='Preview') return previewPage(source,input.page,run,context);
  if (kind==='Read'||kind==='Check') {
    const selected=target(input.target,true);
    return await withFiles([source],context,async()=>{
      await assertFileAvailable(source);
      const before=hash(await readFile(source));
      return await withWorkingFile(source,run,context,async work=>{
        await copyFile(source,work);
        const document=JSON.parse(await run(['get',work,selected,'--json']));
        if (document.success===false) throw new Error('读取失败。');
        const validation=kind==='Check'?JSON.parse(await run(['validate',work,'--json'])):undefined;
        if (validation?.success===false) throw new Error('结构验证失败。');
        if (hash(await readFile(source))!==before) throw new Error('读取期间文件已变化，请重读。');
        const visualReview=kind==='Check'?await readVisualReview(source,before,context):undefined;
        return {path:source,sha256:before,document,...(validation?{validation,structure_checked:true,visual_checked:false}:{}),...(visualReview?{visual_review:visualReview}:{})};
      });
    });
  }
  let operations;
  if (kind==='Create') {
    if (await exists(source)) throw new Error('目标文件已存在，不能覆盖；请编辑或更换路径。');
    operations=build(input.slides);
    for (const op of operations.filter(o=>o.type==='picture')) {
      const raw=op.props.src;
      if (!raw||/^https?:/i.test(raw)) throw new Error('图片须是工作区内的本地 PNG/JPEG。');
      const path=await realpath(resolve(context.cwd,raw));
      if (!under(await realpath(context.cwd),path)||!['.png','.jpg','.jpeg'].includes(extname(path).toLowerCase())) throw new Error('图片须是工作区内的本地 PNG/JPEG。');
      if ((await stat(path)).size>10*1024*1024) throw new Error('图片不能超过 10 MB。');
      op.props.src=path;
    }
  } else {
    operations=bounded(input.operations,100,'修改').map(o=>{keys(o,['path','props']);return {command:'set',path:target(o.path),props:props(o.props)};});
    if (!/^[a-f0-9]{64}$/.test(input.expected_sha256||'')) throw new Error('请传入刚读取文件返回的 expected_sha256。');
  }
  const inPlace=kind==='Edit'&&await known(context,source)&&(!input.output_path||resolve(context.cwd,input.output_path)===source);
  const destination=kind==='Create'?source:inPlace?source:await filePath(context,input.output_path||source.replace(/\.pptx$/i,'-edited.pptx'),true);
  return await withFiles([source,destination],context,async()=>{
    await assertFileAvailable(source);
    await assertFileAvailable(destination);
    if (!inPlace&&await exists(destination)) throw new Error('输出已存在；请指定新的 output_path。');
    const original=kind==='Edit'?hash(await readFile(source)):undefined;
    if (kind==='Edit'&&original!==input.expected_sha256) throw new Error('文件已变化，请重新读取后修改。');
    return await withWorkingFile(destination,run,context,async(work,close)=>{
      if (kind==='Create') await run(['create',work]); else await copyFile(source,work);
      const beforePages=kind==='Edit'?snapshotPptx(await readFile(work)):undefined;
      await run(['batch',work,'--stop-on-error'],operations);
      const validation=JSON.parse(await run(['validate',work,'--json']));
      if (validation.success===false) throw new Error('结构验证失败。');
      // Flush and release the resident before publishing or hashing its on-disk bytes.
      await close();
      const savedBytes=await readFile(work);
      const pageDiff=beforePages?checkPageDiff(beforePages,snapshotPptx(savedBytes),operations.map(op=>Number(/^\/slide\[(\d+)\]/.exec(op.path)[1]))):undefined;
      if (context.signal.aborted||Date.now()>=context.deadline-1000) throw new Error('操作取消，未替换目标文件。');
      await assertFileAvailable(source);
      await assertFileAvailable(destination);
      if (kind==='Edit'&&hash(await readFile(source))!==original) throw new Error('修改期间源文件已变化，未替换目标文件。');
      const sha256=hash(savedBytes);
      if (inPlace) await rename(work,destination); else await link(work,destination);
      return await receipt(context,destination,sha256,pageDiff);
    });
  });
}

const string={type:'string'};
const style=Object.fromEntries(styleKeys.map(k=>[k,{type:['string','number','boolean']}]));
const item={type:'object',properties:style,additionalProperties:false};
const imageSchema={type:'object',required:['src'],additionalProperties:false,
  properties:Object.fromEntries(['src','name','x','y','width','height'].map(k=>[k,string]))};
const tableSchema={type:'object',required:['rows'],additionalProperties:false,properties:{
  rows:{type:'array',items:{type:'array',items:{type:['string','number']}}},
  ...Object.fromEntries(['x','y','width','height','name','size','rowHeight','colWidths'].map(k=>[k,string])),
}};
const slideSchema={type:'object',required:['title'],additionalProperties:false,properties:{
  title:string,body:string,background:string,shapes:{type:'array',items:item},
  images:{type:'array',items:imageSchema},tables:{type:'array',items:tableSchema},
}};
const schemas={
 Create:{path:string,slides:{type:'array',minItems:1,maxItems:24,items:slideSchema}},
 Read:{path:string,target:{type:'string',description:'读取返回的元素路径；默认 /，可指定 /slide[2] 或 /slide[2]/shape[@id=2]。'}},
 Edit:{path:string,output_path:string,expected_sha256:{type:'string',description:'刚读取文件返回的 sha256，防止覆盖外部修改。'},operations:{type:'array',minItems:1,maxItems:100,items:{type:'object',required:['path','props'],additionalProperties:false,properties:{path:string,props:item}}}},
 Check:{path:string},
 Preview:{path:string,page:{type:'integer',minimum:1,maximum:200,description:'本次要查看的单个页码；每次只生成一页截图。'}},
 Review:{path:string,expected_sha256:string,pages:{type:'array',minItems:1,maxItems:200,items:{type:'object',additionalProperties:false,required:['preview_id','conclusion','findings'],properties:{preview_id:string,conclusion:{type:'string',enum:['passed','issues']},findings:{type:'string',minLength:1,maxLength:12000}}}}},
};
export function registerTools() {
  const descriptions={Create:'创建可编辑 PPTX（文字、形状、表格、本地图片），不覆盖已有文件；返回真实路径和文件摘要。',Read:'读取工作区 PPTX 的页序、文字和具体元素路径，返回 sha256；按单页读取可减少输出。',Edit:'按读取返回的路径修改文字及基础样式；须传 expected_sha256。保存前自动核对页面差异，拒绝无关页或共享资源变化；返回 page_diff，不代表视觉检查。已有用户文件另存副本，插件当前成果可原位修订。',Check:'检查 PPTX OpenXML 结构并回读内容；不检查视觉排版，也不证明 PowerPoint/WPS 显示完全一致。'};
  descriptions.Preview='生成 PPTX 指定单页的 HTML 渲染 PNG，通过图片结果供支持视觉的模型查看；返回源文件 sha256 和页码。保持原 PPT 不变，不等于视觉检查通过，也不证明 PowerPoint/WPS 显示一致。';
  descriptions.Review='保存实际看图后的逐页结论与具体发现；须提供截图返回的 expected_sha256 和 preview_id，拒绝旧版本或无截图记录的结论。同版本检查页合并保存，重新检查某页会替换该页发现；仅代表模型报告的已检查页，不代表全稿通过。';
  return Object.keys(schemas).map(kind=>({name:'OfficePpt'+kind,description:descriptions[kind],inputSchema:{type:'object',additionalProperties:false,properties:schemas[kind],required:kind==='Create'?['path','slides']:kind==='Edit'?['path','expected_sha256','operations']:kind==='Preview'?['path','page']:kind==='Review'?['path','expected_sha256','pages']:['path']},invoke:async(input,context)=>{
    try {
      keys(input,Object.keys(schemas[kind]));
      const result=await execute(kind,input,context), reply=json(result);
      if(kind==='Preview') reply.content.push({type:'image',source:{type:'file',mediaType:'image/png',path:result.image_path,sizeBytes:result.image_bytes}});
      return reply;
    }
    catch(error) { return {...json(operationError(error)),isError:true,failureKind:'precondition'}; }
  }}));
}
