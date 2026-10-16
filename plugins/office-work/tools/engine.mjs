import { createOfficeRunner, createRunner, hash } from './office-engine.mjs';
import { join } from 'node:path';
export { createRunner, hash };
export const ENGINE_SHA256 = '864e0580c8e8c91a6aa4a4c1e8900551c8d4aa648ff10136ceed3a6ba5310888';
export const CLEANUP_RESERVE_MS = 14000;
export async function engine(context) {
  if(process.platform!=='win32'||process.arch!=='x64')throw new Error('首版仅支持 Windows x64。');
  return createOfficeRunner({...context,binaryPath:join(context.plugin.root,'bin/officecli-win-x64.exe')});
}
