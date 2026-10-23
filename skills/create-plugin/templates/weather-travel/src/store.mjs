import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync, realpathSync, lstatSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { bounded, fail, stableJson } from './validation.mjs';

export function createStore(dataDir, sessionId, sessionKey) {
  if (typeof dataDir !== 'string' || !isAbsolute(dataDir) || (sessionKey !== undefined ? typeof sessionKey !== 'string' || !/^[a-f0-9]{64}$/u.test(sessionKey) : typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 1024)) fail('host_binding_missing', 'The host must bind an absolute plugin data directory and valid session identity');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const root = realpathSync(dataDir), path = join(root, 'weather-travel.sqlite');
  try { if (lstatSync(path).isSymbolicLink()) fail('unsafe_path', 'Plugin database cannot be a symbolic link'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const db = new DatabaseSync(path, { timeout: 5000 });
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
  db.exec('CREATE TABLE IF NOT EXISTS state (scope TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS receipts (scope TEXT NOT NULL, operation_id TEXT NOT NULL, fingerprint TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(scope, operation_id));');
  // MCP receives a host-generated digest; native receives the original session ID.
  // sessionKey is an internal adapter option, never part of a tool input schema.
  const scope = 'session:' + (sessionKey ?? createHash('sha256').update(sessionId).digest('hex'));
  const get = (key, initial) => { const row = db.prepare('SELECT value FROM state WHERE scope=?').get(key); return row ? JSON.parse(row.value) : structuredClone(initial); };
  const put = (key, data) => db.prepare('INSERT INTO state(scope,value) VALUES (?,?) ON CONFLICT(scope) DO UPDATE SET value=excluded.value').run(key, bounded(data));
  const plan = () => get(scope, { document: { id: 'trip', revision: 0, title: 'My trip', entries: [] } });
  const favorites = () => get('favorites', { revision: 0, places: [] });
  let closed = false;
  return {
    plan, favorites, putPlan: data => put(scope, data), putFavorites: data => put('favorites', data),
    receipt(operationId) { const row = db.prepare('SELECT result FROM receipts WHERE scope=? AND operation_id=?').get(scope, operationId); return row ? JSON.parse(row.result) : undefined; },
    transact(key, input, action) {
      const fingerprint = createHash('sha256').update(stableJson({ key, input })).digest('hex');
      db.exec('BEGIN IMMEDIATE');
      let result;
      try {
        const previous = db.prepare('SELECT fingerprint,result FROM receipts WHERE scope=? AND operation_id=?').get(scope, input.operationId);
        if (previous) {
          if (previous.fingerprint !== fingerprint) fail('operation_id_reused', 'This operation ID already belongs to a different request');
          db.exec('COMMIT');
          return { ...JSON.parse(previous.result), duplicate: true };
        }
        result = action();
        db.prepare('INSERT INTO receipts(scope,operation_id,fingerprint,result) VALUES (?,?,?,?)').run(scope, input.operationId, fingerprint, bounded(result));
        db.exec('COMMIT');
        return result;
      } catch (error) {
        try { if (db.isTransaction) db.exec('ROLLBACK'); }
        finally {
          // A SQLite rollback cannot undo a file already published to the workspace.
          if (key === 'ExportPlan' && (result?.saved === true || error?.code === 'operation_outcome_unknown')) fail('operation_outcome_unknown', 'The file was exported, but its receipt could not be confirmed. Query the original operation ID; do not replay the export.');
        }
        throw error;
      }
    },
    close() { if (!closed) { closed = true; db.close(); } },
  };
}
