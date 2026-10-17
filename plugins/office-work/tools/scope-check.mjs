import {readOfficeParts} from './office-package.mjs';
import {snapshotPptx,checkPageDiff,checkObjectDiff} from './page-diff.mjs';
import {preserveWorkbook} from './excel-preservation.mjs';
import {excelTarget,column} from './excel-content.mjs';
import {parseXml,canonicalXml,children,walkXml} from './excel-xml.mjs';
function maskWord(root,target) {
  if(typeof target!=='string'||!/^\/body(?:\/[a-zA-Z]+\[(?:[1-9]\d*|@paraId=[a-fA-F0-9]{8})\])*$/.test(target))throw new Error('范围路径须为正文实际 XML 路径。');
  let node=root;
  for(const segment of target.slice(1).split('/')) {
    const match=segment.match(/^([a-zA-Z]+)(?:\[(.+)\])?$/),list=children(node,match[1]);
    node=match[2]?.startsWith('@paraId=')?list.find(n=>Object.entries(n.attrs).some(([key,v])=>key.endsWith(':paraId')&&v.toLowerCase()===match[2].slice(8).toLowerCase())):list[Number(match[2]??1)-1];
    if(!node)throw new Error(`范围路径不存在：${target}`);
  }
  node.attrs={};node.attrNames={};node.children=[];
}
export function wordDocumentScope(before,after,targets) {
  const a=parseXml(before),b=parseXml(after);
  // textId is generated edit bookkeeping, not text or formatting. A run edit
  // updates its parent paragraph's textId even when every sibling is preserved.
  for(const root of [a,b])walkXml(root,n=>{for(const [key,full] of Object.entries(n.attrNames))if(full==='{http://schemas.microsoft.com/office/word/2010/wordml}textId')delete n.attrs[key];});
  for(const target of targets)if(targets.some(t=>t!==target&&target.startsWith(t+'/')))throw new Error('范围路径不能重叠。');
  for(const target of targets){maskWord(a,target);maskWord(b,target);}
  if(canonicalXml(a)!==canonicalXml(b))throw new Error('Word 修改影响了指定范围外的正文、控件或节设置，未保存。');
}
export function scopeSnapshot(extension,bytes) {
  return {extension,data:extension==='.pptx'?snapshotPptx(bytes):readOfficeParts(bytes,extension==='.docx'?'word/document.xml':'xl/workbook.xml')};
}
const stableXml=(name,value)=>{
  const root=parseXml(value);
  if(name==='docProps/custom.xml')walkXml(root,n=>{n.children=n.children.filter(c=>typeof c==='string'||c.attrs.name!=='OfficeCLI.LastModified');});
  return canonicalXml(root);
};
export function checkScope(before,after,targets) {
  if(!Array.isArray(targets)||!targets.length||targets.length>100||targets.some(p=>typeof p!=='string'||p.length>240)||new Set(targets).size!==targets.length)throw new Error('scope_targets 须为 1–100 个不同的实际路径。');
  let detail;
  if(before.extension==='.pptx') {
    const pages=targets.map(p=>Number(/^\/slide\[(\d+)\]/.exec(p)?.[1]));
    detail={...checkPageDiff(before.data,after.data,pages),...checkObjectDiff(before.data,after.data,targets.map(path=>({path})))};
  } else if(before.extension==='.xlsx') {
    const cells=new Set(),col=s=>[...s].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0);
    for(const path of targets) {
      excelTarget(path);const m=path.match(/^\/([^/]+)\/([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/);
      if(!m)throw new Error('Excel 范围核对仅接受单元格或矩形区域，不核对结构重排。');
      for(let r=Number(m[3]);r<=Number(m[5]??m[3]);r++)for(let c=col(m[2]);c<=col(m[4]??m[2]);c++){cells.add(`/${m[1]}/${column(c-1)}${r}`);if(cells.size>2000)throw new Error('范围核对最多 2000 格。');}
    }
    detail={scope:'xlsx_cells_and_package',...preserveWorkbook(before.data,after.data,{cells:[...cells]})};
  } else {
    const a=before.data,b=after.data;
    wordDocumentScope(a.get('word/document.xml'),b.get('word/document.xml'),targets);
    for(const name of new Set([...a.keys(),...b.keys()])) {
      if(name==='word/document.xml'||name==='docProps/core.xml')continue;
      if(!a.has(name)||!b.has(name))throw new Error(`Word 范围外文件部件变化：${name}，未保存。`);
      if(/\.(xml|rels)$/.test(name)?stableXml(name,a.get(name))!==stableXml(name,b.get(name)):a.rawHashes.get(name)!==b.rawHashes.get(name))throw new Error(`Word 范围外文件部件变化：${name}，未保存。`);
    }
    detail={scope:'word_document_paths_and_package'};
  }
  return {checked:true,requested_targets:targets,...detail};
}
