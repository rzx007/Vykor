import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const run = promisify(execFile);
const checksum = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'host-office-preparation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'packages/services/src/office');
  await mkdir(source, { recursive: true });
  await mkdir(join(root, 'scripts'));
  await copyFile(new URL('../prepare-office-engine.mjs', import.meta.url), join(root, 'scripts/prepare-office-engine.mjs'));
  await writeFile(join(source, 'office-engine.mjs'), `
    import { createHash } from 'node:crypto';
    export const OFFICE_VERSION = '1.0.139';
    export const OFFICE_ASSETS = { 'win32-x64': ['officecli-win-x64.exe', '${checksum}'] };
    export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  `);
  await writeFile(join(source, 'OFFICECLI-LICENSE'), 'host-owned OfficeCLI license\n');
  return root;
}

async function prepare(root, offline = false) {
  const moduleUrl = pathToFileURL(join(root, 'scripts/prepare-office-engine.mjs')).href;
  const code = `
    import assert from 'node:assert/strict';
    globalThis.fetch = async url => {
      ${offline ? "throw Error('cached engine must not use the network');" : `assert.equal(url, 'https://github.com/iOfficeAI/OfficeCLI/releases/download/v1.0.139/officecli-win-x64.exe'); return new Response('hello');`}
    };
    const { prepareOfficeEngine } = await import(${JSON.stringify(moduleUrl)});
    await prepareOfficeEngine(${JSON.stringify(join(root, 'output'))}, 'win32', 'x64');
  `;
  await run(process.execPath, ['--input-type=module', '-e', code], { windowsHide: true, timeout: 10000 });
}

test('host preparation ships its own license with no plugin checkout', async t => {
  const root = await fixture(t);
  await prepare(root);
  assert.equal(await readFile(join(root, 'output/officecli-win-x64.exe'), 'utf8'), 'hello');
  assert.equal(await readFile(join(root, 'output/OFFICECLI-LICENSE'), 'utf8'), 'host-owned OfficeCLI license\n');
});

test('host preparation downloads its pinned engine instead of using plugin binaries', async t => {
  const root = await fixture(t);
  await mkdir(join(root, 'plugins/office-work/bin'), { recursive: true });
  await writeFile(join(root, 'plugins/office-work/bin/officecli-win-x64.exe'), 'unrelated plugin binary');
  await prepare(root);
  assert.equal(await readFile(join(root, 'output/officecli-win-x64.exe'), 'utf8'), 'hello');
});

test('a cached host engine prepares offline without plugin resources', async t => {
  const root = await fixture(t);
  const cache = join(root, 'packages/services/resources/officecli');
  await mkdir(cache, { recursive: true });
  await writeFile(join(cache, 'officecli-win-x64.exe'), 'hello');
  await prepare(root, true);
  assert.equal(await readFile(join(root, 'output/OFFICECLI-LICENSE'), 'utf8'), 'host-owned OfficeCLI license\n');
});
