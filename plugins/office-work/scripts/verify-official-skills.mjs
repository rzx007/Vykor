import {readFile,lstat} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {readReleaseTextParts} from './release-archive.mjs';
const names=['officecli','officecli-docx','officecli-pptx','officecli-xlsx'];
const digest=(algorithm,bytes)=>createHash(algorithm).update(bytes).digest('hex');
const blob=bytes=>digest('sha1',Buffer.concat([Buffer.from('blob '+bytes.length+'\0'),bytes]));
export async function verifyOfficialSkills(root,archive) {
 const prefix='vendor/officecli/';
 const parts=archive?readReleaseTextParts(await readFile(archive),['.vykor-plugin/plugin.json',prefix+'SOURCE.json',...names.map(name=>prefix+'skills/'+name+'/SKILL.md')]):undefined;
 const read=async path=>{
  if(parts){const bytes=parts.get(path);if(bytes===undefined)throw Error('Missing packaged official skill: '+path);return bytes;}
  if(!(await lstat(join(root,path))).isFile())throw Error('Official skills must be materialized regular files: '+path);
  return readFile(join(root,path));
 };
 const source=JSON.parse((await read(prefix+'SOURCE.json')).toString('utf8'));
 if(source.repository!=='https://github.com/iOfficeAI/OfficeCLI'||source.ref!=='v1.0.139'||source.files.length!==names.length)throw Error('Unexpected official skill source manifest');
 const manifest=JSON.parse((await read('.vykor-plugin/plugin.json')).toString('utf8'));
 if(JSON.stringify(manifest.components.skills)!==JSON.stringify(['./skills/office-work-entry','./vendor/officecli/skills']))throw Error('Official skill entry directory changed');
 for(const name of names) {
  const path='skills/'+name+'/SKILL.md',entries=source.files.filter(f=>f.path===path);
  if(entries.length!==1)throw Error('Missing or duplicate official skill source: '+name);
  const entry=entries[0],bytes=await read(prefix+path),text=bytes.toString('utf8');
  if(bytes.length<1000||!/^---\r?\n[\s\S]*?\r?\n---\r?\n/.test(text)||!/^# .+/m.test(text)||!new RegExp('^name: '+name+'\\r?$', 'm').test(text))throw Error('Official skill body missing or incomplete: '+name);
  if(digest('sha256',bytes)!==entry.sha256||blob(bytes)!==entry.git_blob_sha)throw Error('Official skill source hash mismatch: '+name);
  if(name==='officecli') {
   const link=entry.materialized_link;
   if(entry.source_path!=='SKILL.md'||link?.source_path!==path||link?.target!=='../../SKILL.md'||blob(Buffer.from(link.target))!==link.git_blob_sha)throw Error('Official base skill link provenance missing');
   for(const heading of ['## Strategy','## Help System','## Quick Start','## Notes'])if(!text.includes(heading))throw Error('Official base skill instructions incomplete');
  }
 }
 return names;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 const root=process.argv[2]??resolve(dirname(fileURLToPath(import.meta.url)),'..');
 await verifyOfficialSkills(root,process.argv[3]);
 console.log('Verified four complete official skills'+(process.argv[3]?' in archive':' in source'));
}
