import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createDefaultNodeAgent } from "../../agent/default-agent.js";
import { NodeChildManager } from "../node-child-manager.js";
import { AgentEventBus } from "../../../kernel/event-source.js";
import type { AgentRunHandle, AgentRunScope, StreamingMessageClient } from "@vykor/agent-contracts";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

it.each(["initial", "followup"] as const)("retains the actual dispatched handle on lost %s started ACK until Read and cleanup both stop", async mode => {
  const directory = mkdtempSync(join(tmpdir(), "child-lost-ack-"));
  writeFileSync(join(directory, "held.txt"), "actual file");
  const entered = gate(), released = gate(), cleanupEntered = gate(), cleanupReleased = gate();
  let actualRun!: AgentRunHandle;
  let calls = 0;
  const client: StreamingMessageClient = { async *streamMessage(params) {
    calls++;
    const last = params.messages.at(-1);
    if (last?.type === "user" && last.content === "lost-ack") {
      yield { type: "tool_use_start", toolUse: { type: "tool_use", id: "actual-read", name: "Read", input: { file_path: join(directory, "held.txt") } } };
      yield { type: "complete", stopReason: "tool_use" };
    } else {
      yield { type: "text_delta", delta: "next result" };
      yield { type: "complete", stopReason: "end_turn" };
    }
  } };
  const settings = { model: "offline", apiFormat: "openai" as const, permission: { mode: "full_access" as const }, plugins: { enabled: false }, memory: { enabled: false }, sandbox: { enabled: false }, childBudget: { maxActiveChildren: 1 } };
  const root = await createDefaultNodeAgent({ cwd: directory, settings, client });
  const manager = new NodeChildManager({ cwd: directory, settings, configuration: { client }, eventBus: new AgentEventBus(),
    createAgent: async options => {
      const node = await createDefaultNodeAgent({ ...options, client,
        toolDecorators: [{ name: "Read", decorate: base => ({ ...base, execute: async (input, context) => {
          const result = await base.execute(input, context);
          entered.resolve(); await released.promise; return result;
        } }) }],
        onRunCapabilities: snapshot => async () => { if (snapshot.scope.runId === actualRun?.id) { cleanupEntered.resolve(); await cleanupReleased.promise; } },
      });
      const submit = node.submitMessage.bind(node);
      node.submitMessage = (content, input) => {
        const run = submit(content, input);
        if (content === "lost-ack") {
          actualRun = run;
          const acknowledged = run.started;
          Object.defineProperty(run, "started", { value: acknowledged.then(async () => {
            await entered.promise;
            throw new Error("lost started acknowledgement");
          }) });
        }
        return run;
      };
      return node;
    },
  });
  const scope: AgentRunScope = { agentId: root.id, sessionId: root.id, runId: "parent", inputId: "parent-input", traceId: "trace", cwd: directory, signal: new AbortController().signal };
  const view = root.host.plugins.createRunCapabilityView();
  try {
    const first = mode === "followup" ? await manager.createController(scope, view).spawnChildAgent({ prompt: "first", description: "first", agent: "worker", cwd: directory, allowedTools: ["Read"] }) : undefined;
    if (first) await first.result;
    const spawning = first ? manager.createController(scope, view).sendChildInput(first.id, { content: "lost-ack" })
      : manager.createController(scope, view).spawnChildAgent({ prompt: "lost-ack", description: "lost ACK", agent: "worker", cwd: directory, allowedTools: ["Read"] });
    await expect(spawning).rejects.toThrow("lost started acknowledgement");
    await entered.promise;
    const handle = manager.list()[0]!;
    expect(handle.readRun(actualRun.id).stopping).toBe(true);
    expect(handle.readRun(actualRun.id).result).toBeUndefined();
    expect(manager.getBudgetSnapshot().activeChildren).toBe(1);
    await expect(manager.createController(scope, view).spawnChildAgent({ prompt: "denied", description: "denied", agent: "worker", cwd: directory })).rejects.toThrow("activeChildren");
    released.resolve(); await cleanupEntered.promise;
    expect(handle.readRun(actualRun.id).result).toBeUndefined();
    expect(manager.getBudgetSnapshot().activeChildren).toBe(1);
    cleanupReleased.resolve();
    await actualRun.settled;
    await vi.waitFor(() => expect(manager.getBudgetSnapshot().activeChildren).toBe(0));
    if (first) {
      const next = await manager.createController(scope, view).sendChildInput(first.id, { content: "next" });
      expect((await handle.waitRun(next.runId)).result?.output).toBe("next result");
    } else {
      const next = await manager.createController(scope, view).spawnChildAgent({ prompt: "next", description: "next", agent: "worker", cwd: directory });
      expect((await next.result).output).toBe("next result");
    }
    expect(calls).toBe(first ? 3 : 2);
  } finally {
    released.resolve(); cleanupReleased.resolve();
    await manager.closeAll(); await root.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("keeps failed initial preparation owned until environment cleanup is confirmed", async () => {
  const directory = mkdtempSync(join(tmpdir(), "child-prepare-cleanup-"));
  const settings = { model: "offline", apiFormat: "openai" as const, permission: { mode: "full_access" as const }, plugins: { enabled: false }, memory: { enabled: false }, sandbox: { enabled: false }, childBudget: { maxActiveChildren: 1 } };
  let failCreate = true, failRelease = true, releases = 0;
  const client: StreamingMessageClient = { async *streamMessage() { yield { type: "text_delta", delta: "actual next" }; yield { type: "complete", stopReason: "end_turn" }; } };
  const manager = new NodeChildManager({ cwd: directory, settings, configuration: { client }, eventBus: new AgentEventBus(),
    environment: { acquire: async input => ({ cwd: input.cwd, release: async () => { releases++; if (failRelease) throw new Error("environment cleanup unconfirmed"); } }) },
    createAgent: async options => { if (failCreate) throw new Error("create fault before dispatch"); return createDefaultNodeAgent({ ...options, client }); },
  });
  const scope: AgentRunScope = { agentId: "parent", sessionId: "parent", runId: "parent", inputId: "i", traceId: "t", cwd: directory, signal: new AbortController().signal };
  try {
    await expect(manager.createController(scope).spawnChildAgent({ prompt: "fault", description: "fault", agent: "worker", cwd: directory })).rejects.toThrow("startup cleanup failed");
    const handle = manager.list()[0]!;
    expect(handle.state).toBe("closing");
    expect(manager.getBudgetSnapshot().activeChildren).toBe(1);
    await expect(manager.createController(scope).spawnChildAgent({ prompt: "denied", description: "denied", agent: "worker", cwd: directory })).rejects.toThrow("activeChildren");
    failRelease = false; failCreate = false;
    await handle.close();
    expect(manager.getBudgetSnapshot().activeChildren).toBe(0);
    const next = await manager.createController(scope).spawnChildAgent({ prompt: "next", description: "next", agent: "worker", cwd: directory });
    expect((await next.result).output).toBe("actual next");
    expect(releases).toBe(2);
  } finally { failRelease = false; await manager.closeAll(); rmSync(directory, { recursive: true, force: true }); }
});

it("revokes a real resumed instance before returning the aborted followup permit", async () => {
  const directory = mkdtempSync(join(tmpdir(), "child-resume-race-"));
  const created = gate(), returnCreated = gate(), cleanup = gate(), releaseCleanup = gate();
  let creations = 0, modelCalls = 0;
  const settings = { model: "offline", apiFormat: "openai" as const, permission: { mode: "full_access" as const }, plugins: { enabled: false }, memory: { enabled: false }, sandbox: { enabled: false }, childBudget: { maxActiveChildren: 1 } };
  const client: StreamingMessageClient = { async *streamMessage() { modelCalls++; yield { type: "text_delta", delta: "actual output" }; yield { type: "complete", stopReason: "end_turn" }; } };
  const manager = new NodeChildManager({ cwd: directory, settings, configuration: { client }, eventBus: new AgentEventBus(), idleTtlMs: 1,
    createAgent: async options => {
      const node = await createDefaultNodeAgent({ ...options, client });
      if (++creations === 2) {
        const close = node.close.bind(node);
        node.close = async () => { await close(); cleanup.resolve(); await releaseCleanup.promise; };
        created.resolve(); await returnCreated.promise;
      }
      return node;
    },
  });
  const scope: AgentRunScope = { agentId: "parent", sessionId: "parent", runId: "parent", inputId: "i", traceId: "t", cwd: directory, signal: new AbortController().signal };
  try {
    const a = await manager.createController(scope).spawnChildAgent({ prompt: "first", description: "first", agent: "worker", cwd: directory });
    await a.result;
    await vi.waitFor(() => expect(manager.get(a.id)?.state).toBe("suspended"));
    const abort = new AbortController();
    const pending = manager.createController({ ...scope, runId: "followup-parent", signal: abort.signal }).sendChildInput(a.id, { id: "aborted-followup", content: "must-not-dispatch" });
    const rejected = expect(pending).rejects.toThrow("Parent run interrupted");
    await created.promise;
    abort.abort(); returnCreated.resolve(); await cleanup.promise;
    expect(manager.getBudgetSnapshot().activeChildren).toBe(1);
    expect(modelCalls).toBe(1);
    await expect(manager.createController(scope).spawnChildAgent({ prompt: "denied", description: "denied", agent: "worker", cwd: directory })).rejects.toThrow("activeChildren");
    releaseCleanup.resolve(); await rejected;
    expect(manager.getBudgetSnapshot().activeChildren).toBe(0);
    await manager.createController(scope).sendChildInput(a.id, { content: "after-race" });
    expect((await manager.get(a.id)!.result).output).toBe("actual output");
    expect(modelCalls).toBe(2);
  } finally { returnCreated.resolve(); releaseCleanup.resolve(); await manager.closeAll(); rmSync(directory, { recursive: true, force: true }); }
});

it("allows explicit cleanup confirmation without replaying a completed model", async () => {
  const directory = mkdtempSync(join(tmpdir(), "child-cleanup-retry-"));
  let failCleanup = true, modelCalls = 0;
  const settings = { model: "offline", apiFormat: "openai" as const, permission: { mode: "full_access" as const }, plugins: { enabled: false }, memory: { enabled: false }, sandbox: { enabled: false }, childBudget: { maxActiveChildren: 1 } };
  const client: StreamingMessageClient = { async *streamMessage() { modelCalls++; yield { type: "text_delta", delta: "actual output" }; yield { type: "complete", stopReason: "end_turn" }; } };
  const manager = new NodeChildManager({ cwd: directory, settings, configuration: { client }, eventBus: new AgentEventBus(),
    createAgent: options => createDefaultNodeAgent({ ...options, client, onRunCapabilities: () => async () => { if (failCleanup) throw new Error("actual cleanup failed"); } }),
  });
  const scope: AgentRunScope = { agentId: "parent", sessionId: "parent", runId: "parent", inputId: "i", traceId: "t", cwd: directory, signal: new AbortController().signal };
  try {
    const a = await manager.createController(scope).spawnChildAgent({ prompt: "first", description: "first", agent: "worker", cwd: directory });
    const handle = manager.get(a.id)!;
    await vi.waitFor(() => expect(handle.readRun(a.runId)).toMatchObject({ stopping: true, cleanupUnconfirmed: { message: "actual cleanup failed" } }));
    expect(handle.readRun(a.runId).result).toBeUndefined();
    expect(manager.getBudgetSnapshot().activeChildren).toBe(1);
    failCleanup = false;
    await handle.close();
    expect(manager.getBudgetSnapshot().activeChildren).toBe(0);
    expect(modelCalls).toBe(1);
  } finally { failCleanup = false; await manager.closeAll(); rmSync(directory, { recursive: true, force: true }); }
});

it.each(["cancel", "close"] as const)("keeps the first %s waiter while a repeat confirms only failed cleanup", async mode => {
  const directory = mkdtempSync(join(tmpdir(), "child-repeat-cancel-"));
  const firstCleanup = gate(), failFirst = gate(), retryEntered = gate(), releaseRetry = gate();
  let cleanups = 0, calls = 0;
  const settings = { model: "offline", apiFormat: "openai" as const, permission: { mode: "full_access" as const }, plugins: { enabled: false }, memory: { enabled: false }, sandbox: { enabled: false }, childBudget: { maxActiveChildren: 1 } };
  const client: StreamingMessageClient = { async *streamMessage() { calls++; yield { type: "text_delta", delta: "actual result" }; yield { type: "complete", stopReason: "end_turn" }; } };
  const manager = new NodeChildManager({ cwd: directory, settings, configuration: { client }, eventBus: new AgentEventBus(),
    createAgent: options => createDefaultNodeAgent({ ...options, client, onRunCapabilities: () => async () => {
      if (++cleanups === 1) { firstCleanup.resolve(); await failFirst.promise; throw new Error("first cleanup failed"); }
      retryEntered.resolve(); await releaseRetry.promise;
    } }),
  });
  const scope: AgentRunScope = { agentId: "parent", sessionId: "parent", runId: "parent", inputId: "i", traceId: "t", cwd: directory, signal: new AbortController().signal };
  try {
    const a = await manager.createController(scope).spawnChildAgent({ prompt: "first", description: "first", agent: "worker", cwd: directory });
    const handle = manager.get(a.id)!;
    await firstCleanup.promise;
    const originalWaiter = handle.waitRun(a.runId);
    const originalClose = mode === "close" ? handle.close() : undefined;
    if (mode === "cancel") expect(await handle.interruptRun(a.runId)).toBe(true);
    failFirst.resolve();
    await vi.waitFor(() => expect(handle.readRun(a.runId).cleanupUnconfirmed?.message).toBe("first cleanup failed"));
    expect(manager.getBudgetSnapshot().activeChildren).toBe(1);
    const repeatedClose = mode === "close" ? handle.close() : undefined;
    if (mode === "cancel") expect(await handle.interruptRun(a.runId)).toBe(true);
    await retryEntered.promise;
    if (mode === "cancel") expect(await handle.interruptRun(a.runId)).toBe(true);
    expect(cleanups).toBe(2);
    releaseRetry.resolve();
    expect((await originalWaiter).result).toMatchObject({ status: "interrupted" });
    await originalClose; await repeatedClose;
    expect(manager.getBudgetSnapshot().activeChildren).toBe(0);
    expect(calls).toBe(1);
  } finally { failFirst.resolve(); releaseRetry.resolve(); await manager.closeAll(); rmSync(directory, { recursive: true, force: true }); }
});

it("keeps the original root close promise while a repeated close confirms its failed cleanup", async () => {
  const directory = mkdtempSync(join(tmpdir(), "root-repeat-close-"));
  const firstCleanup = gate(), failFirst = gate(), retryEntered = gate(), releaseRetry = gate();
  let calls = 0, cleanups = 0;
  const agent = await createDefaultNodeAgent({ cwd: directory,
    settings: { model: "offline", apiFormat: "openai", permission: { mode: "full_access" }, plugins: { enabled: false }, memory: { enabled: false }, sandbox: { enabled: false } },
    client: { async *streamMessage() { calls++; yield { type: "text_delta", delta: "actual root" }; yield { type: "complete", stopReason: "end_turn" }; } },
    onRunCapabilities: () => async () => { if (++cleanups === 1) { firstCleanup.resolve(); await failFirst.promise; throw new Error("root cleanup failed"); } retryEntered.resolve(); await releaseRetry.promise; },
  });
  try {
    const run = agent.submitMessage("root");
    await firstCleanup.promise;
    const closing = agent.close();
    failFirst.resolve();
    await vi.waitFor(() => expect(run.cleanupUnconfirmed?.message).toBe("root cleanup failed"));
    const repeated = agent.close();
    expect(repeated).toBe(closing);
    await retryEntered.promise;
    expect(cleanups).toBe(2);
    releaseRetry.resolve();
    await closing;
    expect((await run.settled).result.status).toBe("interrupted");
    expect(calls).toBe(1);
  } finally { failFirst.resolve(); releaseRetry.resolve(); await agent.close(); rmSync(directory, { recursive: true, force: true }); }
});
