import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
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
