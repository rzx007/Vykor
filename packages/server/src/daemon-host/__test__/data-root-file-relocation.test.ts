import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import * as api from "../data-root-file-relocation.js";
import { decodeWorkflowRunSnapshot } from "@vykor/coordinator/workflow";
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "relocate-files-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
const file = (path: string, value: unknown) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value)); };
it("relocates composer paths, Git manager roots and explicit settings fields while preserving user input", async () => {
  const old = join(root, "old"), target = join(root, "final"), stage = join(root, "stage"), shell = join(root, "electron"), external = join(root, "project");
  file(join(stage, "data", "desktop", "composer-recovery.json"), { version: 1, revision: 4, value: { version: 1, drafts: { session: { document: { version: 1, items: [{ type: "mention", name: "m", path: join(old, "a") }, { type: "text", text: old }] }, attachments: [] } }, submissions: [{ id: "input", sessionId: "session", items: [{ type: "skill", name: "s", path: join(old, "skill") }], attachments: [], createdAt: 1, placement: "queue" }] } });
  file(join(stage, "data", "desktop", "git-settings.json"), { version: 1, preferences: { worktreeRoot: shell }, worktrees: [{ id: "w", path: join(shell, "worktrees", "tree"), configDir: shell, projectPath: external, branch: "task", baseCommit: "abc" }] });
  file(join(stage, "settings.json"), { mcpServers: { managed: { type: "stdio", cwd: old, command: old, args: [old], env: { TOKEN: old } }, remote: { type: "http", url: old } }, sandbox: { filesystem: { allowRead: [old, external], extraAllowedRoots: [old] } }, permission: { pathRules: [{ pattern: join(old, "**"), allow: true }], deniedCommands: [old] }, terminal: { localShell: join(old, "shell") }, agentEnvironment: { kind: "native", shell: { executable: join(old, "shell"), args: [old] } }, systemPrompt: old });
  file(join(stage, "credentials.json"), { secret: old }); const credentials = readFileSync(join(stage, "credentials.json"));
  expect(api).toHaveProperty("relocateDataRootFiles");
  const result = await (api as any).relocateDataRootFiles({ stagedRoot: stage, targetRoot: target, moves: [{ kind: "user-root", from: old, to: target }, { kind: "worktree", from: join(shell, "worktrees"), to: join(target, "worktrees") }] });
  expect(result.unsupported).toEqual([]);
  const wrapper = JSON.parse(readFileSync(join(stage, "data", "desktop", "composer-recovery.json"), "utf8")); expect(wrapper.revision).toBe(4); const composer = wrapper.value;
  expect(composer.drafts.session.document.items).toEqual([{ type: "mention", name: "m", path: join(target, "a") }, { type: "text", text: old }]); expect(composer.submissions[0].items[0].path).toBe(join(target, "skill")); expect(composer.submissions[0].id).toBe("input");
  const git = JSON.parse(readFileSync(join(stage, "data", "desktop", "git-settings.json"), "utf8"));
  expect(git.preferences.worktreeRoot).toBe(target); expect(git.worktrees[0]).toEqual({ id: "w", path: join(target, "worktrees", "tree"), configDir: target, projectPath: external, branch: "task", baseCommit: "abc" });
  const settings = JSON.parse(readFileSync(join(stage, "settings.json"), "utf8"));
  expect(settings.mcpServers.managed).toEqual({ type: "stdio", cwd: target, command: old, args: [old], env: { TOKEN: old } }); expect(settings.sandbox.filesystem.allowRead).toEqual([target, external]); expect(settings.systemPrompt).toBe(old); expect(readFileSync(join(stage, "credentials.json"))).toEqual(credentials);
  expect(settings.permission.pathRules).toEqual([{ pattern: join(target, "**"), allow: true }]); expect(settings.permission.deniedCommands).toEqual([old]); expect(settings.terminal.localShell).toBe(join(target, "shell")); expect(settings.agentEnvironment.shell).toEqual({ executable: join(target, "shell"), args: [old] });
});

it("renames all three cwd hash keys in the staged copy and refuses different destination contents", async () => {
  const old = join(root, "old", "chat"), next = join(root, "final", "chat"), stage = join(root, "stage");
  const key = (cwd: string, folded: boolean) => `chat-${createHash("sha1").update(folded && process.platform === "win32" ? cwd.toLowerCase() : cwd).digest("hex").slice(0, 12)}`;
  const roots = [["local_rules/projects", false], ["data/memory", true], ["data/session-memory", false]] as const;
  for (const [base, fold] of roots) file(join(stage, base, key(old, fold), "facts.json"), { text: old, sourceSessionId: "id", last_updated: "original" });
  expect(api).toHaveProperty("relocateProjectStorageKeys");
  const options = { stagedRoot: stage, cwdPaths: [old], moves: [{ kind: "workspace", from: old, to: next }] };
  await (api as any).relocateProjectStorageKeys(options);
  for (const [base, fold] of roots) expect(JSON.parse(readFileSync(join(stage, base, key(next, fold), "facts.json"), "utf8"))).toEqual({ text: old, sourceSessionId: "id", last_updated: "original" });
  file(join(stage, "data/memory", key(old, true), "facts.json"), { different: true });
  await expect((api as any).relocateProjectStorageKeys(options)).rejects.toThrow(/conflict/i);
  expect(JSON.parse(readFileSync(join(stage, "data/memory", key(next, true), "facts.json"), "utf8"))).toEqual({ text: old, sourceSessionId: "id", last_updated: "original" });
});
it("blocks unknown composer recovery before writing any known file", async () => {
  const stage = join(root, "stage"); file(join(stage, "data", "desktop", "composer-recovery.json"), { version: 99 }); file(join(stage, "settings.json"), { mcpServers: { x: { type: "stdio", cwd: root } } });
  const before = readFileSync(join(stage, "settings.json")); expect(api).toHaveProperty("relocateDataRootFiles");
  const result = await (api as any).relocateDataRootFiles({ stagedRoot: stage, targetRoot: join(root, "target"), moves: [{ kind: "user-root", from: root, to: join(root, "target") }] });
  expect(result).toMatchObject({ changed: 0, unsupported: [{ table: "composer-recovery", id: "composer-recovery.json", version: 99 }] }); expect(readFileSync(join(stage, "settings.json"))).toEqual(before);
});

it("updates an already unified Git manager through the whole user-root move", async () => {
  const old = join(root, "old"), target = join(root, "final"), stage = join(root, "stage"), path = join(stage, "data", "desktop", "git-settings.json");
  file(path, { version: 1, preferences: { worktreeRoot: old }, worktrees: [{ id: "w", path: join(old, "worktrees", "w"), configDir: old, projectPath: join(root, "external") }] });
  const result = await api.relocateDataRootFiles({ stagedRoot: stage, targetRoot: target, moves: [{ kind: "user-root", from: old, to: target }] });
  expect(result.unsupported).toEqual([]); const saved = JSON.parse(readFileSync(path, "utf8")); expect(saved.preferences.worktreeRoot).toBe(target); expect(saved.worktrees[0].configDir).toBe(target); expect(saved.worktrees[0].path).toBe(join(target, "worktrees", "w"));
});

it("relocates a managed file workflow while retaining terminal snapshots and original events", async () => {
  const stage = join(root, "stage"), old = join(root, "old"), target = join(root, "final"), directory = join(stage, "workspaces", "chat", ".vykor", "workflows");
  const task = { id: "task", prompt: old, writeScope: [old, "relative/**"] };
  const snapshot = { version: 1, runId: "flow", status: "running", summary: old, spec: { mode: "sequential", tasks: [task] }, plan: { mode: "sequential", tasks: [task], maxConcurrency: 1, executionOrder: ["task"], dependencyMap: {}, dependentsMap: {} }, results: {}, orderedResults: [], pendingTaskIds: ["task"], blockedTaskIds: [], blockedTasks: {}, runningTaskIds: [], runningTasks: {}, budget: { tasks: {} }, createdAt: 1, updatedAt: 2 };
  file(join(directory, "flow.json"), snapshot); file(join(directory, "done.json"), { version: 99, status: "completed", summary: old });
  writeFileSync(join(directory, "flow.events.ndjson"), old);
  const input = { stagedRoot: stage, targetRoot: target, moves: [{ kind: "user-root", from: old, to: target }], workflowDirectories: [directory] };
  expect((await (api as any).relocateDataRootFiles(input)).unsupported).toEqual([]);
  const next = decodeWorkflowRunSnapshot(readFileSync(join(directory, "flow.json"), "utf8"));
  expect(next.spec.tasks[0]!.writeScope).toEqual([target, "relative/**"]); expect(next.spec.tasks[0]!.prompt).toBe(old); expect(readFileSync(join(directory, "flow.events.ndjson"), "utf8")).toBe(old);
  expect(JSON.parse(readFileSync(join(directory, "done.json"), "utf8"))).toEqual({ version: 99, status: "completed", summary: old });
  file(join(directory, "bad.json"), { version: 42, runId: "bad", status: "running" });
  expect((await (api as any).relocateDataRootFiles(input)).unsupported).toContainEqual({ table: "workflow-file", id: "bad.json", version: 42 });
});
