// Runs against the bundled production leaves and the real Linux SQLite N-API binding.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, cpSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const require = createRequire(import.meta.url);
const api = require(process.env.VYKOR_RELOCATION_MODULE);
const Database = require(process.env.VYKOR_SQLITE_BINDING);
const inventory = JSON.parse(readFileSync(process.env.VYKOR_SCHEMA_INVENTORY, 'utf8'));

test('POSIX real SQLite preserves case, WAL rows, bodies and source files through copy relocation', () => {
  const root = mkdtempSync(join(tmpdir(), 'vykor-t7-db-'));
  try {
    const source = join(root, 'source'), final = join(root, 'final'), stage = join(root, 'stage'); mkdirSync(source); mkdirSync(stage);
    const sourceFile = join(source, 'sessions.db'), copy = join(stage, 'sessions.db'), db = new Database(sourceFile);
    db.pragma('journal_mode=WAL');
    for (const item of inventory.schema.filter(item => item.type === 'table')) db.exec(item.sql);
    for (const item of inventory.schema.filter(item => item.type === 'index')) db.exec(item.sql);
    const cwd = join(source, 'workspaces/chat');
    db.prepare('INSERT INTO project (id,name,last_opened_at,created_at,updated_at) VALUES (?,?,?,?,?)').run('p', 'p', 1, 1, 2);
    db.prepare('INSERT INTO project_location (id,project_id,path,normalized_path,status,bound_at) VALUES (?,?,?,?,?,?)').run('p', 'p', cwd, cwd, 'active', 1);
    db.prepare('INSERT INTO session (id,project_id,cwd,cwd_relative,title,model,status,metadata_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run('s','p',cwd,'',cwd,'m','idle',JSON.stringify({ desktop: { workspaceMode: 'outside_project' } }),1,2);
    const differentlyCased = join(root, 'Source/chat');
    db.prepare('INSERT INTO session (id,cwd,title,model,status,metadata_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run('case-sensitive',differentlyCased,'case','m','idle','{}',1,2);
    db.prepare('INSERT INTO session_input (id,session_id,seq,delivery,content,items_json,metadata_json,created_at) VALUES (?,?,?,?,?,?,?,?)').run('input','s',1,'immediate',cwd,'[]','{}',1);
    cpSync(source, stage, { recursive: true });
    try {
      assert.deepEqual(api.readDatabasePathRegistrations(copy, { managedRoots: [source] }).workspacePaths, [cwd]);
      const before = readFileSync(sourceFile), report = api.relocateDatabasePaths(copy, [{ kind: 'user-root', from: source, to: final }]);
      assert.deepEqual(report.unsupported, []);
      const reopened = new Database(copy, { readonly: true });
      try { assert.equal(reopened.pragma('integrity_check', { simple: true }), 'ok'); assert.deepEqual(reopened.pragma('foreign_key_check'), []); assert.equal(reopened.prepare("SELECT cwd FROM session WHERE id='s'").get().cwd, join(final, 'workspaces/chat')); assert.equal(reopened.prepare("SELECT cwd FROM session WHERE id='case-sensitive'").get().cwd, differentlyCased); assert.equal(reopened.prepare('SELECT content FROM session_input').get().content, cwd); } finally { reopened.close(); }
      assert.deepEqual(readFileSync(sourceFile), before);
      assert.equal(api.relocateDatabasePaths(copy, [{ kind: 'user-root', from: source.toUpperCase(), to: final }]).changed, 0);
    } finally { db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('POSIX validates staged plugins with final references and rejects escaping copied file roots', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vykor-t7-files-'));
  try {
    const source = join(root, 'source'), final = join(root, 'final'), stage = join(root, 'stage'), external = join(root, 'external');
    await api.writeNativeAppFixture(external);
    const store = join(source, 'plugins/installed.json');
    const installed = await api.installLocalNativePlugin({ sourcePath: external, scope: 'user', cwd: root, storePath: store, cacheDir: join(source, 'cache'), approvedPermissions: ['ui:invoke-own-tools', 'ui:render'] });
    assert.equal(installed.status, 'installed'); cpSync(source, stage, { recursive: true });
    const moves = [{ kind: 'user-root', from: source, to: final }];
    assert.deepEqual((await api.relocateInstalledPluginStore(join(stage, 'plugins/installed.json'), moves, { stagedRoot: stage, targetRoot: final })).unsupported, []);
    const record = Object.values(JSON.parse(readFileSync(join(stage, 'plugins/installed.json'), 'utf8')).plugins)[0];
    assert.equal(record.cachePath, installed.record.cachePath.replace(source, final)); assert.equal(record.behaviorDigest, installed.record.behaviorDigest); assert.deepEqual(record.approvedPermissions, installed.record.approvedPermissions);
    mkdirSync(join(stage, 'data')); symlinkSync(external, join(stage, 'data/desktop'));
    await assert.rejects(api.relocateDataRootFiles({ stagedRoot: stage, targetRoot: final, moves }), /outside its scope/);
    rmSync(join(stage, 'data/desktop'));
    mkdirSync(join(stage, 'data/desktop'));
    writeFileSync(join(stage, 'data/desktop/composer-recovery.json'), JSON.stringify({ version: 99 }));
    assert.equal((await api.relocateDataRootFiles({ stagedRoot: stage, targetRoot: final, moves })).unsupported[0].version, 99);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
