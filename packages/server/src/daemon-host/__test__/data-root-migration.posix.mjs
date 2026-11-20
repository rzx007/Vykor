import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
const require = createRequire(import.meta.url), api = require(process.env.VYKOR_RELOCATION_MODULE), Database = require(process.env.VYKOR_SQLITE_BINDING);
const inventory = JSON.parse(readFileSync(process.env.VYKOR_SCHEMA_INVENTORY, 'utf8'));
test('POSIX migration copies real WAL, modes, timestamps and links; same-root commit/recover retains both copies', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vykor-t8-posix-'));
  try {
    const source = join(root, 'source'), home = join(root, 'home'); mkdirSync(home); mkdirSync(join(source, 'data/session-runtime'), { recursive: true });
    const path = join(source, 'data/session-runtime/sessions.db'), db = new Database(path); db.pragma('journal_mode=WAL');
    for (const item of inventory.schema.filter(item => item.type === 'table')) db.exec(item.sql);
    for (const item of inventory.schema.filter(item => item.type === 'index')) db.exec(item.sql);
    db.prepare('INSERT INTO session (id,cwd,title,model,status,metadata_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run('wal',join(source,'workspaces/chat'),'text','m','idle','{}',1,2);
    writeFileSync(join(source, 'tool.sh'), '#!/bin/sh\ntrue'); chmodSync(join(source, 'tool.sh'), 0o751); utimesSync(join(source, 'tool.sh'), 1500000000, 1500000000);
    symlinkSync('tool.sh', join(source, 'internal')); writeFileSync(join(root, 'external'), 'external'); symlinkSync(join(root, 'external'), join(source, 'external'));
    // Keep the committed WAL in the source without an active writer handle during same-root rename.
    const copy = join(root, 'wal-copy'); const { cpSync } = require('node:fs'); cpSync(source, copy, { recursive: true, dereference: false }); db.close();
    rmSync(source, { recursive: true }); require('node:fs').renameSync(copy, source);
    utimesSync(join(source, 'tool.sh'), 1500000000, 1500000000);
    const request = { homeDir: home, sourceRoot: source, targetRoot: source, environment: {}, legacy: { documentsDir: join(root, 'Documents'), userDataDir: join(root, 'Electron') } };
    const result = await api.migrateDataRoot(request, { prepareStoppedCopy: async () => ({}) }); assert.equal(result.phase, 'verified');
    assert.equal(statSync(join(source, 'tool.sh')).mode & 0o777, 0o751); assert.equal(statSync(join(source, 'tool.sh')).mtimeMs, 1500000000000); assert.equal(readlinkSync(join(source, 'external')), join(root, 'external')); assert.equal(readFileSync(join(source, 'internal'), 'utf8'), '#!/bin/sh\ntrue');
    await api.commitDataRootMigration(result.journalPath, { homeDir: home }); assert.equal(existsSync(join(source, 'data/migrations/moved-root.json')), false);
    const recovered = await api.recoverDataRootMigration(result.journalPath, { homeDir: home }); assert.equal(recovered.phase, 'failed'); assert.deepEqual(await api.recoverDataRootMigration(result.journalPath, { homeDir: home }), recovered);
    const journal = JSON.parse(readFileSync(result.journalPath, 'utf8')); assert.equal(existsSync(journal.stagingRoot), true);
    const reopened = new Database(path, { readonly: true }); assert.equal(reopened.prepare('SELECT count(*) AS n FROM session').get().n, 1); reopened.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('POSIX two real recovery processes serialize a dead ordinary startup lease', { timeout: 10000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'vykor-t8-lock-')), children = [];
  try {
    const dead = spawnSync(process.execPath, ['-e', '']), token = randomUUID(), active = join(home, '.vykor-root.json.lock/active'); mkdirSync(active, { recursive: true });
    writeFileSync(join(active, 'owner.json'), JSON.stringify({ pid: dead.pid, ownerToken: token }));
    const script = `const api=require(process.env.VYKOR_RELOCATION_MODULE); process.send('ready'); process.once('message',async()=>{try{await api.withDataRootRecoveryLock(process.env.T8_HOME,async()=>{process.send('acquired');await new Promise(r=>process.once('message',r));},{timeoutMs:300,pollIntervalMs:1});process.send('done');}catch{process.send('refused');}process.disconnect();});`;
    let inCritical = 0, maximum = 0, first, refused = false;
    const starts = [], completions = [];
    for (let i = 0; i < 2; i++) {
      const child = spawn(process.execPath, ['-e', script], { env: { ...process.env, T8_HOME: home }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] }); children.push(child);
      starts.push(new Promise(resolve => child.on('message', message => { if (message === 'ready') resolve(); })));
      completions.push(new Promise((resolve, reject) => {
        child.on('message', message => {
          if (message === 'acquired') { inCritical++; maximum = Math.max(maximum, inCritical); if (!first) first = child; else { child.send('release'); first.send('release'); } if (refused) child.send('release'); }
          if (message === 'refused') { refused = true; if (first) first.send('release'); }
          if (message === 'done') inCritical--;
        }); child.on('exit', code => code === 0 ? resolve() : reject(new Error('recovery child failed')));
      }));
    }
    await Promise.all(starts); for (const child of children) child.send('go'); await Promise.all(completions);
    assert.equal(maximum, 1); assert.equal(JSON.parse(readFileSync(join(home, `.vykor-root.json.lock/claims/${token}/owner.json`), 'utf8')).pid, dead.pid);
  } finally { for (const child of children) if (child.exitCode === null) child.kill(); rmSync(home, { recursive: true, force: true }); }
});
