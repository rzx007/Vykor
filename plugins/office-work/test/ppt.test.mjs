import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, copyFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { registerTools } from '../tools/index.mjs';

const root = resolve('plugins/office-work');
const parse = r => { assert.notEqual(r.isError, true, r.content[0].text); return JSON.parse(r.content[0].text); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

test('real OfficeCLI: editable objects, exact read paths, safe revisions and rollback', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'office-work-'));
  const context = { cwd, plugin: { root, dataDir: join(cwd, 'data') }, permissions: { filesystem: ['read','write'], process: ['officecli'] }, signal: new AbortController().signal, deadline: Date.now() + 120000 };
  const tools = Object.fromEntries(registerTools().map(t => [t.name, t]));
  const call = (name, input) => tools[name].invoke(input, { ...context, deadline: Date.now()+60000 });
  try {
    await writeFile(join(cwd,'pixel.png'),Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=','base64'));
    const created = parse(await call('OfficePptCreate', { path: 'demo.pptx', slides: [
      { title: '第一页', body: '保留内容', images:[{src:'pixel.png',x:'25cm',y:'12cm',width:'1cm',height:'1cm'}] },
      { title: '第二页', shapes: [{ text: '待修改', name: 'editable', x: '1cm', y: '3cm', width: '8cm', height: '2cm' }], tables: [{ rows: [['方案','状态'],['一','重要边界说明，需要保留原子写入和迁移限制，不可直接删除。']], x:'1cm',y:'6cm',width:'20cm',colWidths:'6cm,14cm' }] },
      { title: '第三页', body: '其他页面保持不变' },
    ] }));
    const before = await readFile(created.path);
    const read = parse(await call('OfficePptRead', { path: created.path, target: '/slide[2]' }));
    const shape = read.document.data.results[0].children.find(c => c.text === '待修改');
    assert.ok(shape?.path.includes('@id='));
    const edited = parse(await call('OfficePptEdit', { path: created.path, expected_sha256: read.sha256, operations: [{ path: shape.path, props: { text: '修改完成' } }] }));
    assert.equal(edited.path, created.path);
    assert.deepEqual(edited.page_diff,{checked:true,requested_pages:[2],changed_pages:[2],unchanged_pages:[1,3]});
    assert.deepEqual(JSON.parse(await readFile(join(context.plugin.dataDir,'presentations',digest(created.path.toLowerCase())+'.json'),'utf8')).page_diff,edited.page_diff);
    const after = parse(await call('OfficePptRead', { path: edited.path, target: shape.path }));
    assert.equal(after.document.data.results[0].text, '修改完成');
    assert.match(JSON.stringify(parse(await call('OfficePptRead', {path:edited.path,target:'/slide[1]'}))), /保留内容/);
    const parallel=await Promise.all([
      call('OfficePptCheck',{path:edited.path}),
      call('OfficePptRead',{path:edited.path,target:'/slide[2]/table[1]/tr[2]'}),
      call('OfficePptRead',{path:edited.path,target:'/slide[2]/table[1]/tr[2]/tc[2]'}),
    ]);
    assert.match(JSON.stringify(parse(parallel[0])),/Validation passed/);
    const row=parse(parallel[1]).document.data.results[0];
    assert.ok(parseFloat(row.format.height)>1.1,'long row needs more than default ~1cm height');
    assert.equal(parse(parallel[2]).document.data.results[0].format.size,'16pt');
    const valid = await readFile(edited.path);
    const owner=join(cwd,'~$demo.pptx');await writeFile(owner,'PowerPoint');
    const occupied=await call('OfficePptRead',{path:edited.path});
    assert.equal(JSON.parse(occupied.content[0].text).code,'office_file_in_use');
    assert.deepEqual(await readFile(edited.path),valid);
    await rm(owner);
    const bad = await call('OfficePptEdit', { path: edited.path, expected_sha256: after.sha256, operations: [
      {path:shape.path,props:{text:'这项也不能落盘'}},
      {path:'/slide[99]/shape[1]',props:{text:'破坏'}},
    ] });
    assert.equal(bad.isError, true);
    assert.equal(digest(await readFile(edited.path)), digest(valid));
    assert.equal((await call('OfficePptEdit', {path:edited.path,expected_sha256:digest(before),operations:[{path:shape.path,props:{text:'过期'}}]})).isError,true);
    await copyFile(edited.path, join(cwd, 'user.pptx'));
    const original = await readFile(join(cwd, 'user.pptx'));
    const copy = parse(await call('OfficePptEdit', {path:'user.pptx',expected_sha256:digest(original),operations:[{path:shape.path,props:{text:'副本'}}]}));
    assert.notEqual(copy.path, join(cwd,'user.pptx'));
    assert.deepEqual(await readFile(join(cwd,'user.pptx')),original);
    assert.equal((await call('OfficePptCreate',{path:'demo.pptx',slides:[{title:'覆盖'}]})).isError,true);
    assert.equal((await call('OfficePptRead',{path:resolve(cwd,'../outside.pptx')})).isError,true);
    assert.equal((await call('OfficePptRead',{path:edited.path,target:'--save=bad'})).isError,true);
    assert.equal((await call('OfficePptEdit',{path:edited.path,expected_sha256:after.sha256,operations:[{path:shape.path,props:{src:'https://example.com'}}]})).isError,true);
    assert.equal((await tools.OfficePptCheck.invoke({path:edited.path},{...context,permissions:{}})).isError,true);
    const controller=new AbortController(); controller.abort();
    assert.equal((await tools.OfficePptEdit.invoke({path:edited.path,expected_sha256:after.sha256,operations:[{path:shape.path,props:{text:'取消'}}]}, {...context,signal:controller.signal})).isError,true);
    assert.equal(digest(await readFile(edited.path)),digest(valid));
    assert.equal((await readdir(cwd)).some(name=>name.startsWith('.office-work-')||name.endsWith('.office-work.lock')),false);
  } finally { await rm(cwd, {recursive:true,force:true}); }
});
