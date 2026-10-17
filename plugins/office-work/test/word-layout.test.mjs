import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {deflateSync} from 'node:zlib';
import {registerWordTools} from '../tools/word.mjs';
import {wordEdits} from '../tools/word-edit.mjs';
import {buildWordContent} from '../tools/word-content.mjs';
import {pageSettings} from '../tools/word-page-settings.mjs';
import {wordImage,prepareWordImages} from '../tools/word-images.mjs';
import {hash} from '../tools/engine.mjs';

function png() {
  const crc=data=>{let c=0xffffffff;for(const b of data){c^=b;for(let i=0;i<8;i++)c=c>>>1^(c&1?0xedb88320:0);}return (c^0xffffffff)>>>0;};
  const chunk=(name,data)=>{const tag=Buffer.from(name),length=Buffer.alloc(4),sum=Buffer.alloc(4);length.writeUInt32BE(data.length);sum.writeUInt32BE(crc(Buffer.concat([tag,data])));return Buffer.concat([length,tag,data,sum]);};
  const header=Buffer.alloc(13);header.writeUInt32BE(64);header.writeUInt32BE(32,4);header[8]=8;header[9]=2;
  const pixels=Buffer.alloc(32*(64*3+1));
  for(let y=0;y<32;y++)for(let x=0;x<64;x++){const at=y*193+1+x*3;pixels[at]=x<32?37:245;pixels[at+1]=x<32?99:158;pixels[at+2]=x<32?235:11;}
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
}
test('Word report exposes bounded pagination, page settings and captioned image blocks',()=>{
  const ops=buildWordContent({title:'报告',blocks:[{type:'paragraph',text:'第二章',style:'Heading1',pageBreakBefore:true,keepNext:true,keepLines:true},{type:'image',src:'chart.png',caption:'图 1',source:'测试数据'}]});
  assert.equal(ops.find(o=>o.props?.text==='第二章').props.pageBreakBefore,'true');
  assert.ok(ops.some(o=>o.type==='picture'&&o.parent==='/body/p[3]'));
  assert.ok(ops.some(o=>o.props?.text==='来源：测试数据'));
  assert.equal(wordEdits({expected_sha256:'a'.repeat(64),operations:[{path:'/body/p[1]',props:{pageBreakBefore:false,keepLines:true}}]})[0].props.pageBreakBefore,false);
  assert.throws(()=>pageSettings({header:'多\n行',footer:'',page_numbers:true}),/单行/);
  assert.throws(()=>pageSettings({header:'a',page_numbers:true}),/页眉页脚/);
  assert.throws(()=>wordImage({src:'x.png',caption:'图',source:'来源',width:'20cm'}),/尺寸/);
});
test('Word images are copied, hash-bound and fitted to the requested box',async()=>{
  const cwd=await mkdtemp(join(tmpdir(),'office-word-image-'));
  try {
    const bytes=png();await writeFile(join(cwd,'chart.png'),bytes);
    const context={cwd},ops=[{type:'picture',parent:'/body/p[1]',props:{src:'chart.png',width:'6cm',height:'4cm',alt:'图'}}];
    const sources=await prepareWordImages(ops,context,join(cwd,'working.docx'));
    assert.equal(sources[0].width_cm,6);assert.equal(sources[0].height_cm,3);assert.equal(sources[0].source_sha256,hash(bytes));
    assert.notEqual(ops[0].props.src,join(cwd,'chart.png'));assert.deepEqual(await readFile(ops[0].props.src),bytes);
    await assert.rejects(()=>prepareWordImages([{type:'picture',props:{src:'https://example.invalid/image.png'}}],context,join(cwd,'working.docx')),/本地/);
    await writeFile(join(cwd,'bad.png'),'not an image');
    await assert.rejects(()=>prepareWordImages([{type:'picture',props:{src:'bad.png'}}],context,join(cwd,'working.docx')),/PNG\/JPEG/);
    await writeFile(join(cwd,'wrong.jpg'),bytes);
    await assert.rejects(()=>prepareWordImages([{type:'picture',props:{src:'wrong.jpg'}}],context,join(cwd,'working.docx')),/扩展名/);
  }finally{await rm(cwd,{recursive:true,force:true});}
});
test('real OfficeCLI: Word pagination, default stories, PAGE fields and image edits preserve the source',async()=>{
  const cwd=await mkdtemp(join(tmpdir(),'office-word-layout-'));
  const context={cwd,plugin:{root:resolve('plugins/office-work'),dataDir:join(cwd,'data')},permissions:{filesystem:['read','write'],process:['officecli']},signal:new AbortController().signal};
  const tools=Object.fromEntries(registerWordTools().map(t=>[t.name,t]));
  const call=(name,input)=>tools[name].invoke(input,{...context,deadline:Date.now()+60000});
  const parsed=r=>{assert.notEqual(r.isError,true,r.content[0].text);return JSON.parse(r.content[0].text);};
  try {
    await writeFile(join(cwd,'chart.png'),png());
    let current=parsed(await call('OfficeWordCreate',{path:'report.docx',title:'报告排版验收',page_settings:{header:'测试报告',footer:'内部资料',page_numbers:true},blocks:[{type:'paragraph',text:'第一章',style:'Heading1'},{type:'paragraph',text:'保留第一章正文。'},{type:'image',src:'chart.png',width:'6cm',height:'4cm',caption:'图 1：双色示例',source:'自动化测试生成'},{type:'paragraph',text:'第二章',style:'Heading1',pageBreakBefore:true,keepNext:true,keepLines:true},{type:'paragraph',text:'保留第二章正文。'}]}));
    assert.equal(current.page_settings.page_number_field,'PAGE');assert.equal(current.page_settings.sha256,current.sha256);
    assert.equal(current.image_sources[0].height_cm,3);assert.equal(current.image_sources[0].source_sha256,hash(png()));
    const read=async(target,depth=4)=>parsed(await call('OfficeWordRead',{path:current.path,target,depth}));
    const initial=(await read('/body')).document.data.results[0];
    const chapter=initial.children.find(n=>n.text==='第二章'),anchor=initial.children.find(n=>n.text==='保留第二章正文。');
    assert.equal(chapter.format.pageBreakBefore,true);assert.equal(chapter.format.keepNext,true);
    const footer=(await read('/footer[1]')).document.data.results[0];
    assert.ok(footer.children[0].children.some(n=>n.type==='instrText'&&n.text.trim()==='PAGE'));
    const preview=parsed(await call('OfficeWordPreview',{path:current.path,page:2}));assert.equal(preview.page,2);
    const edit=async op=>{const sha=current.sha256;current=parsed(await call('OfficeWordEdit',{path:current.path,expected_sha256:sha,operations:[op]}));assert.equal(current.change_check.source_sha256,sha);assert.equal(current.change_check.sha256,current.sha256);};
    await edit({action:'page_settings',path:'/body/sectPr[1]',props:{header:'更新后的页眉',footer:'仅测试',page_numbers:true}});
    const bodyAfter=(await read('/body')).document.data.results[0];
    assert.deepEqual(bodyAfter.children.filter(n=>n.type!=='section'),initial.children.filter(n=>n.type!=='section'));
    assert.equal((await read('/header[1]')).document.data.results[0].text,'更新后的页眉');
    await edit({action:'insert_image',path:anchor.path,props:{src:'chart.png',width:'4cm',height:'3cm',caption:'图 2：局部插图',source:'同一测试图片'}});
    assert.equal(current.image_sources[0].width_cm,4);assert.equal(current.change_check.inserted_paragraphs.length,3);
    const saved=await readFile(current.path);
    assert.equal((await call('OfficeWordEdit',{path:current.path,expected_sha256:current.sha256,operations:[{action:'insert_image',path:anchor.path,props:{src:'missing.png',caption:'不能插入',source:'错误路径'}}]})).isError,true);
    assert.deepEqual(await readFile(current.path),saved);
    await edit({action:'update',path:chapter.path,props:{pageBreakBefore:false,keepNext:false,keepLines:false}});
    assert.equal(Boolean((await read(chapter.path)).document.data.results[0].format.pageBreakBefore),false);
    await edit({action:'page_settings',path:'/body/sectPr[1]',props:{header:'',footer:'',page_numbers:false}});
    assert.equal((await call('OfficeWordRead',{path:current.path,target:'/header[1]'})).isError,true);
    assert.equal((await call('OfficeWordRead',{path:current.path,target:'/footer[1]'})).isError,true);
    const final=parsed(await call('OfficeWordCheck',{path:current.path}));assert.equal(final.structure_checked,true);assert.equal(final.page_settings.sha256,current.sha256);
    assert.equal((await readdir(cwd)).some(n=>n.startsWith('.office-work-')||n.endsWith('.office-work.lock')),false);
  }finally{await rm(cwd,{recursive:true,force:true});}
});
