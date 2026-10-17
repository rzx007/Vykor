import {readWordBody,sameWordTree} from './word-edit.mjs';

export function pageSettings(value) {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['header','footer','page_numbers'].includes(k))||typeof value.page_numbers!=='boolean')throw new Error('page_settings 须提供 header、footer 字符串及 page_numbers 布尔值。');
  for(const key of ['header','footer'])if(typeof value[key]!=='string'||value[key].length>80||/[\r\n\t]/.test(value[key]))throw new Error('页眉页脚须为不超过 80 字符的单行文字，可为空。');
  return {...value};
}
export function pageSettingsCommands(settings,stories=[]) {
  const ops=stories.map(n=>({command:'remove',path:n.path}));
  if(settings.header)ops.push({command:'add',parent:'/',type:'header',props:{type:'default',text:settings.header,font:'Microsoft YaHei',size:'9pt',align:'right'}});
  if(settings.footer||settings.page_numbers)ops.push({command:'add',parent:'/',type:'footer',props:{type:'default',text:settings.footer+(settings.footer&&settings.page_numbers?' · ':''),...(settings.page_numbers?{field:'page'}:{}),font:'Microsoft YaHei',size:'9pt',align:'center'}});
  ops.push({command:'set',path:'/body/sectPr[1]',props:{marginHeader:'1.27cm',marginFooter:'1.27cm',...(settings.page_numbers?{pageNumFmt:'decimal',pageStart:'1'}:{})}});
  if(settings.page_numbers)ops.push({command:'set',path:'/',props:{updateFields:'true'}});
  return ops;
}
async function get(run,file,path,depth=1) {
  const value=JSON.parse(await run(['get',file,path,'--depth',String(depth),'--json']));
  if(value.success!==true||value.data?.results?.length!==1)throw new Error('无法完整读取页眉页脚。');
  return value.data.results[0];
}
function section(body,root) {
  let count=0;const visit=n=>{if(n.type==='section')count++;for(const c of n.children??[])visit(c);};visit(body);
  const node=body.children.find(n=>n.type==='section');
  if(count!==1||!node||root.format.evenAndOddHeaders||node.format.titlePage||Object.keys(node.format).some(k=>/^(headerRef|footerRef)\.(first|even)$/.test(k)))throw new Error('页眉页脚当前仅支持单节、统一默认页眉页脚；不修改首页或奇偶页不同的文档。');
  return node;
}
function contents(story) {
  if(story.format.type!=='default'||story.children?.length!==1||story.children[0].type!=='paragraph')throw new Error('暂不替换复杂或非默认页眉页脚。');
  const paragraph=story.children[0];let inside=false,literal='',fields=0,instruction='',separated=false;
  if(paragraph.childCount!==paragraph.children?.length)throw new Error('页眉页脚未完整读取。');
  for(const child of paragraph.children) {
    if(child.childCount!==0||!['run','fieldChar','instrText'].includes(child.type))throw new Error('暂不替换含图片、链接或复杂对象的页眉页脚。');
    if(child.type==='fieldChar') {
      const kind=child.format.fieldCharType;
      if(kind==='begin'&&!inside){inside=true;separated=false;instruction='';}
      else if(kind==='separate'&&inside&&!separated)separated=true;
      else if(kind==='end'&&inside&&separated&&instruction.trim()==='PAGE'){inside=false;fields++;}
      else throw new Error('页眉页脚包含不受支持的字段结构。');
    } else if(child.type==='instrText') {if(!inside||separated)throw new Error('页眉页脚字段结构不受支持。');instruction+=child.format.instruction??child.text;}
    else if(!inside)literal+=child.text;
  }
  if(inside)throw new Error('页眉页脚字段不完整。');
  return {literal,fields};
}
async function state(run,file) {
  const root=await get(run,file,'/'),body=await readWordBody(run,file),stories=[];
  section(body,root);
  for(const node of root.children.filter(n=>n.type==='header'||n.type==='footer'))stories.push(await get(run,file,node.path,32));
  if(stories.filter(n=>n.type==='header').length>1||stories.filter(n=>n.type==='footer').length>1)throw new Error('暂不修改多组页眉页脚。');
  for(const story of stories)contents(story);
  return {root,body,stories};
}
export async function verifyPageSettings(run,file,settings,knownState) {
  const current=knownState??await state(run,file),sect=section(current.body,current.root);
  for(const kind of ['header','footer']) {
    const story=current.stories.find(n=>n.type===kind),literal=kind==='header'?settings.header:settings.footer+(settings.footer&&settings.page_numbers?' · ':''),fields=kind==='footer'&&settings.page_numbers?1:0;
    if(!literal&&!fields) {if(story)throw new Error('页眉页脚清除回读不符。');continue;}
    if(!story)throw new Error('未生成请求的页眉页脚。');
    const actual=contents(story);
    if(actual.literal!==literal||actual.fields!==fields||story.format.font!=='Microsoft YaHei'||parseFloat(story.format.size)!==9||story.format.align!==(kind==='header'?'right':'center'))throw new Error('页眉页脚文字、PAGE 域或格式回读不符。');
    const ref=sect.format[`${kind}Ref.default`];if(ref!==story.path)throw new Error('页眉页脚未关联到目标节。');
  }
  if(settings.page_numbers&&(sect.format.pageNumFmt!=='decimal'||Number(sect.format.pageStart)!==1||current.root.format.updateFields!==true))throw new Error('页码格式或打开时更新字段设置回读不符。');
  return {...settings,header_path:current.stories.find(n=>n.type==='header')?.path,footer_path:current.stories.find(n=>n.type==='footer')?.path,...(settings.page_numbers?{page_number_field:'PAGE',update_on_open:true,pagination_verified:false}:{})};
}
export async function editPageSettings(run,file,settings) {
  const before=await state(run,file);
  await run(['batch',file,'--stop-on-error'],pageSettingsCommands(settings,before.stories));
  const after=await state(run,file),verified=await verifyPageSettings(run,file,settings,after);
  const expected=structuredClone(before.body),oldSection=section(expected,before.root),newSection=section(after.body,after.root);
  const allowed=new Set(['headerRef','headerRef.default','footerRef','footerRef.default','marginHeader','marginFooter',...(settings.page_numbers?['pageNumFmt','pageStart']:[])]);
  for(const key of allowed)if(key in newSection.format)oldSection.format[key]=newSection.format[key];else delete oldSection.format[key];
  if(!sameWordTree(expected,after.body))throw new Error('页眉页脚修改影响了未请求的正文或节设置，未保存修改。');
  const protectedFormat=root=>Object.fromEntries(Object.entries(root.format).filter(([k])=>!allowed.has(k)&&!['modified','lastModifiedBy',...(settings.page_numbers?['updateFields']:[])].includes(k)));
  if(!sameWordTree(protectedFormat(before.root),protectedFormat(after.root)))throw new Error('页眉页脚修改影响了其他文档设置，未保存修改。');
  return {settings:verified,change_check:{checked:true,scope:'officecli_body_and_default_stories',requested_operations:[{action:'page_settings',path:'/body/sectPr[1]'}],updated_headers:after.stories.filter(n=>n.type==='header').map(n=>n.path),updated_footers:after.stories.filter(n=>n.type==='footer').map(n=>n.path),other_body_content_unchanged:true}};
}
