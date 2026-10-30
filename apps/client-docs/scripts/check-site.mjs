import {readdir,readFile,stat} from 'node:fs/promises';
import {basename,dirname,resolve,relative,join,sep,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parse} from 'parse5';
import {documentationBase,documentationSite} from '../config/site.mjs';

async function outputFiles(directory) {
  const files=[];
  for(const item of await readdir(directory,{withFileTypes:true})) {
    const path=join(directory,item.name);
    if(item.isDirectory()) files.push(...await outputFiles(path));
    else files.push(path);
  }
  return files;
}

async function htmlFiles(directory) {
  return (await outputFiles(directory)).filter(file=>file.endsWith('.html'));
}

function pageData(html) {
  const ids=new Set(),links=[];
  function visit(node) {
    const attributes=new Map((node.attrs ?? []).map(attribute=>[attribute.name,attribute.value]));
    if(attributes.has('id')) ids.add(attributes.get('id'));
    if(node.tagName==='a' && attributes.has('href')) links.push(attributes.get('href'));
    if(node.tagName==='link' && /icon|stylesheet|preload/.test(attributes.get('rel') ?? '') && attributes.has('href')) links.push(attributes.get('href'));
    if(['script','img'].includes(node.tagName) && attributes.has('src')) links.push(attributes.get('src'));
    for(const child of node.childNodes ?? []) visit(child);
  }
  visit(parse(html));
  return {ids,links};
}

/** Check actual generated HTML, including links produced by the API plugin. */
export async function checkSite(directory,{base='/',site='https://docs.invalid'}={}) {
  const root=resolve(directory),prefix=documentationBase(base),origin=documentationSite(site);
  const pages=new Map();
  const errors=[];
  for(const file of await outputFiles(root)) {
    if(basename(file).toLowerCase()==='readme.md') errors.push(`Maintenance README in public output: ${relative(root,file).split(sep).join('/')}`);
    if(file.endsWith('.html')) pages.set(file,pageData(await readFile(file,'utf8')));
  }
  for(const [file,page] of pages) {
    const relativeFile=relative(root,file).split(sep).join('/');
    const route=relativeFile.endsWith('index.html') ? relativeFile.slice(0,-10) : relativeFile;
    const current=new URL(prefix+route,origin);
    for(const href of page.links) {
      if(!href) continue;
      let url;
      try {url=new URL(href,current);} catch {errors.push(`${relativeFile}: invalid link ${href}`);continue;}
      if(!['http:','https:'].includes(url.protocol) || url.origin!==origin) continue;
      if(url.pathname!==prefix.slice(0,-1) && !url.pathname.startsWith(prefix)) {
        errors.push(`${relativeFile}: link escaped deployment base: ${href}`);continue;
      }
      let target;
      try {
        const path=decodeURIComponent(url.pathname.slice(prefix.length));
        target=resolve(root,path || '.');
        const fromRoot=relative(root,target);
        if(fromRoot==='..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) throw new Error('Path escaped output');
        if((await stat(target)).isDirectory()) target=join(target,'index.html');
        if(!(await stat(target)).isFile()) throw new Error('Expected file');
      } catch {errors.push(`${relativeFile}: missing page or file: ${href}`);continue;}
      if(url.hash && pages.has(target)) {
        let anchor;
        try {anchor=decodeURIComponent(url.hash.slice(1));} catch {errors.push(`${relativeFile}: invalid section: ${href}`);continue;}
        if(anchor && !pages.get(target).ids.has(anchor)) errors.push(`${relativeFile}: missing section: ${href}`);
      }
    }
  }
  if(!pages.size) errors.push('No generated HTML pages were found');
  return errors;
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const root=resolve(dirname(fileURLToPath(import.meta.url)),'../dist');
  const errors=await checkSite(root,{base:process.env.CLIENT_DOCS_BASE,site:process.env.CLIENT_DOCS_SITE});
  const files=await htmlFiles(root);
  for(const required of ['index.html','getting-started/installation/index.html','api/index.html','pagefind/pagefind.js']) {
    try {if(!(await stat(join(root,required))).isFile()) throw new Error('Expected file');}
    catch {errors.push(`Missing built documentation artifact: ${required}`);}
  }
  if(!files.some(file=>relative(root,file).replaceAll('\\','/').startsWith('api/') && relative(root,file).toLowerCase().includes('service'))) {
    errors.push('The Node service API reference was not generated');
  }
  if(errors.length) {
    for(const error of errors.slice(0,30)) console.error(error);
    if(errors.length>30) console.error(`... ${errors.length-30} additional errors`);
    process.exitCode=1;
  } else console.log(`Documentation output verified: ${files.length} HTML pages, SDK API, search index and internal links`);
}
