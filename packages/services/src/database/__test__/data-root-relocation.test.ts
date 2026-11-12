import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { SessionDatabase } from "../session-database.js";
import * as api from "../index.js";
import * as tables from "../../session-runtime/schema.js";
import { readNoteFile } from "../../notes/markdown-note-files.js";
import { AttachmentBlobStore } from "../../attachments/storage/attachment-blob-store.js";

let root: string, source: string, target: string, copy: string, oldCwd: string, newCwd: string;
const origin = JSON.stringify({ storage: "memory", sessionId: "temporary-id", inputId: "temporary-input" });
const blobHash = createHash("sha256").update("blob").digest("hex");
const relocate = (...args: unknown[]) => {
  expect(api).toHaveProperty("relocateDatabasePaths");
  return (api as any).relocateDatabasePaths(...args);
};
const inspect = (...args: unknown[]) => {
  expect(api).toHaveProperty("readDatabasePathRegistrations");
  return (api as any).readDatabasePathRegistrations(...args);
};
const moves = () => [{ kind: "user-root", from: source, to: target }];
const snapshot = () => ({ version: 1, runId: "flow", status: "running", summary: oldCwd,
  spec: { mode: "sequential", tasks: [{ id: "work", prompt: oldCwd, writeScope: [oldCwd] }] },
  plan: { mode: "sequential", tasks: [{ id: "work", prompt: oldCwd, writeScope: [oldCwd] }], maxConcurrency: 1, executionOrder: ["work"], dependencyMap: {}, dependentsMap: {} },
  results: {}, orderedResults: [], pendingTaskIds: [], blockedTaskIds: [], blockedTasks: {}, runningTaskIds: ["work"],
  runningTasks: { work: { taskId: "work", attempt: 1, dependencies: [], startedAt: 1, summary: oldCwd, metadata: { worktree: { path: oldCwd, branch: "task" }, command: oldCwd } } },
  budget: { tasks: {} }, createdAt: 1, updatedAt: 2 });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "relocate-db-")); source = join(root, "source"); target = join(root, "final"); copy = join(root, "owned-copy", "sessions.db");
  oldCwd = join(source, "workspaces", "chat"); newCwd = join(target, "workspaces", "chat");
  const db = SessionDatabase.open({ path: join(source, "sessions.db") });
  db.orm.insert(tables.projects).values({ id: "project", name: "managed", createdAt: 1, updatedAt: 2, lastOpenedAt: 3 }).run();
  db.orm.insert(tables.projectLocations).values({ id: "location", projectId: "project", path: oldCwd, normalizedPath: oldCwd.replace(/\\/g, "/").toLowerCase(), status: "active", boundAt: 1 }).run();
  for (const id of ["formal", "unbound", "external"]) db.orm.insert(tables.sessions).values({ id, projectId: id === "formal" ? "project" : null, cwd: id === "external" ? join(root, "real-project") : oldCwd, cwdRelative: id === "formal" ? "" : null, title: oldCwd, model: "m", status: "idle", metadataJson: JSON.stringify({ ...(id === "formal" ? { desktop: { settingsRoot: oldCwd } } : {}), prompt: oldCwd }), createdAt: 1, updatedAt: 2 }).run();
  db.orm.insert(tables.sessionInputs).values({ id: "input", sessionId: "formal", seq: 1, delivery: "immediate", content: oldCwd, itemsJson: JSON.stringify([{ type: "text", text: oldCwd }]), metadataJson: "{}", createdAt: 1 }).run();
  db.orm.insert(tables.sessionMessages).values({ id: "message", sessionId: "formal", seq: 5, role: "assistant", inputId: "input", metadataJson: "{}", createdAt: 1, updatedAt: 2 }).run();
  db.orm.insert(tables.sessionMessageParts).values({ id: "part", sessionId: "formal", messageId: "message", seq: 7, type: "text", status: "completed", text: oldCwd, inputJson: JSON.stringify({ command: oldCwd }), outputJson: JSON.stringify({ path: oldCwd }), metadataJson: "{}", createdAt: 1, updatedAt: 2 }).run();
  db.orm.insert(tables.sessionTasks).values({ id: "task", sessionId: "formal", type: "agent", status: "completed", description: oldCwd, cwd: oldCwd, output: oldCwd, metadataJson: JSON.stringify({ command: oldCwd, worktree: { path: oldCwd, branch: "task" } }), createdAt: 1, updatedAt: 2 }).run();
  db.orm.insert(tables.scheduledTasks).values({ id: "schedule", name: "s", prompt: oldCwd, recurrence: "0 * * * *", recurrenceFormat: "cron", timezone: "UTC", status: "active", destination: "new_session", projectPathsJson: JSON.stringify([oldCwd, join(root, "real-project")]), executionMode: "local", skillNamesJson: "[]", pluginNamesJson: "[]", permissionProfileJson: "{}", overlapPolicy: "skip", missedRunPolicy: "skip", createdBy: "user", runCount: 3, nextRunAt: 44, createdAt: 1, updatedAt: 2 }).run();
  db.orm.insert(tables.workflowRuns).values({ runId: "flow", status: "running", snapshotJson: JSON.stringify(snapshot()), originJson: origin, createdAt: 1, updatedAt: 2 }).run();
  db.orm.insert(tables.workflowRuns).values({ runId: "terminal", status: "completed", snapshotJson: '{"version":99,"summary":"original"}', createdAt: 1, updatedAt: 2 }).run();
  db.orm.insert(tables.workflowEvents).values({ workflowRunId: "flow", type: "task_started", eventJson: oldCwd, createdAt: 1 }).run();
  db.orm.insert(tables.attachmentAssets).values({ id: "asset", displayName: "attachment", status: "ready", sha256: blobHash, sizeBytes: 4, chatSourcesJson: `[${origin},{"storage":"sqlite","sessionId":"formal"}]`, createdAt: 1, updatedAt: 2 }).run();
  db.orm.insert(tables.notes).values({ id: "legacy-note", content: `# ${oldCwd}`, createdAt: 1, updatedAt: 2 }).run();
  db.close();
  mkdirSync(join(source, "notes")); writeFileSync(join(source, "notes", "note.md"), `# preserved ${oldCwd}`);
  mkdirSync(join(source, "attachments", "blobs", blobHash.slice(0, 2)), { recursive: true }); writeFileSync(join(source, "attachments", "blobs", blobHash.slice(0, 2), blobHash), "blob");
  cpSync(source, join(root, "owned-copy"), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it("relocates only structured fields in the owned SQLite copy and keeps identities, text, sources and files readable", async () => {
  const before = readFileSync(join(source, "sessions.db"));
  expect(relocate(copy, moves()).unsupported).toEqual([]);
  const db = new Database(copy, { readonly: true, fileMustExist: true });
  try {
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok"); expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.prepare("SELECT id,cwd,cwd_relative,title,created_at,updated_at FROM session WHERE id='formal'").get()).toEqual({ id: "formal", cwd: newCwd, cwd_relative: "", title: oldCwd, created_at: 1, updated_at: 2 });
    expect(db.prepare("SELECT path FROM project_location").get()).toEqual({ path: newCwd });
    expect(db.prepare("SELECT cwd,output FROM session_task").get()).toEqual({ cwd: newCwd, output: oldCwd });
    const schedule = db.prepare("SELECT * FROM scheduled_task").get() as any;
    expect(JSON.parse(schedule.project_paths_json)).toEqual([newCwd, join(root, "real-project")]); expect(schedule.prompt).toBe(oldCwd); expect(schedule.next_run_at).toBe(44);
    expect(db.prepare("SELECT content,items_json FROM session_input").get()).toEqual({ content: oldCwd, items_json: JSON.stringify([{ type: "text", text: oldCwd }]) });
    expect(db.prepare("SELECT id,seq,text,input_json,output_json FROM session_message_part").get()).toEqual({ id: "part", seq: 7, text: oldCwd, input_json: JSON.stringify({ command: oldCwd }), output_json: JSON.stringify({ path: oldCwd }) });
    const flow = db.prepare("SELECT * FROM workflow_run WHERE run_id='flow'").get() as any;
    const next = JSON.parse(flow.snapshot_json); expect(next.runningTasks.work.metadata.worktree.path).toBe(newCwd); expect(next.spec.tasks[0].writeScope).toEqual([newCwd]); expect(next.spec.tasks[0].prompt).toBe(oldCwd); expect(next.runningTasks.work.metadata.command).toBe(oldCwd); expect(flow.origin_json).toBe(origin);
    expect(db.prepare("SELECT snapshot_json FROM workflow_run WHERE run_id='terminal'").get()).toEqual({ snapshot_json: '{"version":99,"summary":"original"}' });
    expect(db.prepare("SELECT event_json FROM workflow_event").get()).toEqual({ event_json: oldCwd });
    expect((db.prepare("SELECT chat_sources_json FROM attachment_asset").get() as any).chat_sources_json).toBe(`[${origin},{"storage":"sqlite","sessionId":"formal"}]`);
    expect((db.prepare("SELECT content FROM note").get() as any).content).toBe(`# ${oldCwd}`);
    expect(db.prepare("SELECT id FROM session WHERE id='temporary-id'").get()).toBeUndefined();
    expect(readNoteFile(join(root, "owned-copy", "notes", "note.md"))?.content).toBe(`# preserved ${oldCwd}`);
    const stream = await new AttachmentBlobStore({ root: join(root, "owned-copy", "attachments") }).open(blobHash, 4);
    expect(await new Response(stream).text()).toBe("blob");
  } finally { db.close(); }
  expect(readFileSync(join(source, "sessions.db"))).toEqual(before);
  expect(relocate(copy, moves()).changed).toBe(0);
});

it("returns only path registrations from a stopped copy and validates the schema", () => {
  const found = inspect(copy, { managedRoots: [] });
  expect(found.schema).toBe("supported"); expect(found.unsupported).toEqual([]);
  expect(found.projectPaths).toEqual([oldCwd, join(root, "real-project")].sort()); expect(found.workspacePaths).toEqual([]);
  expect(found.cwdPaths).toContain(join(root, "real-project"));
  expect(JSON.stringify(found)).not.toContain("temporary-input"); expect(found).not.toHaveProperty("metadata");
  const invalid = new Database(join(root, "unknown.db")); invalid.exec("CREATE TABLE session(id TEXT)"); invalid.close();
  expect(inspect(join(root, "unknown.db"), { managedRoots: [] }).schema).toBe("unsupported");
  expect(() => inspect(join(root, "absent.db"), { managedRoots: [] })).toThrow(); expect(existsSync(join(root, "absent.db"))).toBe(false);
});

it("refuses unknown recoverable snapshots before any database changes", () => {
  const db = new Database(copy); db.prepare("UPDATE workflow_run SET snapshot_json=? WHERE run_id='flow'").run('{"version":99}'); db.close();
  expect(relocate(copy, moves())).toMatchObject({ changed: 0, unsupported: [{ table: "workflow_run", id: "flow", version: 99 }] });
  const reopened = new Database(copy); expect((reopened.prepare("SELECT cwd FROM session WHERE id='formal'").get() as any).cwd).toBe(oldCwd); reopened.close();
});

it("blocks a recoverable snapshot whose identity disagrees with its database row", () => {
  const db = new Database(copy); db.prepare("UPDATE workflow_run SET snapshot_json=? WHERE run_id='flow'").run(JSON.stringify({ ...snapshot(), runId: "another-flow" })); db.close();
  expect(relocate(copy, moves())).toMatchObject({ changed: 0, unsupported: [{ table: "workflow_run", id: "flow", version: 1 }] });
});

it("rolls the whole transaction back on a destination project key collision", () => {
  const db = SessionDatabase.open({ path: copy });
  db.orm.insert(tables.projects).values({ id: "collision", name: "collision", createdAt: 1, updatedAt: 2, lastOpenedAt: 3 }).run();
  db.orm.insert(tables.projectLocations).values({ id: "collision", projectId: "collision", path: newCwd, normalizedPath: process.platform === "win32" ? newCwd.replace(/\\/g, "/").toLowerCase() : newCwd, status: "active", boundAt: 1 }).run(); db.close();
  expect(api).toHaveProperty("relocateDatabasePaths");
  expect(() => relocate(copy, moves())).toThrow(/UNIQUE/);
  const reopened = new Database(copy); expect((reopened.prepare("SELECT cwd FROM session WHERE id='formal'").get() as any).cwd).toBe(oldCwd); reopened.close();
});

it.each([
  { desktop: { workspaceMode: "outside_project" } },
  { source: "channel", externalConversation: { connector: "chat", chatId: "c" } },
  { desktop: { workspaceMode: "outside_project" }, scheduledTask: { taskId: "schedule", scheduledRunId: "run", destination: "standalone", executionMode: "local" } },
  { scheduledTask: { taskId: "schedule", scheduledRunId: "run", destination: "standalone", executionMode: "worktree", worktree: { path: "fixture", branch: "task" } } },
])("recognizes allocated project locations using persisted provenance: %j", metadata => {
  const db = new Database(copy);
  if (metadata.scheduledTask?.worktree) metadata.scheduledTask.worktree.path = oldCwd;
  db.prepare("UPDATE session SET metadata_json=? WHERE id='formal'").run(JSON.stringify(metadata));
  db.close();
  const found = inspect(copy, { managedRoots: [source] });
  expect(found.projectPaths).toEqual([join(root, "real-project")]); expect([...found.workspacePaths, ...found.channelPaths, ...found.worktreePaths]).toContain(oldCwd); expect(found.unsupported).toEqual([]);
});

it("protects a schedule-only project under Documents/Vykor without claiming it as an allocated workspace", () => {
  const documents = join(root, "Documents", "Vykor"), project = join(documents, "my-real-project");
  const scheduleCopy = join(root, "schedule-only.db"), db = SessionDatabase.open({ path: scheduleCopy });
  db.orm.insert(tables.scheduledTasks).values({ id: "never-run", name: "s", prompt: project, recurrence: "0 * * * *", recurrenceFormat: "cron", timezone: "UTC", status: "active", destination: "standalone", projectPathsJson: JSON.stringify([project]), executionMode: "local", skillNamesJson: "[]", pluginNamesJson: "[]", permissionProfileJson: "{}", overlapPolicy: "skip", missedRunPolicy: "skip", createdBy: "user", runCount: 0, createdAt: 1, updatedAt: 2 }).run();
  expect(db.orm.select().from(tables.sessions).all()).toEqual([]); expect(db.orm.select().from(tables.projectLocations).all()).toEqual([]); db.close();
  const before = readFileSync(scheduleCopy);
  expect(inspect(scheduleCopy, { managedRoots: [documents] })).toMatchObject({ schema: "supported", workspacePaths: [], projectPaths: [project], cwdPaths: [project], unsupported: [] });
  expect(readFileSync(scheduleCopy)).toEqual(before);
});

it("keeps schedule references to proven allocated workspaces eligible for relocation", () => {
  const db = new Database(copy); db.prepare("UPDATE session SET metadata_json=? WHERE id='formal'").run(JSON.stringify({ desktop: { workspaceMode: "outside_project" } })); db.close();
  const found = inspect(copy, { managedRoots: [source] });
  expect(found.workspacePaths).toContain(oldCwd); expect(found.projectPaths).not.toContain(oldCwd); expect(found.unsupported).toEqual([]);
  expect(relocate(copy, moves()).unsupported).toEqual([]);
  const reopened = new Database(copy, { readonly: true });
  try { expect(JSON.parse((reopened.prepare("SELECT project_paths_json FROM scheduled_task WHERE id='schedule'").get() as any).project_paths_json)).toEqual([newCwd, join(root, "real-project")]); } finally { reopened.close(); }
});

it("blocks ambiguous project ownership and unknown database tables", () => {
  expect(inspect(copy, { managedRoots: [source] }).unsupported).toContainEqual({ table: "project_location", id: "location" });
  const db = new Database(copy); db.exec("CREATE TABLE future_execution(path TEXT)"); db.close();
  expect(relocate(copy, moves())).toMatchObject({ changed: 0, unsupported: expect.arrayContaining([{ table: "future_execution", id: "schema" }]) });
});

it("classifies a channel fork as an ordinary workspace and rejects a stale worktree binding", () => {
  const db = new Database(copy);
  db.prepare("UPDATE session SET metadata_json=? WHERE id='formal'").run(JSON.stringify({ source: "channel", fork: { sourceSessionId: "origin" }, desktop: { workspaceMode: "outside_project" } }));
  db.close();
  const fork = inspect(copy, { managedRoots: [source] }); expect(fork.channelPaths).toEqual([]); expect(fork.workspacePaths).toContain(oldCwd);
  const stale = new Database(copy); stale.prepare("UPDATE session SET metadata_json=? WHERE id='formal'").run(JSON.stringify({ desktop: { worktree: { path: join(source, "another"), branch: "task" } } })); stale.close();
  expect(inspect(copy, { managedRoots: [source] }).unsupported).toContainEqual({ table: "session", id: "formal" });
});

it("rejects a copy missing the project path uniqueness constraint", () => {
  const db = new Database(copy); db.exec("DROP INDEX project_location_active_path"); db.close();
  expect(relocate(copy, moves())).toMatchObject({ changed: 0, unsupported: expect.arrayContaining([{ table: "project_location", id: "schema" }]) });
});

it.each([
  ["project_location_active_path", "UNIQUE", "id", ""],
  ["project_location_active_path", "UNIQUE", "normalized_path", " WHERE \"project_location\".\"status\" = 'inactive'"],
  ["project_location_active_path", "UNIQUE", "normalized_path", ""],
  ["project_location_active_project", "UNIQUE", "id", " WHERE \"project_location\".\"status\" = 'active'"],
  ["project_location_active_project", "UNIQUE", "project_id", " WHERE \"project_location\".\"status\" = 'inactive'"],
  ["project_location_project_idx", "", "status,project_id", ""],
])("rejects a same-name index with changed columns or predicate: %s (%s %s%s)", (name, unique, columns, predicate) => {
  const db = SessionDatabase.open({ path: copy });
  db.orm.insert(tables.projects).values({ id: "collision", name: "collision", createdAt: 1, updatedAt: 2, lastOpenedAt: 3 }).run();
  db.orm.insert(tables.projectLocations).values({ id: "collision", projectId: "collision", path: newCwd, normalizedPath: process.platform === "win32" ? newCwd.replace(/\\/g, "/").toLowerCase() : newCwd, status: "active", boundAt: 1 }).run();
  db.connection.exec(`DROP INDEX ${name}; CREATE ${unique} INDEX ${name} ON project_location(${columns})${predicate}`); db.close();
  const before = readFileSync(copy);
  expect(inspect(copy, { managedRoots: [] })).toMatchObject({ schema: "unsupported", unsupported: expect.arrayContaining([{ table: "project_location", id: "schema" }]) });
  expect(relocate(copy, moves())).toMatchObject({ changed: 0, unsupported: expect.arrayContaining([{ table: "project_location", id: "schema" }]) });
  const reopened = new Database(copy, { readonly: true });
  try {
    expect((reopened.prepare("SELECT cwd FROM session WHERE id='formal'").get() as any).cwd).toBe(oldCwd);
    expect(reopened.prepare("SELECT path FROM project_location ORDER BY id").all()).toEqual([{ path: newCwd }, { path: oldCwd }]);
  } finally { reopened.close(); }
  expect(readFileSync(copy)).toEqual(before);
});

it("reads committed registrations in an owned WAL copy without initializing or losing them", () => {
  const writer = SessionDatabase.open({ path: join(root, "wal-source.db") });
  try {
    writer.orm.insert(tables.projects).values({ id: "wal", name: "wal", createdAt: 1, updatedAt: 2, lastOpenedAt: 3 }).run();
    writer.orm.insert(tables.projectLocations).values({ id: "wal", projectId: "wal", path: join(root, "external-wal"), normalizedPath: "external-wal", status: "active", boundAt: 1 }).run();
    for (const suffix of ["", "-wal", "-shm"]) copyFileSync(`${writer.path}${suffix}`, `${copy}${suffix}`);
    expect(inspect(copy, { managedRoots: [] }).projectPaths).toEqual([join(root, "external-wal")]);
  } finally { writer.close(); }
});

it("keeps a child worktree attached to its external main project and recomputes its relative cwd", () => {
  const external = join(root, "external-project"), db = SessionDatabase.open({ path: copy });
  db.orm.insert(tables.projects).values({ id: "external-project", name: "external", createdAt: 1, updatedAt: 2, lastOpenedAt: 3 }).run();
  db.orm.insert(tables.projectLocations).values({ id: "external-location", projectId: "external-project", path: external, normalizedPath: external, status: "active", boundAt: 1 }).run();
  db.orm.insert(tables.sessions).values({ id: "child", parentId: "formal", projectId: "external-project", cwd: oldCwd, cwdRelative: relative(external, oldCwd), title: "child", model: "m", status: "idle", metadataJson: "{}", createdAt: 1, updatedAt: 2 }).run(); db.close();
  expect(relocate(copy, moves()).unsupported).toEqual([]);
  const reopened = new Database(copy);
  try { expect(reopened.prepare("SELECT project_id,cwd,cwd_relative FROM session WHERE id='child'").get()).toEqual({ project_id: "external-project", cwd: newCwd, cwd_relative: relative(external, newCwd) }); expect(reopened.prepare("SELECT path FROM project_location WHERE id='external-location'").get()).toEqual({ path: external }); } finally { reopened.close(); }
});
