import {inflateRawSync} from 'node:zlib';
import {posix} from 'node:path';
import {hash} from './engine.mjs';
import {parseXml,children,canonicalXml,walkXml} from './excel-xml.mjs';

const invalid=()=>new Error('无法核对 PPTX 页面差异：文件包结构不受支持或已损坏，未保存修改。');

function xmlDigest(data,name) {
  let text=data.toString('utf8');
  if(name==='docProps/custom.xml') text=text.replace(/(<(?:[\w.-]+:)?property\b[^>]*\bname=["']OfficeCLI\.LastModified["'][^>]*>\s*<(?:[\w.-]+:)?lpwstr\b[^>]*>)[^<]*(<\/(?:[\w.-]+:)?lpwstr>)/g,'$1[SAVE_TIME]$2');
  // OfficeCLI hoists repeated namespace declarations to the slide root on save.
  // Ignore only their placement, retaining each prefix/URI binding. Ambiguous
  // prefix rebinding falls back to strict comparison rather than hiding changes.
  const bindings=new Map();let rebound=false;
  const body=text.replace(/<[A-Za-z_](?:[^<>"']|"[^"]*"|'[^']*')*>/g,tag=>tag.replace(/\s+([\w:.-]+)\s*=\s*(["'])(.*?)\2/gs,(attribute,key,quote,uri)=>{
    if(key!=='xmlns'&&!key.startsWith('xmlns:')) return attribute;
    const prefix=key==='xmlns'?'':key.slice(6);
    if(bindings.has(prefix)&&bindings.get(prefix)!==uri) rebound=true;
    bindings.set(prefix,uri);return '';
  }));
  return hash(rebound?text:JSON.stringify([...bindings].sort(([a],[b])=>a.localeCompare(b)))+'\n'+body);
}

// Read package entries in memory. Compare uncompressed bytes, so ZIP timestamps,
// compression and entry order do not masquerade as document changes.
export function snapshotPptx(bytes) {
  try {
    let end=-1;
    for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--) {
      if(bytes.readUInt32LE(i)===0x06054b50 && i+22+bytes.readUInt16LE(i+20)===bytes.length){end=i;break;}
    }
    if(end<0 || bytes.readUInt16LE(end+4)!==0 || bytes.readUInt16LE(end+6)!==0) throw invalid();
    const count=bytes.readUInt16LE(end+10), size=bytes.readUInt32LE(end+12), start=bytes.readUInt32LE(end+16);
    if(count>10000 || count!==bytes.readUInt16LE(end+8) || start+size!==end) throw invalid();
    const parts=new Map(), xml=new Map();let cursor=start,total=0;
    for(let i=0;i<count;i++) {
      if(cursor+46>end || bytes.readUInt32LE(cursor)!==0x02014b50) throw invalid();
      const flags=bytes.readUInt16LE(cursor+8), method=bytes.readUInt16LE(cursor+10), packed=bytes.readUInt32LE(cursor+20), unpacked=bytes.readUInt32LE(cursor+24);
      const nameLength=bytes.readUInt16LE(cursor+28), extra=bytes.readUInt16LE(cursor+30), comment=bytes.readUInt16LE(cursor+32), local=bytes.readUInt32LE(cursor+42);
      const next=cursor+46+nameLength+extra+comment;
      if(next>end || flags&1 || ![0,8].includes(method) || (total+=unpacked)>256*1024*1024 || local+30>start || bytes.readUInt32LE(local)!==0x04034b50) throw invalid();
      const name=bytes.subarray(cursor+46,cursor+46+nameLength).toString('utf8');
      if(parts.has(name) || name.includes('\\') || name.startsWith('/') || name.split('/').includes('..')) throw invalid();
      const dataStart=local+30+bytes.readUInt16LE(local+26)+bytes.readUInt16LE(local+28);
      if(dataStart+packed>start) throw invalid();
      const packedBytes=bytes.subarray(dataStart,dataStart+packed);
      const data=method===0?packedBytes:inflateRawSync(packedBytes,{maxOutputLength:Math.max(1,unpacked)});
      if(data.length!==unpacked) throw invalid();
      parts.set(name,name.endsWith('.xml')||name.endsWith('.rels')?xmlDigest(data,name):hash(data));
      if(name==='ppt/presentation.xml'||name==='ppt/_rels/presentation.xml.rels'||/^ppt\/slides\/[^/]+\.xml$/.test(name)) xml.set(name,data.toString('utf8'));
      cursor=next;
    }
    if(cursor!==end) throw invalid();
    const presentation=xml.get('ppt/presentation.xml'), relationships=xml.get('ppt/_rels/presentation.xml.rels');
    if(!presentation || !relationships) throw invalid();
    // Relationship IDs and paths are package identifiers, never external files.
    const attrs=tag=>Object.fromEntries([...tag.matchAll(/([\w:.-]+)\s*=\s*(["'])(.*?)\2/gs)].map(m=>[m[1],m[3]]));
    const targets=new Map();
    for(const tag of relationships.match(/<(?:[\w.-]+:)?Relationship\b[^>]*>/g)??[]) {
      const a=attrs(tag);
      if(a.TargetMode==='External') continue;
      const path=posix.normalize(a.Target?.startsWith('/')?a.Target.slice(1):posix.join('ppt',a.Target??''));
      targets.set(a.Id,path);
    }
    const pages=(presentation.match(/<(?:[\w.-]+:)?sldId\b[^>]*>/g)??[]).map(tag=>{
      const a=attrs(tag), id=Object.entries(a).find(([key])=>key.endsWith(':id'))?.[1], path=targets.get(id);
      if(!path || !parts.has(path) || !path.startsWith('ppt/slides/')) throw invalid();
      return path;
    });
    if(!pages.length || new Set(pages).size!==pages.length) throw invalid();
    return {parts,pages,xml};
  } catch {throw invalid();}
}

export function checkPageDiff(before,after,requestedPages) {
  const requested=[...new Set(requestedPages)].sort((a,b)=>a-b);
  if(!requested.length || requested.some(page=>!Number.isSafeInteger(page)||page<1||page>before.pages.length)) throw new Error('修改页码无效，未保存修改。');
  if(JSON.stringify(before.pages)!==JSON.stringify(after.pages)) throw new Error('局部修改改变了页数或页序，未保存修改。');
  const changed=before.pages.flatMap((path,i)=>before.parts.get(path)!==after.parts.get(path)?[i+1]:[]);
  const unexpected=changed.filter(page=>!requested.includes(page));
  if(unexpected.length) throw new Error(`局部修改影响了未请求的第 ${unexpected.join('、')} 页，未保存修改。`);
  const allowed=new Set(requested.map(page=>before.pages[page-1]));
  // Core properties contain save timestamps, not page content. Everything else
  // outside the requested slide XML stays protected, including shared assets,
  // slide relationships, masters, themes, notes, and presentation ordering.
  allowed.add('docProps/core.xml');
  const other=[...new Set([...before.parts.keys(),...after.parts.keys()])].filter(path=>!allowed.has(path)&&before.parts.get(path)!==after.parts.get(path));
  if(other.length) throw new Error(`局部修改改变了共享或其他文件（${other.slice(0,5).join('、')}），无法确认其他页面不受影响，未保存修改。`);
  return {checked:true,requested_pages:requested,changed_pages:changed,unchanged_pages:before.pages.flatMap((_,i)=>changed.includes(i+1)?[]:[i+1])};
}

// The page guard protects the package; this guard also protects neighboring
// objects within a requested page. A table remains one object (not a cell audit).
export function checkObjectDiff(before,after,operations) {
  const groups=new Map();
  for(const operation of operations) {
    const m=operation.path.match(/^\/slide\[(\d+)\](?:\/(shape|table|picture)\[(?:@id=(\d+)|(\d+))\])?/);
    if(!m||(!m[2]&&operation.path!==m[0]))throw new Error('无法核对请求对象路径，未保存修改。');
    const page=Number(m[1]);if(!groups.has(page))groups.set(page,[]);groups.get(page).push(m);
  }
  const checked=[];
  const kind=node=>node.name==='sp'?'shape':node.name==='pic'?'picture':node.name==='graphicFrame'&&find(node,'tbl')?'table':null;
  const find=(node,name)=>{let result;walkXml(node,n=>{if(!result&&n.name===name)result=n;});return result;};
  for(const [page,requests] of groups) {
    if(requests.some(m=>!m[2]))continue; // Explicit slide-wide edits authorize that page.
    const source=before.xml?.get(before.pages[page-1]),saved=after.xml?.get(after.pages[page-1]);
    if(!source||!saved)throw new Error('无法读取页面对象结构，未保存修改。');
    const a=parseXml(source),b=parseXml(saved),treeA=find(a,'spTree'),treeB=find(b,'spTree');
    if(!treeA||!treeB)throw new Error('页面对象结构不完整，未保存修改。');
    const objects=children(treeA).filter(n=>kind(n)),allowed=new Set();
    for(const m of requests) {
      const candidates=objects.filter(n=>kind(n)===m[2]);
      const object=m[3]?candidates.find(n=>find(n,'cNvPr')?.attrs.id===m[3]):candidates[Number(m[4])-1];
      if(!object)throw new Error(`第 ${page} 页请求对象不存在，未保存修改。`);
      const id=find(object,'cNvPr')?.attrs.id;
      if(!id)throw new Error('请求对象缺少唯一标识，未保存修改。');
      allowed.add(id);
    }
    const mask=tree=>{
      const seen=new Set();
      tree.children=tree.children.map(n=>{
        if(typeof n==='string'||!kind(n))return n;
        const id=find(n,'cNvPr')?.attrs.id;
        if(!allowed.has(id))return n;
        if(seen.has(id))throw new Error('页面对象标识重复，未保存修改。');
        seen.add(id);return {...n,attrs:{},attrNames:{},children:[id]};
      });
      if(seen.size!==allowed.size)throw new Error('请求对象缺失，未保存修改。');
    };
    mask(treeA);mask(treeB);
    if(canonicalXml(a)!==canonicalXml(b))throw new Error(`局部修改影响了第 ${page} 页未请求的对象或页面设置，未保存修改。`);
    checked.push(page);
  }
  return {scope:'slide_objects',checked_pages:checked,whole_slide_pages:[...groups.keys()].filter(p=>!checked.includes(p)),other_objects_unchanged:checked.length===groups.size};
}
