import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,cp,writeFile,readFile,rm,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {verifyOfficialSkills} from '../scripts/verify-official-skills.mjs';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
test('all four official skill bodies and materialized-link provenance are complete',async()=>{
 assert.equal((await verifyOfficialSkills(root)).length,4);
});
for(const fault of ['pointer with matching hashes','missing base','truncated format','missing format'])test('packaging verification rejects '+fault,async()=>{
 const temp=await mkdtemp(join(tmpdir(),'office-skill-integrity-'));
 try {
  await mkdir(join(temp,'vendor'),{recursive:true});await cp(join(root,'vendor/officecli'),join(temp,'vendor/officecli'),{recursive:true});
  await cp(join(root,'.vykor-plugin'),join(temp,'.vykor-plugin'),{recursive:true});
  const base=join(temp,'vendor/officecli/skills/officecli/SKILL.md'),format=join(temp,'vendor/officecli/skills/officecli-docx/SKILL.md');
  if(fault==='pointer with matching hashes') {
   const bytes=Buffer.from('../../SKILL.md');await writeFile(base,bytes);
   const path=join(temp,'vendor/officecli/SOURCE.json'),source=JSON.parse(await readFile(path,'utf8'));
   source.files[0].sha256=createHash('sha256').update(bytes).digest('hex');source.files[0].git_blob_sha=createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex');await writeFile(path,JSON.stringify(source));
  }else if(fault==='missing base')await unlink(base);
  else if(fault==='truncated format')await writeFile(format,'---\nname: officecli-docx\n---\n# OfficeCLI DOCX\n');
  else await unlink(format);
  await assert.rejects(()=>verifyOfficialSkills(temp),/missing|incomplete|ENOENT/i);
 }finally{await rm(temp,{recursive:true,force:true});}
});
