import { createHash } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getTableConfig, SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { isCompleteAbsolutePath, isWithinManagedPath, relocateManagedPath, type ManagedPathMove, type PathRelocationReport } from "@vykor/host-config/paths";
import { relocateWorkflowSnapshotPaths } from "@vykor/coordinator/workflow-relocation";
import * as schema from "../session-runtime/schema.js";
import { normalizeProjectPath } from "../projects/project-records.js";
import { AttachmentBlobStore } from "../attachments/storage/attachment-blob-store.js";
import { noteFilePath, readNoteFile, scanNoteIds } from "../notes/markdown-note-files.js";
import { validateNoteOrganizationFiles } from "../notes/note-organization-repository.js";

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const report = (): PathRelocationReport => ({ changed: 0, unchangedExternal: 0, unsupported: [] });
const terminal = (status: string) => status === "completed" || status === "failed";

function openCopy(path: string, readonly: boolean): Database.Database {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Database copy must be a regular file");
  return new Database(path, { readonly, fileMustExist: true });
}

function validateCopy(connection: Database.Database, result: PathRelocationReport): boolean {
  if (connection.pragma("integrity_check", { simple: true }) !== "ok" || (connection.pragma("foreign_key_check") as unknown[]).length) throw new Error("Database copy integrity or foreign-key check failed");
  const known = new Set(Object.values(schema).map(table => getTableConfig(table).name));
  for (const { name } of connection.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '__drizzle_migrations'").all() as Array<{ name: string }>)
    if (!known.has(name)) result.unsupported.push({ table: name, id: "schema" });
  for (const table of Object.values(schema)) {
    const { name, columns, indexes } = getTableConfig(table);
    const actual = connection.pragma(`table_info(${JSON.stringify(name)})`) as Array<{ name: string; type: string }>;
    const actualIndexes = connection.pragma(`index_list(${JSON.stringify(name)})`) as Array<{ name: string; unique: number; partial: number }>;
    const indexesMatch = indexes.every(({ config }) => {
      const actualIndex = actualIndexes.find(item => item.name === config.name);
      if (!actualIndex || !!actualIndex.unique !== config.unique || !!actualIndex.partial !== !!config.where) return false;
      const indexedColumns = connection.pragma(`index_info(${JSON.stringify(config.name)})`) as Array<{ seqno: number; name: string | null }>;
      indexedColumns.sort((a, b) => a.seqno - b.seqno);
      if (indexedColumns.length !== config.columns.length || config.columns.some((column, i) => !("name" in column) || column.name !== indexedColumns[i]!.name)) return false;
      const actualSql = connection.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?").get(config.name) as { sql: string };
      const actualWhere = /\bWHERE\s+([\s\S]*)$/i.exec(actualSql.sql)?.[1]?.trim();
      // Compare the current schema's generated predicate, not an inferred equivalent.
      const expectedWhere = config.where && new SQLiteSyncDialect().sqlToQuery(config.where).sql.trim();
      return actualWhere === expectedWhere;
    });
    if (columns.some(column => !actual.some(item => item.name === column.name && item.type.toLowerCase() === column.getSQLType().toLowerCase())) || actual.length !== columns.length
      || !indexesMatch)
      result.unsupported.push({ table: name, id: "schema" });
  }
  return result.unsupported.length === 0;
}

function jsonObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (!record(value)) throw new Error("Invalid structured metadata");
  return value;
}

/** Existing desktop settings/worktree bindings and task worktree receipts only. */
function hostMetadata(text: string, path: (value: string) => string): string {
  const value = jsonObject(text), before = JSON.stringify(value);
  const field = (owner: Record<string, unknown>, key: string) => {
    if (owner[key] === undefined) return;
    if (typeof owner[key] !== "string") throw new Error("Invalid host path");
    owner[key] = path(owner[key]);
  };
  const tree = (owner: Record<string, unknown>) => {
    if (owner.worktree === undefined) return;
    if (!record(owner.worktree)) throw new Error("Invalid worktree binding");
    field(owner.worktree, "path");
  };
  if (value.desktop !== undefined) {
    if (!record(value.desktop)) throw new Error("Invalid desktop metadata");
    field(value.desktop, "settingsRoot"); tree(value.desktop);
  }
  tree(value);
  if (value.scheduledTask !== undefined) {
    if (!record(value.scheduledTask)) throw new Error("Invalid scheduled task metadata");
    tree(value.scheduledTask);
  }
  return JSON.stringify(value) === before ? text : JSON.stringify(value);
}

function pathsArray(text: string, path: (value: string) => string): string {
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value) || !value.every(item => typeof item === "string")) throw new Error("Invalid project paths");
  const next = value.map(path);
  return next.every((item, index) => item === value[index]) ? text : JSON.stringify(next);
}

function safe(result: PathRelocationReport, table: string, id: string, text: string, work: () => string): string {
  try { return work(); }
  catch {
    let version: number | undefined;
    try { const parsed = JSON.parse(text); if (typeof parsed?.version === "number") version = parsed.version; } catch { /* No payload in diagnostics. */ }
    result.unsupported.push({ table, id, ...(version === undefined ? {} : { version }) });
    return text;
  }
}

export interface DatabasePathRegistrations {
  schema: "supported" | "unsupported";
  /** Candidates only: T8 intersects with known managed roots and excludes projectPaths in T6. */
  workspacePaths: string[];
  channelPaths: string[];
  worktreePaths: string[];
  /** Protected project locations and schedule references without proven workspace ownership. */
  projectPaths: string[];
  /** All known cwd/host paths for hash-key relocation and final boundary checks. */
  cwdPaths: string[];
  unsupported: PathRelocationReport["unsupported"];
}

/** Existing stopped independent copy only. Does not migrate schemas, initialize stores, or return bodies. */
export function readDatabasePathRegistrations(databasePath: string, options: { managedRoots: readonly string[] }): DatabasePathRegistrations {
  const connection = openCopy(databasePath, true), result = report();
  const projects = new Set<string>(), workspaces = new Set<string>(), channels = new Set<string>(), worktrees = new Set<string>(), cwd = new Set<string>();
  const managed = (value: string) => options.managedRoots.some(root => isWithinManagedPath(value, root));
  const add = (value: string) => { if (!isCompleteAbsolutePath(value)) throw new Error("Invalid registered path"); cwd.add(value); return value; };
  const workspace = (value: string) => { add(value); if (managed(value)) workspaces.add(value); return value; };
  try {
    if (validateCopy(connection, result)) {
      const db = drizzle(connection, { schema });
      const ownedLocations = new Set<string>();
      for (const row of db.select({ id: schema.sessions.id, projectId: schema.sessions.projectId, cwd: schema.sessions.cwd, metadataJson: schema.sessions.metadataJson }).from(schema.sessions).all()) safe(result, "session", row.id!, row.metadataJson, () => {
        add(row.cwd);
        const metadata = jsonObject(row.metadataJson), desktop = record(metadata.desktop) ? metadata.desktop : undefined;
        const isChannel = !metadata.fork && (metadata.source === "channel" || record(metadata.externalConversation));
        const outside = desktop?.workspaceMode === "outside_project";
        const scheduled = record(metadata.scheduledTask) ? metadata.scheduledTask : undefined;
        const tree = record(desktop?.worktree) ? desktop.worktree : record(scheduled?.worktree) ? scheduled.worktree : undefined;
        if (tree && (typeof tree.path !== "string" || normalizeProjectPath(tree.path) !== normalizeProjectPath(row.cwd))) throw new Error("Worktree binding disagrees with session cwd");
        if ((outside || isChannel || tree) && !managed(row.cwd)) throw new Error("Managed session path is outside known roots");
        if (managed(row.cwd) && (outside || isChannel || tree)) {
          (isChannel ? channels : tree ? worktrees : workspaces).add(row.cwd);
          // Auto-created project locations have exactly the allocated workspace cwd.
          ownedLocations.add(normalizeProjectPath(row.cwd));
        } else if (!row.projectId) workspace(row.cwd);
        return hostMetadata(row.metadataJson, add);
      });
      for (const row of db.select().from(schema.projectLocations).all()) safe(result, "project_location", row.id, "{}", () => {
        add(row.path);
        if (ownedLocations.has(normalizeProjectPath(row.path))) return row.path;
        if (managed(row.path)) throw new Error("Registered project ownership needs review");
        projects.add(row.path); return row.path;
      });
      for (const row of db.select({ id: schema.sessionTasks.id, cwd: schema.sessionTasks.cwd, metadataJson: schema.sessionTasks.metadataJson }).from(schema.sessionTasks).all()) safe(result, "session_task", row.id!, row.metadataJson, () => { workspace(row.cwd); return hostMetadata(row.metadataJson, add); });
      for (const row of db.select({ id: schema.scheduledTasks.id, projectPathsJson: schema.scheduledTasks.projectPathsJson }).from(schema.scheduledTasks).all()) safe(result, "scheduled_task", row.id, row.projectPathsJson, () => pathsArray(row.projectPathsJson, value => {
        add(value);
        // A project reference does not prove allocation, even inside Documents/Vykor.
        if (!ownedLocations.has(normalizeProjectPath(value))) projects.add(value);
        return value;
      }));
      for (const row of db.select({ runId: schema.workflowRuns.runId, status: schema.workflowRuns.status, snapshotJson: schema.workflowRuns.snapshotJson }).from(schema.workflowRuns).all()) if (!terminal(row.status)) safe(result, "workflow_run", row.runId, row.snapshotJson, () => relocateWorkflowSnapshotPaths(row.snapshotJson, value => isAbsolute(value) ? workspace(value) : value, row));
    }
    const protectedPaths = new Set([...projects].map(normalizeProjectPath));
    return { schema: result.unsupported.length ? "unsupported" : "supported", workspacePaths: [...workspaces].filter(path => !channels.has(path) && !worktrees.has(path) && !protectedPaths.has(normalizeProjectPath(path))).sort(), channelPaths: [...channels].sort(), worktreePaths: [...worktrees].sort(), projectPaths: [...projects].sort(), cwdPaths: [...cwd].sort(), unsupported: result.unsupported };
  } finally { connection.close(); }
}

/** Writes final logical paths in an owned copy; a nonempty unsupported list means nothing was committed. */
export function relocateDatabasePaths(databasePath: string, moves: readonly ManagedPathMove[]): PathRelocationReport {
  const connection = openCopy(databasePath, false), result = report();
  try {
    connection.pragma("foreign_keys = ON");
    if (!validateCopy(connection, result)) return result;
    const db = drizzle(connection, { schema });
    const path = (value: string) => { const next = relocateManagedPath(value, moves); if (next === value) result.unchangedExternal++; return next; };
    db.transaction(tx => {
      const locations = tx.select().from(schema.projectLocations).all();
      const sessions = tx.select().from(schema.sessions).all().map(row => ({ row, cwd: path(row.cwd), metadataJson: safe(result, "session", row.id!, row.metadataJson, () => hostMetadata(row.metadataJson, path)) }));
      const tasks = tx.select().from(schema.sessionTasks).all().map(row => ({ row, cwd: path(row.cwd), metadataJson: safe(result, "session_task", row.id!, row.metadataJson, () => hostMetadata(row.metadataJson, path)) }));
      const schedules = tx.select().from(schema.scheduledTasks).all().map(row => ({ row, projectPathsJson: safe(result, "scheduled_task", row.id, row.projectPathsJson, () => pathsArray(row.projectPathsJson, path)) }));
      const flows = tx.select().from(schema.workflowRuns).all().filter(row => !terminal(row.status)).map(row => ({ row, snapshotJson: safe(result, "workflow_run", row.runId, row.snapshotJson, () => relocateWorkflowSnapshotPaths(row.snapshotJson, path, row)) }));
      if (result.unsupported.length) return;
      for (const { row, cwd, metadataJson } of sessions) {
        const location = locations.find(item => item.projectId === row.projectId && item.status === "active");
        let cwdRelative = row.cwdRelative;
        if (location && (cwd !== row.cwd || path(location.path) !== location.path)) {
          cwdRelative = relative(path(location.path), cwd);
          if (isWithinManagedPath(row.cwd, location.path) && !isWithinManagedPath(cwd, path(location.path))) throw new Error("Relocated session escapes its project");
        }
        if (cwd !== row.cwd || metadataJson !== row.metadataJson || cwdRelative !== row.cwdRelative) { tx.update(schema.sessions).set({ cwd, cwdRelative, metadataJson }).where(eq(schema.sessions.id, row.id!)).run(); result.changed++; }
      }
      for (const row of locations) { const next = path(row.path); if (next !== row.path) { tx.update(schema.projectLocations).set({ path: next, normalizedPath: normalizeProjectPath(next) }).where(eq(schema.projectLocations.id, row.id)).run(); result.changed++; } }
      for (const { row, cwd, metadataJson } of tasks) if (cwd !== row.cwd || metadataJson !== row.metadataJson) { tx.update(schema.sessionTasks).set({ cwd, metadataJson }).where(eq(schema.sessionTasks.id, row.id!)).run(); result.changed++; }
      for (const { row, projectPathsJson } of schedules) if (projectPathsJson !== row.projectPathsJson) { tx.update(schema.scheduledTasks).set({ projectPathsJson }).where(eq(schema.scheduledTasks.id, row.id)).run(); result.changed++; }
      for (const { row, snapshotJson } of flows) if (snapshotJson !== row.snapshotJson) { tx.update(schema.workflowRuns).set({ snapshotJson }).where(eq(schema.workflowRuns.runId, row.runId)).run(); result.changed++; }
      if ((connection.pragma("foreign_key_check") as unknown[]).length) throw new Error("Relocated database foreign-key check failed");
    });
    return result;
  } finally { connection.close(); }
}

/** Reopens only the stopped owned copy; validates resources without initializing SessionStore. */
export async function verifyDataRootCopy(databasePath: string): Promise<void> {
  const connection = openCopy(databasePath, false), result = report();
  try {
    if (!validateCopy(connection, result)) throw new Error("Unsupported database copy schema");
    const db = drizzle(connection, { schema }), blobs = new AttachmentBlobStore({ root: join(dirname(databasePath), "attachments") });
    const resources = db.select().from(schema.attachmentAssets).all();
    for (const item of resources) {
      if (!item.sha256 || item.sizeBytes === null) continue;
      await blobs.resolveReadOnlyPath(item.sha256, item.sizeBytes);
      const reader = (await blobs.open(item.sha256, item.sizeBytes)).getReader(), hash = createHash("sha256");
      try { for (;;) { const part = await reader.read(); if (part.done) break; hash.update(part.value); } }
      finally { reader.releaseLock(); }
      if (hash.digest("hex") !== item.sha256) throw new Error("Attachment copy digest mismatch");
    }
    const notes = join(dirname(databasePath), "notes"), indexed = db.select().from(schema.noteFileIndex).all();
    if (existsSync(notes)) {
      const ids = scanNoteIds(notes);
      for (const id of ids) readNoteFile(noteFilePath(notes, id));
      validateNoteOrganizationFiles(notes, ids);
    }
    for (const entry of indexed) if (entry.deletedAt === null) {
      const note = readNoteFile(noteFilePath(notes, entry.id));
      if (!note || createHash("sha256").update(note.content).digest("hex") !== entry.sha256) throw new Error("Note copy digest mismatch");
    }
    // Runtime leases refer to stopped owners. Durable asset/source identities stay intact.
    db.delete(schema.attachmentLeases).run();
    connection.pragma("wal_checkpoint(TRUNCATE)");
  } finally { connection.close(); }
}
