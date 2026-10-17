import {buildWordContent} from './word-content.mjs';
import {tableActions,tableEdit,tableCommands,checkTableChange} from './word-table.mjs';
import {inlineRange,checkInlineChange} from './word-inline.mjs';

const only=(value,allowed)=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!allowed.includes(key)))throw new Error('包含不支持的修改字段。');};
const text=(value,empty=false)=>{if(typeof value!=='string'||value.length>12000||(!empty&&!value.trim()))throw new Error('段落文字须为字符串且不超过 12000 字符。');return value;};
const same=(a,b)=>JSON.stringify(normalize(a))===JSON.stringify(normalize(b));
export {same as sameWordTree};
function normalize(value) {
  if(Array.isArray(value))return value.map(normalize);
  if(value&&typeof value==='object') {
    // Cell text and run-format summaries are derived from its paragraphs below.
    const copy={...value};
    if(value.type==='cell') {
      delete copy.text;
      copy.format=Object.fromEntries(Object.entries(copy.format??{}).filter(([k])=>!['font','size','bold','italic','color','align'].includes(k)));
    }
    return Object.fromEntries(Object.keys(copy).sort().filter(k=>!['path','preview'].includes(k)).map(k=>[k,normalize(copy[k])]));
  }
  return value;
}
export function wordTarget(value,root=false) {
  if(root&&(value===undefined||value==='/'||value==='/body'))return value??'/body';
  if(root&&typeof value==='string'&&/^\/(?:header|footer)\[[1-9]\d*\]$|^\/body\/sectPr\[1\]$/i.test(value))return value;
  const index='[1-9]\\d*',p=`p\\[(?:${index}|@paraId=[a-f0-9]{8})\\]`;
  const pattern=root?`^/body/(?:${p}|tbl\\[${index}\\](?:/tr\\[${index}\\](?:/tc\\[${index}\\](?:/${p})?)?)?)$`:`^/body/(?:tbl\\[${index}\\]/tr\\[${index}\\]/tc\\[${index}\\]/)?${p}$`;
  if(typeof value!=='string'||!new RegExp(pattern,'i').test(value))throw new Error('请使用读取返回的正文或表格内段落路径。');
  return value;
}
const formatKeys=['style','align','bold','italic','size','color','spaceBefore','spaceAfter','lineSpacing','pageBreakBefore','keepNext','keepLines','widowControl'];
function formatting(props) {
  const out={};
  for(const key of formatKeys)if(props[key]!==undefined) {
    const value=props[key];
    if(key==='style'&&!['Normal','Heading1','Heading2'].includes(value))throw new Error('样式仅支持 Normal、Heading1、Heading2。');
    if(key==='align'&&!['left','center','right','justify'].includes(value))throw new Error('对齐方式无效。');
    if(['bold','italic','pageBreakBefore','keepNext','keepLines','widowControl'].includes(key)&&typeof value!=='boolean')throw new Error('加粗、斜体及分页控制须为布尔值。');
    if(['size','spaceBefore','spaceAfter'].includes(key)) {
      const match=typeof value==='string'&&value.match(/^(\d+(?:\.5)?)pt$/),number=match?Number(match[1]):NaN;
      if(!Number.isFinite(number)||number<(key==='size'?8:0)||number>(key==='size'?36:48))throw new Error('字号须为 8–36pt，段前后间距须为 0–48pt，最多半磅精度。');
    }
    if(key==='lineSpacing'&&!['1x','1.15x','1.5x','2x'].includes(value))throw new Error('行距仅支持 1x、1.15x、1.5x、2x。');
    if(key==='color'&&(typeof value!=='string'||!/^#[a-f0-9]{6}$/i.test(value)))throw new Error('文字颜色须为 #RRGGBB。');
    out[key]=key==='color'?value.toUpperCase():value;
  }
  return out;
}
export function wordEdits(input) {
  if(!/^[a-f0-9]{64}$/.test(input.expected_sha256??''))throw new Error('请传入刚读取文件返回的 expected_sha256。');
  if(!Array.isArray(input.operations)||!input.operations.length||input.operations.length>20)throw new Error('修改数量须为 1–20。');
  return input.operations.map(item=>{
    only(item,['action','path','props']);
    if(tableActions.includes(item.action))return tableEdit(item);
    const action=item.action??'update',path=wordTarget(item.path);
    if(!['update','insert_before','insert_after','remove','format_text'].includes(action))throw new Error('不支持此段落操作。');
    const props=item.props??{};
    only(props,action==='remove'?['expected_text']:action==='format_text'?['find','bold','italic','size','color']:action==='update'?['find','replace',...formatKeys]:['text',...formatKeys]);
    if(action==='remove')return {action,path,props:{expected_text:text(props.expected_text,true)}};
    const format=formatting(props);
    if(action==='format_text') {
      if(!Object.keys(format).length)throw new Error('局部格式须提供加粗、斜体、字号或颜色。');
      return {action,path,props:{find:text(props.find),...format}};
    }
    if(action.startsWith('insert_')) {
      if(!/^\/body\/p\[/i.test(path))throw new Error('段落增删仅支持正文，不修改表格结构。');
      const defaults=buildWordContent({title:'_',blocks:[{type:'paragraph',text:text(props.text),style:format.style,align:format.align}]}).at(-1).props;
      return {action,path,props:{...defaults,...format}};
    }
    const hasFind='find' in props||'replace' in props;
    if(!hasFind&&!Object.keys(format).length)throw new Error('请提供查找替换或至少一项段落格式。');
    if(hasFind) {
      const find=text(props.find),replace=text(props.replace,true);
      if(/^r["']/i.test(find))throw new Error('仅支持字面查找，不支持正则表达式。');
      Object.assign(format,{find,replace});
    }
    return {action,path,props:format};
  });
}
export async function readWordBody(run,file) {
  const result=JSON.parse(await run(['get',file,'/body','--depth','32','--json']));
  const node=result.data?.results?.[0];
  if(result.success!==true||result.data.results.length!==1||node?.type!=='body')throw new Error('无法读取完整正文，未保存修改。');
  const check=n=>{if(n.childCount!==(n.children??[]).length)throw new Error('正文层级超出检查范围，未保存修改。');for(const child of n.children??[])check(child);};
  check(node);return node;
}
function paragraphs(root) {
  const paths=new Map();
  const visit=(node,parent)=>{
    const counts={};
    for(const child of node.children??[]) {
      const type=({paragraph:'p',table:'tbl',row:'tr',cell:'tc'})[child.type];
      const alias=type?`${parent}/${type}[${counts[type]=(counts[type]??0)+1}]`:child.path;
      if(child.type==='paragraph') {
        for(const path of [child.path,alias]) {
          const key=path.toLowerCase();
          if(paths.has(key)&&paths.get(key)!==child)throw new Error('段落路径不唯一，未保存修改。');
          paths.set(key,child);
        }
      }
      visit(child,alias);
    }
  };
  visit(root,'/body');return paths;
}
function verifyFormat(node,props) {
  for(const key of formatKeys)if(props[key]!==undefined) {
    const pagination=['pageBreakBefore','keepNext','keepLines','widowControl'].includes(key);
    const desired=pagination&&typeof props[key]==='string'?props[key]==='true':props[key];
    let actual=node.format?.[key]??node.format?.[`effective.${key}`];
    if(key==='style')actual=node.style;
    if(key==='align'&&actual==='both')actual='justify';
    const numeric=['size','spaceBefore','spaceAfter'].includes(key)&&parseFloat(actual)===parseFloat(desired);
    const off=desired===false&&actual===undefined&&pagination;
    if(actual!==desired&&!numeric&&!off)throw new Error(`段落 ${key} 格式回读不符，未保存修改。`);
  }
}
// The check covers OfficeCLI's complete body tree, not physical pages or all OOXML parts.
export function checkWordChanges(before,after,operations) {
  const wanted=paragraphs(before),actual=paragraphs(after),updated=[],removed=[],inserted=[],tables=[],tableChanges=[],textRanges=[];
  const expected=structuredClone(before),expectedPaths=paragraphs(expected);
  const used=new Set();
  for(const operation of operations) {
    if(tableActions.includes(operation.action)) {
      const original=before.children.find(n=>n.path.toLowerCase()===operation.path.toLowerCase());
      const next=after.children.find(n=>n.path.toLowerCase()===operation.path.toLowerCase());
      if(!original||!next)throw new Error('表格不存在，未保存修改。');
      checkTableChange(original,next,operation,same);
      Object.assign(expected.children.find(n=>n.path===original.path),structuredClone(next));
      tables.push(original.path);
      tableChanges.push({path:original.path,action:operation.action,...(operation.props.index?{index:operation.props.index}:{}),rows_before:original.children.length,rows_after:next.children.length,columns_before:original.children[0].children.length,columns_after:next.children[0].children.length});
      continue;
    }
    const original=wanted.get(operation.path.toLowerCase());
    if(!original)throw new Error('目标段落不存在，未保存修改。');
    if(used.has(original.path))throw new Error('同一段落每次仅支持一项操作，请合并格式与文字修改或分次读取修改。');
    used.add(original.path);
    const node=expectedPaths.get(original.path.toLowerCase());
    if(operation.action==='format_text') {
      const next=actual.get(original.path.toLowerCase());
      if(!next)throw new Error('目标段落缺失。');
      textRanges.push({path:original.path,...checkInlineChange(original,next,operation.props,same)});
      Object.assign(node,structuredClone(next));if(!same(original,next))updated.push(next.path);
    } else if(operation.action==='update') {
      const next=actual.get(original.path.toLowerCase());
      if(!next)throw new Error('修改后的段落缺失，未保存修改。');
      let expectedText=original.text;
      if(operation.props.find!==undefined) {
        if(expectedText.split(operation.props.find).length!==2)throw new Error('查找文字在目标段落中必须恰好出现一次。');
        expectedText=expectedText.replace(operation.props.find,()=>operation.props.replace);
      }
      if(next.text!==expectedText)throw new Error('段落文字回读不符，未保存修改。');
      verifyFormat(next,operation.props);
      Object.assign(node,structuredClone(next));
      if(!same(original,next))updated.push(next.path);
    } else {
      const index=expected.children.indexOf(node);
      if(index<0)throw new Error('段落增删仅支持正文，不修改表格结构。');
      if(operation.action==='remove') {
        if(original.text!==operation.props.expected_text)throw new Error('删除段落原文不符，请重新读取。');
        expected.children.splice(index,1);removed.push(original.path);
      } else {
        const anchor=after.children.findIndex(n=>n.path===original.path),offset=operation.action==='insert_before'?-1:1;
        const added=after.children[anchor+offset];
        if(anchor<0||added?.type!=='paragraph'||wanted.has(added.path.toLowerCase())||inserted.includes(added.path)||added.text!==operation.props.text)throw new Error('插入位置或文字回读不符，未保存修改。');
        verifyFormat(added,operation.props);
        expected.children.splice(index+(offset===1?1:0),0,structuredClone(added));inserted.push(added.path);
      }
    }
  }
  expected.childCount=expected.children.length;
  if(!same(expected,after))throw new Error('局部修改影响了未请求的正文、表格或节设置，未保存修改。');
  return {checked:true,scope:'officecli_body_tree',requested_operations:operations.map(o=>({action:o.action,path:o.path,...(o.props.index?{index:o.props.index}:{})})),updated_paragraphs:updated,inserted_paragraphs:inserted,removed_paragraphs:removed,updated_tables:tables,table_changes:tableChanges,formatted_text_ranges:textRanges,other_body_content_unchanged:true};
}
export async function editWord(run,file,operations) {
  const before=await readWordBody(run,file),paths=paragraphs(before),used=new Set();
  const structural=operations.some(o=>['insert_before','insert_after','remove'].includes(o.action));
  if(structural&&before.children.some(n=>n.type==='paragraph'&&!/@paraId=/i.test(n.path)))throw new Error('正文缺少稳定段落编号，暂不支持增删；请先在 Word/WPS 中另存或仅修改现有段落。');
  const commands=operations.flatMap(operation=>{
    if(tableActions.includes(operation.action)) {
      const table=before.children.find(n=>n.path.toLowerCase()===operation.path);
      if(!table||operations.some(o=>o!==operation&&(o.path.toLowerCase()===operation.path||o.path.toLowerCase().startsWith(operation.path+'/'))))throw new Error('每个表格一次仅支持一项表格操作，不能同时编辑其内部段落；请分次读取修改。');
      return tableCommands(table,operation,before);
    }
    const node=paths.get(operation.path.toLowerCase());
    if(!node||used.has(node.path))throw new Error('目标不存在或同一段落重复操作，请重新读取并合并修改。');
    used.add(node.path);operation.path=node.path;
    if(operation.action==='format_text') {
      const [start,end]=inlineRange(node,operation.props);
      return {command:'set',path:node.path,props:{range:`${start}:${end}`,...Object.fromEntries(Object.entries(operation.props).filter(([k])=>k!=='find').map(([k,v])=>[k,String(v)]))}};
    }
    if(operation.action==='update') {
      if(operation.props.find!==undefined&&node.text.split(operation.props.find).length!==2)throw new Error('查找文字在目标段落中必须恰好出现一次。');
      return {command:'set',path:node.path,props:Object.fromEntries(Object.entries(operation.props).map(([k,v])=>[k,String(v)]))};
    }
    if(!/^\/body\/p\[/i.test(node.path))throw new Error('段落增删仅支持正文，不修改表格结构。');
    if(operation.action==='remove') {
      if(node.text!==operation.props.expected_text)throw new Error('删除段落原文不符，请重新读取。');
      return {command:'remove',path:node.path};
    }
    return {command:'add',parent:'/body',type:'paragraph',[operation.action==='insert_before'?'before':'after']:node.path,props:Object.fromEntries(Object.entries(operation.props).map(([k,v])=>[k,String(v)]))};
  });
  if(before.children.filter(n=>n.type==='paragraph').length-operations.filter(o=>o.action==='remove').length+operations.filter(o=>o.action==='insert_before'||o.action==='insert_after').length<1)throw new Error('正文须至少保留一个段落。');
  await run(['batch',file,'--stop-on-error'],commands);
  return checkWordChanges(before,await readWordBody(run,file),operations);
}
