import { createOfficeRunner, createRunner, hash, OFFICE_ASSETS } from './office-engine.mjs';
import { join } from 'node:path';
export { createRunner, hash };
export const ENGINE_SHA256 = '864e0580c8e8c91a6aa4a4c1e8900551c8d4aa648ff10136ceed3a6ba5310888';
export const CLEANUP_RESERVE_MS = 14000;
export async function engine(context) {
  const asset = OFFICE_ASSETS[`${process.platform}-${process.arch}`]?.[0];
  if (!asset) throw new Error('当前平台不支持 Office 引擎。');
  return createOfficeRunner({...context,binaryPath:join(context.plugin.root,'bin',asset)});
}
