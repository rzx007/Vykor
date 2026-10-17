import {test} from 'node:test';
import assert from 'node:assert/strict';
import {deflateRawSync} from 'node:zlib';
import {snapshotPptx, checkPageDiff,checkObjectDiff} from '../tools/page-diff.mjs';

// Small in-memory ZIPs isolate package changes from OfficeCLI serialization.
function zip(parts, compressed=false) {
  const local=[], central=[]; let offset=0;
  for (const [path,value] of parts) {
    const name=Buffer.from(path), raw=Buffer.from(value), data=compressed?deflateRawSync(raw):raw;
    const header=Buffer.alloc(30);header.writeUInt32LE(0x04034b50);header.writeUInt16LE(compressed?8:0,8);header.writeUInt32LE(data.length,18);header.writeUInt32LE(raw.length,22);header.writeUInt16LE(name.length,26);
    local.push(header,name,data);
    const entry=Buffer.alloc(46);entry.writeUInt32LE(0x02014b50);entry.writeUInt16LE(compressed?8:0,10);entry.writeUInt32LE(data.length,20);entry.writeUInt32LE(raw.length,24);entry.writeUInt16LE(name.length,28);entry.writeUInt32LE(offset,42);
    central.push(entry,name);offset+=header.length+name.length+data.length;
  }
  const directory=Buffer.concat(central), end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(parts.size,8);end.writeUInt16LE(parts.size,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...local,directory,end]);
}
function deck() {return new Map([
  ['ppt/presentation.xml','<p:presentation><p:sldIdLst><p:sldId id="21" r:id="rB"/><p:sldId id="22" r:id="rA"/></p:sldIdLst></p:presentation>'],
  ['ppt/_rels/presentation.xml.rels','<Relationships><Relationship Id="rA" Target="slides/slide1.xml"/><Relationship Id="rB" Target="slides/slide7.xml"/></Relationships>'],
  ['ppt/slides/slide7.xml','first page'],['ppt/slides/slide1.xml','second page'],
  ['ppt/media/image1.png','shared image'],['docProps/core.xml','timestamp'],
]);}
const snapshot=(parts,compressed=false)=>snapshotPptx(zip(parts,compressed));

test('PPT requested objects do not authorize changes to their neighbors on the same slide',()=>{
  const slide=(a,b)=>`<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="a"/></p:nvSpPr><p:txBody>${a}</p:txBody></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="b"/></p:nvSpPr><p:txBody>${b}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
  const snap=(a,b)=>({pages:['ppt/slides/slide1.xml'],xml:new Map([['ppt/slides/slide1.xml',slide(a,b)]])});
  const ops=[{path:'/slide[1]/shape[@id=2]',props:{text:'new'}}];
  assert.equal(checkObjectDiff(snap('old','keep'),snap('new','keep'),ops).other_objects_unchanged,true);
  assert.throws(()=>checkObjectDiff(snap('old','keep'),snap('new','wrong'),ops),/对象/);
  assert.throws(()=>checkObjectDiff(snap('old','keep'),snap('new','keep'),[{path:'/slide[1]/shape[@id=9]'}]),/对象/);
  assert.throws(()=>checkObjectDiff(snap('old','keep'),snap('new','keep'),[{path:'/slide[1]/paragraph[1]'}]),/路径/);
  const whole=checkObjectDiff(snap('old','keep'),snap('new','wrong'),[{path:'/slide[1]'}]);
  assert.equal(whole.other_objects_unchanged,false);assert.deepEqual(whole.whole_slide_pages,[1]);
});

test('page numbers follow presentation order, not slide filenames; repacking is ignored',()=>{
  const before=deck(), after=new Map(before);after.set('ppt/slides/slide1.xml','changed style');after.set('docProps/core.xml','new timestamp');
  assert.deepEqual(checkPageDiff(snapshot(before),snapshot(after,true),[2]),{checked:true,requested_pages:[2],changed_pages:[2],unchanged_pages:[1]});
});
test('unchanged edit reports no actual page changes',()=>{
  assert.deepEqual(checkPageDiff(snapshot(deck()),snapshot(deck(),true),[2]).changed_pages,[]);
});
test('namespace declaration relocation and the engine save timestamp are ignored',()=>{
  const before=deck(), after=deck();
  before.set('ppt/slides/slide7.xml','<p:sld xmlns:p="presentation"><a:shape xmlns:a="drawing" color="red">keep</a:shape></p:sld>');
  after.set('ppt/slides/slide7.xml','<p:sld xmlns:a="drawing" xmlns:p="presentation"><a:shape color="red">keep</a:shape></p:sld>');
  before.set('docProps/custom.xml','<op:property name="OfficeCLI.LastModified"><vt:lpwstr>old</vt:lpwstr></op:property>');
  after.set('docProps/custom.xml','<op:property name="OfficeCLI.LastModified"><vt:lpwstr>new</vt:lpwstr></op:property>');
  assert.deepEqual(checkPageDiff(snapshot(before),snapshot(after),[2]).changed_pages,[]);
  after.set('ppt/slides/slide7.xml',after.get('ppt/slides/slide7.xml').replace('red','blue'));
  assert.throws(()=>checkPageDiff(snapshot(before),snapshot(after),[2]),/第 1 页/);
});
test('namespace URI and ordinary custom-property changes remain protected',()=>{
  const before=deck(), after=deck();
  before.set('ppt/slides/slide7.xml','<p:sld xmlns:p="presentation">keep</p:sld>');
  after.set('ppt/slides/slide7.xml','<p:sld xmlns:p="different">keep</p:sld>');
  assert.throws(()=>checkPageDiff(snapshot(before),snapshot(after),[2]),/第 1 页/);
  after.set('ppt/slides/slide7.xml',before.get('ppt/slides/slide7.xml'));
  before.set('docProps/custom.xml','<property name="BusinessValue">one</property>');
  after.set('docProps/custom.xml','<property name="BusinessValue">two</property>');
  assert.throws(()=>checkPageDiff(snapshot(before),snapshot(after),[2]),/共享或其他文件/);
});
test('namespace-like strings in slide text remain protected',()=>{
  const before=deck(), after=deck();
  before.set('ppt/slides/slide7.xml','<a:t>example xmlns:a="one"</a:t>');
  after.set('ppt/slides/slide7.xml','<a:t>example xmlns:a="two"</a:t>');
  assert.throws(()=>checkPageDiff(snapshot(before),snapshot(after),[2]),/第 1 页/);
});
test('unrequested page changes are rejected',()=>{
  const after=deck();after.set('ppt/slides/slide7.xml','unexpected');
  assert.throws(()=>checkPageDiff(snapshot(deck()),snapshot(after),[2]),/第 1 页/);
});
test('changes to shared resources and added parts are rejected',()=>{
  for(const part of ['ppt/media/image1.png','ppt/theme/theme1.xml']) {
    const after=deck();after.set(part,'unexpected');
    assert.throws(()=>checkPageDiff(snapshot(deck()),snapshot(after),[2]),/共享或其他文件/);
  }
});
test('page order, count, and invalid target pages are rejected',()=>{
  const after=deck();after.set('ppt/presentation.xml',after.get('ppt/presentation.xml').replace('rB','rC').replace('rA','rB').replace('rC','rA'));
  assert.throws(()=>checkPageDiff(snapshot(deck()),snapshot(after),[2]),/页数或页序/);
  assert.throws(()=>checkPageDiff(snapshot(deck()),snapshot(deck()),[3]),/修改页码/);
});
test('malformed ZIPs cannot be treated as a successful comparison',()=>{
  assert.throws(()=>snapshotPptx(Buffer.from('not a zip')),/PPTX/);
});
