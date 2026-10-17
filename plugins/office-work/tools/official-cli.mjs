import {copyFile,readFile,rename,link,realpath} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import {engine,hash} from './engine.mjs';
import {filePath,known,exists,receipt,under} from './document-files.mjs';
import {withFiles,assertFileAvailable,operationError} from './file-access.mjs';
import {withWorkingFile} from './working-file.mjs';
import {scopeSnapshot,checkScope} from './scope-check.mjs';

const reads=new Set(['get','query','view','raw','validate','dump']);
const writes=new Set(['add','set','remove','move','swap','batch','raw-set','add-part']);
const batchVerbs=new Set(['add','set','remove','move','swap']);
const forbiddenFlags=new Set(['-o','-i','--output','--output-dir','--save','--input','--commands']);
const assetKeys=new Set(['src','image','model','file','input','source','template','csv']);
const decode=raw=>{try{return JSON.parse(raw);}catch{return raw;}};
const keys=(o,allowed)=>{if(!o||typeof o!=='object'||Array.isArray(o)||Object.keys(o).some(k=>!allowed.includes(k)))throw new Error('包含不支持的调用字段。');};

async function asset(value,context) {
  if(typeof value!=='string'||/^[a-z][a-z\d+.-]*:/i.test(value)&&!/^[a-z]:[\\/]/i.test(value))throw new Error('资源须为工作区内本地文件。');
  const root=await realpath(context.cwd),file=await realpath(resolve(root,value));
  if(!under(root,file))throw new Error('资源文件不能越出工作区。');
  return file;
}
async function prepare(input,context) {
  const args=input.args??[];
  if(!Array.isArray(args)||args.length>200||args.some(a=>typeof a!=='string'||a.includes('\0')))throw new Error('args 须为不超过 200 项的原生参数数组，不传 shell 命令。');
  const output=[...args];
  for(let i=0;i<output.length;i++) {
    const flag=output[i].split('=')[0].toLowerCase();
    if(forbiddenFlags.has(flag)||/^-[oi][^-]/i.test(output[i]))throw new Error('文件输入／输出参数由插件管理；批处理请传 operations，截图请使用现有 Preview 工具。');
    if(flag==='--prop') {
      const inline=output[i].startsWith('--prop=');
      const at=inline?i:i+1,value=inline?output[i].slice(7):output[at];
      if(typeof value!=='string'||!value.includes('='))throw new Error('--prop 须提供 key=value。');
      const split=value.indexOf('='),key=value.slice(0,split);
      if(assetKeys.has(key.toLowerCase()))output[at]=(inline?'--prop=':'')+key+'='+await asset(value.slice(split+1),context);
      if(!inline)i++;
    }
  }
  if(input.command==='view'&&!['text','outline','issues','stats','markdown'].includes(args[0]))throw new Error('首轮入口支持文本、提纲、问题及统计读取；截图继续使用现有 Preview 工具。');
  let operations;
  if(input.command==='batch') {
    if(args.length||!Array.isArray(input.operations)||!input.operations.length||input.operations.length>200)throw new Error('batch 使用 1–200 项 operations，不混入 args 或 shell 重定向。');
    operations=[];
    for(const item of input.operations) {
      keys(item,['command','path','parent','type','props','index','before','after','to','path2']);
      if(!batchVerbs.has(item.command))throw new Error('批处理仅接受原生 add/set/remove/move/swap 操作。');
      const copy=structuredClone(item);
      if(copy.props!==undefined) {
        if(!copy.props||typeof copy.props!=='object'||Array.isArray(copy.props))throw new Error('props 须为原生属性对象。');
        for(const [key,value] of Object.entries(copy.props)) {
          if(!['string','boolean','number'].includes(typeof value)||typeof value==='number'&&!Number.isFinite(value))throw new Error('原生属性须为文字、布尔或有限数字。');
          if(assetKeys.has(key.toLowerCase()))copy.props[key]=await asset(value,context);
        }
      }
      operations.push(copy);
    }
  } else if(input.operations!==undefined)throw new Error('operations 仅用于 batch。');
  if(JSON.stringify({args:output,operations}).length>200000)throw new Error('本次命令内容过多，请分批执行。');
  return {args:output,operations};
}

async function execute(input,context) {
  keys(input,['command','path','output_path','expected_sha256','args','operations','scope_targets']);
  const command=input.command,writing=command==='create'||writes.has(command);
  if(input.scope_targets!==undefined&&!writes.has(command))throw new Error('scope_targets 仅用于已有文件的局部修改。');
  if(!context.permissions.filesystem?.includes('read')||writing&&!context.permissions.filesystem?.includes('write')||!context.permissions.process?.includes('officecli'))throw new Error('插件缺少文件或 OfficeCLI 权限。');
  if(command!=='help'&&command!=='--version'&&command!=='create'&&!reads.has(command)&&!writes.has(command))throw new Error('此入口执行单文件 OfficeCLI 命令；安装、全局配置、跨文件合并及驻留生命周期不由模型调用。');
  const plan=await prepare(input,context),run=await engine({...context,maxOutputBytes:2000000});
  if(command==='help'||command==='--version') {
    if(input.path||input.output_path||input.expected_sha256)throw new Error('帮助／版本命令不接受文档路径。');
    return {command,result:decode(await run([command,...plan.args]))};
  }
  const extension=typeof input.path==='string'?extname(input.path).toLowerCase():'';
  if(!['.docx','.pptx','.xlsx'].includes(extension))throw new Error('仅处理工作区内 DOCX、PPTX、XLSX。');
  const source=await filePath(context,input.path,command==='create',extension);
  if(command==='create'&&(plan.args.length||input.output_path))throw new Error('create 只需 path；创建后按官方技能逐步编辑。');
  if(!writing&&(input.output_path||input.expected_sha256))throw new Error('读取命令不接受编辑输出或版本条件。');
  if(writes.has(command)&&!/^[a-f0-9]{64}$/.test(input.expected_sha256??''))throw new Error('编辑须传刚读取的 expected_sha256。');
  const inPlace=writes.has(command)&&await known(context,source)&&(!input.output_path||resolve(context.cwd,input.output_path)===source);
  const destination=!writing||command==='create'||inPlace?source:await filePath(context,input.output_path??source.slice(0,-extension.length)+'-edited'+extension,true,extension);
  return withFiles([source,destination],context,async()=>{
    await assertFileAvailable(source);await assertFileAvailable(destination);
    if(writing&&!inPlace&&await exists(destination))throw new Error('输出已存在，请指定新路径，不能覆盖。');
    const original=command==='create'?undefined:hash(await readFile(source));
    if(writes.has(command)&&original!==input.expected_sha256)throw new Error('文件版本已变化，请重新读取后修改。');
    return withWorkingFile(destination,run,context,async(work,close)=>{
      if(command!=='create')await copyFile(source,work);
      const baseline=input.scope_targets!==undefined?scopeSnapshot(extension,await readFile(work)):undefined;
      const options=command==='validate'&&!plan.args.includes('--json')?[...plan.args,'--json']:command==='batch'?['--stop-on-error']:plan.args;
      const result=decode(await run([command,work,...options],plan.operations));
      if(result?.success===false)throw new Error('OfficeCLI 执行失败：'+JSON.stringify(result.error));
      await close();
      if(command!=='create'&&hash(await readFile(source))!==original)throw new Error('执行期间源文件已变化，未发布副本。');
      if(!writing)return {path:source,sha256:original,command,result,structure_checked:command==='validate'&&result?.success===true,visual_checked:false};
      if(context.signal.aborted||Date.now()>=context.deadline-1000)throw new Error('操作取消或到期，未发布副本。');
      await assertFileAvailable(source);await assertFileAvailable(destination);
      const sha256=hash(await readFile(work));
      const changeCheck=baseline?{...checkScope(baseline,scopeSnapshot(extension,await readFile(work)),input.scope_targets),source_sha256:original,sha256}:undefined;
      if(inPlace)await rename(work,destination);else await link(work,destination);
      // Execution success is not a content-range or visual proof. Official skill
      // QA performs explicit readback/validate before declaring delivery complete.
      return receipt(context,destination,sha256,{command,result,source_sha256:original,structure_checked:false,scope_verified:!!changeCheck,...(changeCheck?{change_check:changeCheck}:{}),visual_checked:false});
    });
  });
}

export function registerOfficialCLI() {
  const string={type:'string'};
  return {name:'OfficeCLI',description:'优先配合插件内官方 OfficeCLI Skill 执行原生命令，不经过 shell。command 是动词，args 是原生参数数组（省略 officecli、文件路径与引号；不展开 $FILE）。文件放 path，写入须最新 expected_sha256；batch 的原生 JSON 数组放 operations。属性名称和类型先查 help，不受旧编辑工具属性白名单限制。自动管理工作副本、排队及关闭，不调用 open/save/close。首轮支持单文件正文/对象编辑与文本检查；截图用现有 Preview 工具。局部修改可传 scope_targets（实际 Word 正文路径、PPT 对象路径、Excel 单格或区域），范围外变化拒绝保存；结构重排不套用该核对。不传时 scope_verified:false，成功不代表修改范围或视觉已核对。',inputSchema:{type:'object',additionalProperties:false,required:['command'],properties:{command:string,path:string,output_path:string,expected_sha256:string,args:{type:'array',maxItems:200,items:string},scope_targets:{type:'array',minItems:1,maxItems:100,items:string},operations:{type:'array',minItems:1,maxItems:200,items:{type:'object'}}}},invoke:async(input,context)=>{
    try{return {content:[{type:'text',text:JSON.stringify(await execute(input,context))}],executionState:'completed'};}
    catch(error){return {content:[{type:'text',text:JSON.stringify(operationError(error))}],isError:true,failureKind:'precondition'};}
  }};
}
