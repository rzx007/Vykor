import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {registerTools} from '../tools/index.mjs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

test('official skills remain byte-identical to their pinned source and are the active skill directory',async()=>{
  const root=fileURLToPath(new URL('..',import.meta.url));
  const source=JSON.parse(await readFile(join(root,'vendor/officecli/SOURCE.json'),'utf8'));
  const manifest=JSON.parse(await readFile(join(root,'.vykor-plugin/plugin.json'),'utf8'));
  assert.equal(source.ref,'v1.0.139');assert.equal(source.files.length,4);
  assert.deepEqual(manifest.components.skills,['./skills/office-work-entry','./vendor/officecli/skills']);
  for(const file of source.files) {
    const bytes=await readFile(join(root,'vendor/officecli',file.path));
    const text=bytes.toString('utf8');
    assert.match(text,/^---\r?\n[\s\S]*?\r?\n---\r?\n/,'Skill must contain its frontmatter, not a link placeholder');
    assert.match(text,/^# .+/m,'Skill must contain Markdown instructions');
    assert.ok(bytes.length>1000,'Skill body is unexpectedly short');
    assert.equal(createHash('sha256').update(bytes).digest('hex'),file.sha256);
    assert.equal(createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'),file.git_blob_sha);
  }
});

test('official skill CLI entry is available without a shell or per-property editor schema',()=>{
  const tool=registerTools().find(t=>t.name==='OfficeCLI');
  assert.ok(tool);
  assert.ok(tool.inputSchema.properties.args);
  assert.ok(tool.inputSchema.properties.operations);
});

test('real OfficeCLI: official Word recipes append, replace, insert and remove on private copies',async()=>{
  const cwd=await mkdtemp(join(tmpdir(),'official-office-cli-'));
  const context={cwd,plugin:{root:fileURLToPath(new URL('..',import.meta.url)),dataDir:join(cwd,'data')},permissions:{filesystem:['read','write'],process:['officecli']},signal:new AbortController().signal};
  const tool=registerTools().find(t=>t.name==='OfficeCLI');assert.ok(tool);
  const invoke=input=>tool.invoke(input,{...context,deadline:Date.now()+60000});
  const call=async input=>{const r=await invoke(input);assert.notEqual(r.isError,true,r.content[0].text);return JSON.parse(r.content[0].text);};
  try {
    const help=await call({command:'help',args:['docx','paragraph','--json']});assert.match(JSON.stringify(help),/paragraph/);
    let r=await call({command:'create',path:'report.docx'});
    r=await call({command:'add',path:r.path,expected_sha256:r.sha256,args:['/body','--type','paragraph','--prop','text=原有内容 $50','--prop','style=Normal']});
    r=await call({command:'add',path:r.path,expected_sha256:r.sha256,args:['/body','--type','paragraph','--prop','text=更新时间：10.17']});
    const source=await readFile(r.path);
    // An untracked user-owned input must be copied, not overwritten.
    const {copyFile}=await import('node:fs/promises');await copyFile(r.path,join(cwd,'user.docx'));
    r=await call({command:'set',path:'user.docx',expected_sha256:r.sha256,args:['/body/p[1]/r[1]','--prop','text=替换后 $50']});
    assert.notEqual(r.path,join(cwd,'user.docx'));
    assert.deepEqual(await readFile(join(cwd,'user.docx')),source);
    r=await call({command:'add',path:r.path,expected_sha256:r.sha256,args:['/body','--type','paragraph','--index','0','--prop','text=临时开头']});
    r=await call({command:'remove',path:r.path,expected_sha256:r.sha256,args:['/body/p[1]']});
    r=await call({command:'batch',path:r.path,expected_sha256:r.sha256,scope_targets:['/body/p[1]/r[1]'],operations:[{command:'set',path:'/body/p[1]/r[1]',props:{font:'Microsoft YaHei',size:'13pt'}}]});
    const text=await call({command:'view',path:r.path,args:['text']});
    assert.match(JSON.stringify(text),/替换后 \$50/);assert.match(JSON.stringify(text),/更新时间：10.17/);assert.doesNotMatch(JSON.stringify(text),/临时开头/);
    const checked=await call({command:'validate',path:r.path});assert.equal(checked.structure_checked,true);
    assert.equal(r.structure_checked,false);assert.equal(r.scope_verified,true);
    const reviewTool=registerTools().find(t=>t.name==='OfficeWordCheck');
    const reviewed=await reviewTool.invoke({path:r.path},{...context,deadline:Date.now()+60000});
    assert.notEqual(reviewed.isError,true,reviewed.content[0].text);
    assert.equal(JSON.parse(reviewed.content[0].text).change_check.sha256,r.sha256);
    for(const bad of [
      {command:'skills',args:['install','word']},
      {command:'get',path:r.path,args:['/body','--save','outside.bin']},
      {command:'batch',path:r.path,expected_sha256:r.sha256,operations:[{command:'set',file:'other.docx',path:'/body/p[1]',props:{text:'bad'}}]},
      {command:'add',path:r.path,expected_sha256:r.sha256,args:['/body','--type','picture','--prop','src=../../outside.png']},
      {command:'set',path:r.path,expected_sha256:'0'.repeat(64),args:['/body/p[1]','--prop','text=stale']},
      {command:'set',path:r.path,expected_sha256:r.sha256,scope_targets:['/body/p[1]'],args:['/body/p[2]','--prop','text=outside scope']},
    ])assert.equal((await invoke(bad)).isError,true);
    assert.equal((await call({command:'get',path:r.path,args:['/body','--depth','1','--json']})).sha256,r.sha256);
  } finally {await rm(cwd,{recursive:true,force:true});}
});
