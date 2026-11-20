import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRunScope, ToolContext, ToolResult } from "@vykor/agent-contracts";
import type { RunStatus } from "@vykor/domain-contracts/sessions";
import { SessionStore } from "@vykor/services";
import { createSessionDiscoveryTool } from "../session-discovery-tool.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  cleanups.splice(0).reverse().forEach(cleanup => cleanup());
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "session-discovery-"));
  const cwd = join(directory, "current");
  for (const path of [cwd, join(cwd, "child"), join(directory, "neighbor"), join(directory, "worktree")]) {
    mkdirSync(path, { recursive: true });
  }
  const store = new SessionStore({ path: join(directory, "state.db") });
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }), () => store.close());
  const owner = store.acquireApplicationOwner({ ownerId: "lookup-test", pid: process.pid, staleAfterMs: 30_000 });
  let ownershipLost = false;
  let accepting = true;
  const active = new Map<string, string>();
  const projectId = store.projects.inspect(directory).id;
  const session = (id: string, options: Partial<Parameters<typeof store.sessions.create>[0]> = {}) =>
    store.sessions.create({ id, cwd, projectId, model: "test", ...options });
  session("source", { title: "Desktop source" });
  const { input, run } = store.conversationTransactions.admitPromptWithRun({
    prompt: { sessionId: "source", delivery: "queue", items: [{ type: "text", text: "查同目录会话的状态" }] },
    run: { metadata: { sessionLookupAllowed: true } },
  });
  store.runs.updateRun(run.id, { status: "running" });
  const controller = new AbortController();
  const scope: AgentRunScope = {
    agentId: "source", sessionId: "source", runId: run.id, inputId: input.id, cwd, traceId: "trace", signal: controller.signal,
  };
  const tool = createSessionDiscoveryTool({
    store, activeRunId: id => active.get(id),
    assertApplicationOwner: () => {
      if (ownershipLost) throw new Error("lost lease");
      store.assertApplicationOwner(owner);
    },
    accepting: () => accepting,
  }, scope);
  if (!tool) throw new Error("Expected SessionLookup for the eligible source");
  const lookup = (input: Record<string, unknown>, scopeOverrides: Partial<AgentRunScope> = {}) =>
    tool.execute(input, { cwd, agent: { scope: { ...scope, ...scopeOverrides } } as ToolContext["agent"] });
  const addRun = (sessionId: string, id: string, status: RunStatus) => {
    store.runs.createRun({ id, sessionId, metadata: { private: "not returned" } });
    return store.runs.updateRun(id, { status, error: "private Run error" });
  };
  const bind = (sessionId: string) => store.channels.upsertConversation({ connector: "example", accountId: "account", chatId: sessionId, sessionId });
  return { directory, cwd, projectId, store, scope, lookup, session, addRun, active, bind, controller,
    stopAccepting: () => { accepting = false; }, loseOwnership: () => { ownershipLost = true; } };
}

function read(result: ToolResult): unknown {
  expect(result.isError).not.toBe(true);
  const message = result.content[0];
  if (message?.type !== "text") throw new Error("Expected a JSON SessionLookup result");
  return JSON.parse(message.text);
}

describe("SessionLookup", () => {
  it("matches stored titles exclusively within the exact host cwd of a durable root", async () => {
    const f = fixture();
    f.session("target", { title: "  Desktop\t build.  with punctuation.  " });
    const run = f.addRun("target", "finished", "completed");
    f.session("neighbor", { cwd: join(f.directory, "neighbor"), title: "Desktop neighbor" });
    f.session("subdirectory", { cwd: join(f.cwd, "child"), title: "Desktop subdirectory" });
    const worktree = f.session("another-worktree", { cwd: join(f.directory, "worktree"), title: "Desktop worktree" });
    expect(worktree.projectId).toBe(f.projectId);
    expect(worktree.cwd).not.toBe(f.cwd);
    f.session("child", { parentId: "target", title: "Desktop child" });
    f.session("temporary", { storage: "memory", title: "Desktop temporary" });
    f.session("archived", { title: "Desktop archive" });
    f.store.sessions.archive("archived");
    f.session("closing", { title: "Desktop closing" });
    f.store.sessions.beginArchive("closing");
    f.session("channel", { title: "Desktop channel" });
    f.bind("channel");
    f.session("untitled");
    const { run: privateRun, input } = f.store.conversationTransactions.admitPromptWithRun({
      prompt: { sessionId: "untitled", items: [{ type: "text", text: "Private Desktop prompt" }] },
    });
    f.store.conversations.createMessage({ sessionId: "untitled", role: "user", inputId: input.id, runId: privateRun.id });
    f.store.sessions.update("untitled", { title: "" });

    expect(read(await f.lookup({ query: " dESkTOP " }))).toEqual({
      matches: [{ title: "Desktop build. with punctuation.", status: "completed", updatedAt: run.updatedAt }], hasMore: false,
    });
    expect(read(await f.lookup({ query: "missing" }))).toEqual({ matches: [], hasMore: false });
  });

  it("selects the active Run, oldest queued Run, or last terminal Run in that order", async () => {
    const f = fixture();
    const target = f.session("target", { title: "Desktop" });
    const expected = (status: RunStatus | "idle", updatedAt: number) => ({ matches: [{ title: "Desktop", status, updatedAt }], hasMore: false });
    const lookup = async () => read(await f.lookup({ query: "Desktop" }));

    expect(await lookup()).toEqual(expected("idle", target.updatedAt));
    const older = f.addRun(target.id, "older", "pending");
    f.addRun(target.id, "later", "pending");
    expect(await lookup()).toEqual(expected("pending", older.updatedAt));
    const running = f.addRun(target.id, "running", "running");
    expect(await lookup()).toEqual(expected("running", running.updatedAt));
    f.active.set(target.id, older.id);
    expect(await lookup()).toEqual(expected("pending", older.updatedAt));
    f.store.runs.updateRun(older.id, { status: "completed" });
    f.store.runs.updateRun("later", { status: "failed" });
    const interrupted = f.store.runs.updateRun("running", { status: "interrupted" });
    expect(await lookup()).toEqual(expected("interrupted", interrupted.updatedAt));
    const failed = f.addRun(target.id, "failed", "failed");
    expect(await lookup()).toEqual(expected("failed", failed.updatedAt));
  });

  it("caps same-title results using session update time and a stable ID tie-break", async () => {
    const f = fixture();
    const now = vi.spyOn(Date, "now").mockReturnValue(300);
    for (const id of ["z", "e", "d", "c", "b", "a"]) {
      f.session(id, { title: "Desktop" });
    }
    for (const [id, time] of [["a", 100], ["b", 101], ["c", 102], ["d", 103], ["e", 104], ["z", 105]] as const) {
      now.mockReturnValue(time);
      f.addRun(id, `${id}-run`, "completed");
    }
    now.mockReturnValue(600);
    for (const id of ["a", "b", "c", "d", "e"]) f.store.sessions.update(id, { title: "Desktop" });
    now.mockReturnValue(700);
    f.store.sessions.update("z", { title: "Desktop" });
    const readRuns = vi.spyOn(f.store.runs, "listRuns");

    expect(read(await f.lookup({ query: "Desktop" }))).toEqual({
      matches: [105, 100, 101, 102, 103].map(updatedAt => ({ title: "Desktop", status: "completed", updatedAt })), hasMore: true,
    });
    expect(readRuns.mock.calls.map(([id]) => id)).toEqual(["z", "a", "b", "c", "d"]);
  });

  it("uses one Unicode-safe display title for matching and returning results", async () => {
    const f = fixture();
    const emoji = "📦".repeat(120);
    const title = f.session("long", { title: `  ${emoji} Outside title budget` });
    const untitled = f.session("untitled", { title: " \t  " });
    expect(read(await f.lookup({ query: emoji }))).toEqual({ matches: [{ title: emoji, status: "idle", updatedAt: title.updatedAt }], hasMore: false });
    expect(read(await f.lookup({ query: "未命名" }))).toEqual({ matches: [{ title: "未命名会话", status: "idle", updatedAt: untitled.updatedAt }], hasMore: false });
    expect(read(await f.lookup({ query: "Outside title budget" }))).toEqual({ matches: [], hasMore: false });
    for (const input of [{}, { query: " " }, { query: "📦".repeat(121) }, { query: "Desktop", cwd: f.cwd }, { query: 42 }]) {
      expect(await f.lookup(input)).toMatchObject({ isError: true });
    }
  });

  it.each([
    { change: "source no longer eligible", mutate: (f: ReturnType<typeof fixture>) => f.bind("source") },
    { change: "application no longer accepts work", mutate: (f: ReturnType<typeof fixture>) => f.stopAccepting() },
    { change: "application lost its lease", mutate: (f: ReturnType<typeof fixture>) => f.loseOwnership() },
    { change: "Run cancelled", mutate: (f: ReturnType<typeof fixture>) => f.controller.abort() },
    { change: "Run finished", mutate: (f: ReturnType<typeof fixture>) => f.store.runs.updateRun(f.scope.runId, { status: "completed" }) },
    { change: "eligibility revoked", mutate: (f: ReturnType<typeof fixture>) => f.store.runs.updateRun(f.scope.runId, { metadata: { sessionLookupAllowed: false } }) },
    { change: "Run is a recovery replay", mutate: (f: ReturnType<typeof fixture>) => f.store.runs.updateRun(f.scope.runId, { metadata: { recovery: { kind: "prompt_replay" } } }) },
    { change: "Run is a recovered admission", mutate: (f: ReturnType<typeof fixture>) => f.store.runs.updateRun(f.scope.runId, { metadata: { recoveredAdmission: true } }) },
    { change: "Run is attached to a Goal", mutate: (f: ReturnType<typeof fixture>) => f.store.runs.updateRun(f.scope.runId, { metadata: { goalId: "goal" } }) },
    { change: "Run is a Goal user turn", mutate: (f: ReturnType<typeof fixture>) => f.store.runs.updateRun(f.scope.runId, { metadata: { goalRunKind: "user" } }) },
  ])("returns no data when $change", async ({ mutate }) => {
    const f = fixture();
    f.session("target", { title: "Desktop private" });
    mutate(f);
    const result = await f.lookup({ query: "Desktop" });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain("Desktop private");
  });

  it("rejects a mismatched Agent, session, Run, input or cwd", async () => {
    const f = fixture();
    for (const key of ["agentId", "sessionId", "runId", "inputId", "cwd"]) {
      expect(await f.lookup({ query: "Desktop" }, { [key]: "different" })).toMatchObject({ isError: true });
    }
  });
});
