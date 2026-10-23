import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
const manifest=JSON.parse(await readFile(join(root,'.vykor-plugin/plugin.json'),'utf8'));
const entry=()=>readFile(join(root,'skills/office-work-entry/SKILL.md'),'utf8');

test('main Agent can discover the application entry alongside unchanged official Skills',async()=>{
 assert.ok(manifest.components.skills.includes('./skills/office-work-entry'));
 assert.ok(manifest.components.skills.includes('./vendor/officecli/skills'));
 assert.match(manifest.description,/office-work-entry/);
 assert.match(await entry(),/name: office-work-entry/);
});
test('hidden tool instructions search first and wait for the next request',async()=>{
 const text=await entry();
 assert.match(text,/未暴露[\s\S]*ToolSearch\(\{"query":"OfficeCLI","limit":1\}\)[\s\S]*下一次模型请求/);
 assert.match(text,/已有.*定义.*直接调用/);
 assert.match(text,/OfficeCLI\(\{"command":"help","args":\["pptx","shape","--json"\]\}\)/);
});
test('unavailable tools stop rather than fall back to shell or another engine',async()=>{
 const text=await entry();
 assert.match(text,/无匹配|没有返回/);
 assert.match(text,/停止.*报告.*不可用/);
 assert.match(text,/不得通过 Shell.*检查版本.*安装.*调用/);
 assert.match(text,/不得.*搜索磁盘.*解压/);
 assert.match(text,/Preview.*不可用.*未检查/);
});
test('entry preserves file version and lifecycle contracts and loads official format guidance',async()=>{
 const text=await entry();
 for(const name of ['officecli','officecli-docx','officecli-xlsx','officecli-pptx'])assert.ok(text.includes('office-work:'+name));
 for(const word of ['expected_sha256','operations','open/save/close','OfficePptPreview','OfficePptReview'])assert.ok(text.includes(word));
 assert.match(text,/官方.*安装.*不适用/);
});
