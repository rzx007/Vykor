import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, cp, mkdir, mkdtemp, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const prepare = fileURLToPath(new URL('../prepare-cua-driver.mjs', import.meta.url));
const run = promisify(execFile);

test('rejects a modified Cua archive before unpacking it', {
  skip: process.platform !== 'win32' || process.arch !== 'x64',
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vykor-cua-archive-test-'));
  const archive = join(directory, 'driver.zip');
  t.after(async () => {
    await unlink(archive);
    await rmdir(directory);
  });
  await writeFile(archive, 'untrusted archive');

  await assert.rejects(run(process.execPath, [prepare, '--archive', archive], { windowsHide: true }),
    /Cua Driver archive SHA-256 mismatch/);
});

test('development startup continues when the driver manifest or archive is unusable', {
  skip: process.platform !== 'win32' || process.arch !== 'x64',
}, async (t) => {
  const checkout = await mkdtemp(join(tmpdir(), 'vykor-cua-dev-test-'));
  t.after(() => rm(checkout, { recursive: true, force: true }));
  const script = join(checkout, 'scripts', 'prepare-cua-driver.mjs');
  const archive = join(checkout, 'driver.zip');
  const args = [script, '--dev', '--archive', archive];
  const options = { env: { ...process.env, VYKOR_COMPUTER_USE: '1' }, windowsHide: true };
  await mkdir(join(checkout, 'scripts'));
  await copyFile(prepare, script);
  const disabled = await run(process.execPath, args, {
    ...options, env: { ...options.env, VYKOR_COMPUTER_USE: '0' },
  });
  assert.equal(disabled.stderr, '');
  const missing = await run(process.execPath, args, options);
  assert.match(missing.stderr, /driver-release\.json/);
  assert.match(missing.stderr, /Vykor will still start/);
  await cp(fileURLToPath(new URL('../../apps/desktop/resources/computer-windows/', import.meta.url)),
    join(checkout, 'apps', 'desktop', 'resources', 'computer-windows'), { recursive: true });
  await writeFile(archive, 'untrusted archive');
  const { stderr } = await run(process.execPath, args, options);
  assert.match(stderr, /Cua Driver archive SHA-256 mismatch/);
  assert.match(stderr, /Vykor will still start/);
});
