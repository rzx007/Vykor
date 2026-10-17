import {readFile,realpath,stat,writeFile} from 'node:fs/promises';
import {resolve,extname,dirname,join} from 'node:path';
import {under} from './document-files.mjs';
import {hash} from './engine.mjs';

const cm=(value,fallback,max)=>{const s=value??fallback;if(typeof s!=='string'||!/^\d+(?:\.\d+)?cm$/.test(s)||parseFloat(s)<=0||parseFloat(s)>max)throw new Error(`图片尺寸须使用 cm，宽不超过 15.92cm、高不超过 20cm。`);return s;};
export function wordImage(value) {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['type','src','width','height','caption','source','alt'].includes(k)))throw new Error('包含不支持的图片字段。');
  for(const key of ['src','caption','source'])if(typeof value[key]!=='string'||!value[key].trim()||value[key].length>(key==='src'?1000:200)||key!=='src'&&/[\r\n\t]/.test(value[key]))throw new Error('图片须提供本地 src、非空单行 caption 图注与 source 来源；图注、来源各不超过 200 字符。');
  if(value.alt!==undefined&&(typeof value.alt!=='string'||!value.alt.trim()||value.alt.length>1000))throw new Error('图片替代文字须非空且不超过 1000 字符。');
  return {src:value.src,width:cm(value.width,'12cm',15.92),height:cm(value.height,'18cm',20),caption:value.caption,source:value.source,alt:value.alt??value.caption};
}
export function imageBlocks(image,paragraphIndex,anchor) {
  const parent=`/body/p[${paragraphIndex}]`,caption=`/body/p[${paragraphIndex+1}]`;
  const paragraph=(text,extra={})=>({text,font:'Microsoft YaHei',size:'10pt',align:'center',spaceAfter:'2pt',lineSpacing:'1x',keepLines:'true',...extra});
  return [
    {command:'add',parent:'/body',type:'paragraph',...(anchor?{after:anchor}:{}),props:paragraph('',{keepNext:'true'})},
    {command:'add',parent,type:'picture',caption:image.caption,source_description:image.source,props:{src:image.src,width:image.width,height:image.height,alt:image.alt}},
    {command:'add',parent:'/body',type:'paragraph',...(anchor?{after:parent}:{}),props:paragraph(image.caption,{keepNext:'true'})},
    {command:'add',parent:'/body',type:'paragraph',...(anchor?{after:caption}:{}),props:paragraph(`来源：${image.source}`,{size:'9pt',spaceAfter:'6pt',keepNext:'false'})},
  ];
}
function dimensions(bytes) {
  if(bytes.length>=24&&bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))&&bytes.toString('ascii',12,16)==='IHDR')return [bytes.readUInt32BE(16),bytes.readUInt32BE(20)];
  if(bytes[0]===255&&bytes[1]===216) {
    let offset=2;
    while(offset+4<=bytes.length) {
      if(bytes[offset++]!==255)break;
      while(bytes[offset]===255)offset++;
      const marker=bytes[offset++];if(marker===217||marker===218)break;
      if(marker===1||marker>=208&&marker<=215)continue;
      if(offset+2>bytes.length)break;
      const length=bytes.readUInt16BE(offset);if(length<2||offset+length>bytes.length)break;
      if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)&&length>=7)return [bytes.readUInt16BE(offset+5),bytes.readUInt16BE(offset+3)];
      offset+=length;
    }
  }
  throw new Error('图片内容不是可识别的 PNG/JPEG。');
}
export async function prepareWordImages(operations,context,work) {
  const pictures=operations.filter(o=>o.type==='picture');
  if(pictures.length>8)throw new Error('单次最多插入 8 张图片。');
  const sources=[];
  for(const [i,op] of pictures.entries()) {
    if(typeof op.props.src!=='string'||/^[a-z][a-z\d+.-]*:/i.test(op.props.src)&&!/^[a-z]:[\\/]/i.test(op.props.src))throw new Error('图片须为工作区内本地 PNG/JPEG，不读取 URL 或 data URI。');
    const root=await realpath(context.cwd),path=await realpath(resolve(root,op.props.src));
    if(!under(root,path)||!['.png','.jpg','.jpeg'].includes(extname(path).toLowerCase()))throw new Error('图片链接或路径须位于当前工作区，格式为 PNG/JPEG。');
    const info=await stat(path);if(!info.isFile()||info.size>10*1024*1024)throw new Error('图片须为不超过 10 MB 的文件。');
    const bytes=await readFile(path);if(bytes.length>10*1024*1024)throw new Error('图片不能超过 10 MB。');
    const [w,h]=dimensions(bytes);if(!w||!h||w*h>40000000)throw new Error('图片尺寸无效或超过 4000 万像素。');
    if((extname(path).toLowerCase()==='.png')!==bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')))throw new Error('图片扩展名与 PNG/JPEG 内容不符。');
    const scale=Math.min(parseFloat(op.props.width)/w,parseFloat(op.props.height)/h),width=+(w*scale).toFixed(3),height=+(h*scale).toFixed(3);
    if(width<0.1||height<0.1)throw new Error('图片长宽比例过大，请先裁剪图片。');
    const snapshot=join(dirname(work),`image-${i}${extname(path).toLowerCase()}`);await writeFile(snapshot,bytes,{flag:'wx'});
    Object.assign(op.props,{src:snapshot,width:`${width}cm`,height:`${height}cm`});
    sources.push({source_path:path,source_sha256:hash(bytes),bytes:bytes.length,parent:op.parent,width_cm:width,height_cm:height,alt:op.props.alt,caption:op.caption,source_description:op.source_description});
    delete op.caption;delete op.source_description;
  }
  return sources;
}
export async function verifyWordImages(run,work,sources) {
  for(const [i,source] of sources.entries()) {
    const result=JSON.parse(await run(['get',work,source.parent,'--depth','2','--json']));
    const pictures=result.data?.results?.[0]?.children?.filter(n=>n.type==='picture');
    if(result.success!==true||pictures?.length!==1)throw new Error('图片未出现在预期段落，未保存修改。');
    const picture=pictures[0],f=picture.format;
    if(f.wrap!=='inline'||f.alt!==source.alt||Math.abs(parseFloat(f.width)-source.width_cm)>0.06||Math.abs(parseFloat(f.height)-source.height_cm)>0.06)throw new Error('图片尺寸、替代文字或排列方式回读不符。');
    const output=join(dirname(work),`embedded-${i}.bin`);
    await run(['get',work,picture.path,'--save',output,'--json']);
    if(hash(await readFile(output))!==source.source_sha256)throw new Error('嵌入图片与来源文件摘要不符，未保存修改。');
    source.picture_path=picture.path;
    source.parent=result.data.results[0].path;
  }
}
export function checkImageBounds(body,sources) {
  const sections=body.children.filter(n=>n.type==='section'),f=sections[0]?.format;
  const value=key=>typeof f?.[key]==='string'&&/^\d+(?:\.\d+)?cm$/.test(f[key])?parseFloat(f[key]):NaN;
  const width=value('pageWidth')-value('marginLeft')-value('marginRight'),height=value('pageHeight')-value('marginTop')-value('marginBottom');
  if(sections.length!==1||!Number.isFinite(width)||!Number.isFinite(height)||Math.abs(value('pageWidth')-21)>0.02||Math.abs(value('pageHeight')-29.7)>0.02||sources.some(s=>s.width_cm>width+0.01||s.height_cm>height-3.5))throw new Error('图片及图注不能放入当前单节 A4 正文区域，请缩小图片最大尺寸。');
}
export function verifyImageCaptions(body,sources) {
  const paragraphs=body.children.filter(n=>n.type==='paragraph');
  for(const source of sources) {
    const match=source.parent.match(/^\/body\/p\[(\d+)\]$/),paragraph=match?paragraphs[Number(match[1])-1]:paragraphs.find(n=>n.path===source.parent),index=body.children.indexOf(paragraph);
    if(index<0||body.children[index+1]?.text!==source.caption||body.children[index+2]?.text!==`来源：${source.source_description}`)throw new Error('图片图注或来源回读不符，未保存修改。');
  }
}
export async function insertWordImage(run,work,anchor,image,context,readBody,same) {
  const before=await readBody(run,work),index=before.children.findIndex(n=>n.path.toLowerCase()===anchor.toLowerCase());
  if(index<0||before.children[index].type!=='paragraph'||!/^\/body\/p\[/i.test(anchor)||before.children.some(n=>n.type==='paragraph'&&!/@paraId=/i.test(n.path)))throw new Error('插图须使用刚读取的正文稳定段落路径。');
  const count=before.children.slice(0,index+1).filter(n=>n.type==='paragraph').length;
  const operations=imageBlocks(image,count+1,before.children[index].path),sources=await prepareWordImages(operations,context,work);
  checkImageBounds(before,sources);
  await run(['batch',work,'--stop-on-error'],operations);
  const after=await readBody(run,work),anchorIndex=after.children.findIndex(n=>n.path===before.children[index].path),added=after.children.slice(anchorIndex+1,anchorIndex+4);
  const oldPaths=new Set(before.children.map(n=>n.path));
  if(anchorIndex!==index||added.length!==3||added.some(n=>n.type!=='paragraph'||oldPaths.has(n.path))||added[0].text!==''||added[1].text!==image.caption||added[2].text!==`来源：${image.source}`||added[0].children.filter(n=>n.type==='picture').length!==1||added[0].format.keepNext!==true||added[1].format.keepNext!==true)throw new Error('图片、图注、来源或插入位置回读不符。');
  const expected=structuredClone(before);expected.children.splice(index+1,0,...added);expected.childCount=expected.children.length;
  if(!same(expected,after))throw new Error('插图影响了未请求的正文、表格或节设置，未保存修改。');
  await verifyWordImages(run,work,sources);
  return {image_sources:sources,change_check:{checked:true,scope:'officecli_body_tree',requested_operations:[{action:'insert_image',path:before.children[index].path}],inserted_paragraphs:added.map(n=>n.path),inserted_images:sources.map(s=>({path:s.picture_path,source_sha256:s.source_sha256,caption_path:added[1].path,source_path:added[2].path})),other_body_content_unchanged:true}};
}
