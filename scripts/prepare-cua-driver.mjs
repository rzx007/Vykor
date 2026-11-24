import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';

const run = promisify(execFile);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const source = fileURLToPath(new URL('../apps/desktop/resources/computer-windows/', import.meta.url));
const output = fileURLToPath(new URL('../apps/desktop/out/computer-windows/x64/', import.meta.url));
const manifestName = 'driver-release.json';
const licenseName = 'CUA-LICENSE.txt';
const platform = `${process.platform}-${process.arch}`;
const system32 = join(process.env.SystemRoot ?? 'C:/Windows', 'System32');

async function loadRelease() {
  const manifest = await readFile(join(source, manifestName));
  const release = JSON.parse(manifest.toString('utf8'));
  return { manifest, release, files: [release.executable, manifestName, licenseName] };
}

async function verifyCuaDriverFiles(directory, { manifest, release }) {
  assert.deepEqual(await readFile(join(directory, manifestName)), manifest, 'Cua Driver release manifest changed');
  assert.deepEqual(await readFile(join(directory, licenseName)), await readFile(join(source, licenseName)), 'Cua Driver license changed');

  const executable = join(directory, release.executable);
  const bytes = await readFile(executable);
  assert.equal(sha256(bytes), release.executableSha256, 'Cua Driver executable SHA-256 mismatch');
  const peOffset = bytes.readUInt32LE(0x3c);
  assert.equal(bytes.toString('ascii', peOffset, peOffset + 4), 'PE\0\0', 'Cua Driver executable must be a PE file');
  assert.equal(bytes.readUInt16LE(peOffset + 4), 0x8664, 'Cua Driver executable must target x64');
  return executable;
}

export async function verifyCuaDriverResources(directory, bundle) {
  bundle ??= await loadRelease();
  assert.equal(platform, bundle.release.platform, 'Cua Driver verification requires Windows x64');
  assert.deepEqual((await readdir(directory)).sort(), [...bundle.files].sort(), 'Unexpected Cua Driver artifact files');
  const executable = await verifyCuaDriverFiles(directory, bundle);
  const verifySignature = `
    Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
    $signature = Get-AuthenticodeSignature -LiteralPath $env:VYKOR_CUA_VERIFY_FILE
    if ($signature.Status -ne 'Valid') { throw "Cua Driver Authenticode status: $($signature.Status)" }
    $publisher = $signature.SignerCertificate.GetNameInfo('SimpleName', $false)
    if ($publisher -cne $env:VYKOR_CUA_EXPECTED_PUBLISHER) { throw "Unexpected Cua Driver publisher: $publisher" }
  `;
  await run(join(system32, 'WindowsPowerShell/v1.0/powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', verifySignature], {
    env: { ...process.env, VYKOR_CUA_VERIFY_FILE: executable, VYKOR_CUA_EXPECTED_PUBLISHER: bundle.release.publisher },
    timeout: 30000,
    windowsHide: true,
  });
}

async function prepareCuaDriver(bundle, archivePath, downloadTimeoutMs = 120000) {
  const { release, files } = bundle;
  assert.equal(platform, release.platform, 'Cua Driver preparation requires Windows x64');
  let bytes;
  if (archivePath) {
    bytes = await readFile(archivePath);
  } else {
    const url = `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${release.version}/${release.archive}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(downloadTimeoutMs) });
    if (!response.ok) throw new Error(`Cua Driver download failed: ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  assert.equal(sha256(bytes), release.archiveSha256, 'Cua Driver archive SHA-256 mismatch');

  const temporary = await mkdtemp(join(tmpdir(), 'vykor-cua-'));
  const archive = join(temporary, release.archive);
  const resources = join(temporary, 'resources');
  try {
    await writeFile(archive, bytes);
    await mkdir(resources);
    await run(join(system32, 'tar.exe'), ['-xf', archive, '-C', resources, release.executable], {
      timeout: 30000, windowsHide: true,
    });
    await copyFile(join(source, manifestName), join(resources, manifestName));
    await copyFile(join(source, licenseName), join(resources, licenseName));
    await verifyCuaDriverResources(resources, bundle);
    await mkdir(output, { recursive: true });
    for (const file of files) await copyFile(join(resources, file), join(output, file));
  } finally {
    for (const file of [archive, ...files.map(file => join(resources, file))]) {
      await unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    await rmdir(resources).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await rmdir(temporary);
  }
}

async function main() {
  const { values } = parseArgs({ options: { archive: { type: 'string' }, verify: { type: 'string' }, dev: { type: 'boolean' } } });
  if (values.verify && (values.archive || values.dev)) throw new Error('Use --verify separately to check staged files');
  if (values.dev && (platform !== 'win32-x64' || process.env.VYKOR_COMPUTER_USE === '0')) return;
  try {
    const bundle = await loadRelease();
    const directory = values.verify ? resolve(values.verify) : output;
    if (values.verify) {
      await verifyCuaDriverResources(directory, bundle);
    } else {
      if (values.dev) {
        const ready = await verifyCuaDriverFiles(output, bundle).then(() => true, () => false);
        if (ready) return;
        console.log(`Preparing Cua Driver ${bundle.release.version} for local Computer Use...`);
      }
      await prepareCuaDriver(bundle, values.archive, values.dev ? 30000 : undefined);
    }
    console.log(`Verified Cua Driver ${bundle.release.version}: ${directory}`);
  } catch (error) {
    if (!values.dev) throw error;
    console.warn(`Computer Use driver setup failed: ${error.message}. Vykor will still start.`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
