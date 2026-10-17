import {test} from 'node:test';
import assert from 'node:assert/strict';
import {wordDocumentScope} from '../tools/scope-check.mjs';
import {registerTools} from '../tools/index.mjs';
test('only one editing entry remains alongside document checks and delivery records',()=>{
  const names=registerTools().map(t=>t.name);
  assert.equal(names.length,10);assert.ok(names.includes('OfficeCLI'));
  assert.equal(names.some(n=>/(Create|Read|Edit)$/.test(n)),false);
  for(const format of ['Word','Ppt','Excel'])for(const action of ['Check','Preview','Review'])assert.ok(names.includes('Office'+format+action));
});
test('Word scope protects unrequested paragraphs, formatting, controls and section settings',()=>{
  const doc=(a,b,tag='old',width='11906')=>`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${a}</w:t></w:r></w:p><w:p><w:r><w:t>${b}</w:t></w:r></w:p><w:sdt><w:sdtPr><w:tag w:val="${tag}"/></w:sdtPr></w:sdt><w:sectPr><w:pgSz w:w="${width}"/></w:sectPr></w:body></w:document>`;
  assert.doesNotThrow(()=>wordDocumentScope(doc('a','b'),doc('changed','b'),['/body/p[1]']));
  for(const after of [doc('changed','wrong'),doc('changed','b','wrong'),doc('changed','b','old','10000')])assert.throws(()=>wordDocumentScope(doc('a','b'),after,['/body/p[1]']),/范围|未请求/);
  assert.throws(()=>wordDocumentScope(doc('a','b'),doc('a','b'),['/body/p[9]']),/路径/);
  const metadata=(id,text)=>`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"><w:body><w:p w14:textId="${id}"><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`;
  assert.doesNotThrow(()=>wordDocumentScope(metadata('00100001','a'),metadata('00100002','b'),['/body/p[1]/r[1]']));
  assert.throws(()=>wordDocumentScope(metadata('00100001','a'),metadata('00100002','b'),['/body/p[1]/r[1]/rPr[1]']),/路径/);
});
