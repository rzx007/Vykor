import { mkdir, readFile, writeFile, copyFile, chmod } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OFFICE_VERSION, OFFICE_ASSETS, hash } from '../packages/services/src/office/office-engine.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export async function prepareOfficeEngine(output,platform=process.platform,arch=process.arch) {
  const asset=OFFICE_ASSETS[`${platform}-${arch}`];
  if(!asset)throw new Error(`Unsupported Office engine platform: ${platform}-${arch}`);
  const [name,checksum]=asset,directory=join(root,'packages/services/resources/officecli'),file=join(directory,name);
  await mkdir(directory,{recursive:true});
  let bytes=await readFile(file).catch(()=>undefined);
  if(!bytes){
    const response=await fetch(`https://github.com/iOfficeAI/OfficeCLI/releases/download/v${OFFICE_VERSION}/${name}`,{signal:AbortSignal.timeout(120000)});
    if(!response.ok)throw new Error(`OfficeCLI download failed: ${response.status}`);
    bytes=Buffer.from(await response.arrayBuffer());
  }
  if(hash(bytes)!==checksum)throw new Error('OfficeCLI checksum mismatch');
  await writeFile(file,bytes);if(platform!=='win32')await chmod(file,0o755);
  if(output){
    await mkdir(output,{recursive:true});await copyFile(file,join(output,name));
    if(platform!=='win32')await chmod(join(output,name),0o755);
    await copyFile(join(root,'packages/services/src/office/OFFICECLI-LICENSE'),join(output,'OFFICECLI-LICENSE'));
  }
  return file;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(await prepareOfficeEngine(process.argv[2]));
