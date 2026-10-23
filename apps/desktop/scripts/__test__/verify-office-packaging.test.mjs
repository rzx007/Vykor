import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const run = promisify(execFile);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'host-office-packaging-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const desktop = join(root, 'apps/desktop');
  const source = join(root, 'packages/services/src/office');
  await mkdir(join(desktop, 'scripts'), { recursive: true });
  await mkdir(join(desktop, 'out/office-engine'), { recursive: true });
  await mkdir(source, { recursive: true });
  const script = join(desktop, 'scripts/verify-office-packaging.mjs');
  await copyFile(new URL('../verify-office-packaging.mjs', import.meta.url), script);
  await writeFile(join(source, 'office-engine.mjs'), `
    import { createHash } from 'node:crypto';
    export const OFFICE_VERSION = '1.0.139';
    export const OFFICE_ASSETS = { '${process.platform}-${process.arch}': ['officecli-fixture', '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'] };
    export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
    export const officeBinaryPath = () => { throw Error('runtime smoke not requested'); };
    export const createOfficeRunner = officeBinaryPath;
  `);
  await writeFile(join(source, 'OFFICECLI-LICENSE'), 'host-owned OfficeCLI license\n');
  await writeFile(join(desktop, 'electron-builder.yml'), 'extraResources:\n  - from: out/office-engine\n    to: office-engine\n');
  await writeFile(join(desktop, 'out/office-engine/officecli-fixture'), 'hello');
  await writeFile(join(desktop, 'out/office-engine/OFFICECLI-LICENSE'), 'host-owned OfficeCLI license\n');
  return { desktop, script };
}

test('packaging verification uses the host license without a plugin checkout', async t => {
  const { script } = await fixture(t);
  const { stdout } = await run(process.execPath, [script], { windowsHide: true, timeout: 10000 });
  assert.match(stdout, /Office engine binary, license and packaging verified/);
});

test('packaging verification rejects a license different from the host source', async t => {
  const { desktop, script } = await fixture(t);
  await writeFile(join(desktop, 'out/office-engine/OFFICECLI-LICENSE'), 'wrong license');
  await assert.rejects(() => run(process.execPath, [script], { windowsHide: true, timeout: 10000 }), /OfficeCLI license missing or changed/);
});
