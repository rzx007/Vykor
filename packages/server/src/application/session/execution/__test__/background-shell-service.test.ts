import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SessionStore } from "@vykor/services";
import { DetachedProcessSupervisor } from "@vykor/execution-node";
import { SessionExecutionProjector } from "../../transcript/session-execution-projector.js";
import { createWslPathResolver } from "@vykor/sandbox";
import { DaemonOperationGate } from "../../../control/daemon-operation-gate.js";
import { BackgroundShellService } from "../background-shell-service.js";

const settings = { model: "offline", apiFormat: "openai" as const, maxTurns: 1, permission: { mode: "full_access" as const }, sandbox: { enabled: false } };
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function fixture(acquireEnvironment?: (...args: any[]) => Promise<any>) {
  const cwd = mkdtempSync(join(tmpdir(), "shell-adapter-"));
  const store = new SessionStore({ path: join(cwd, "sessions.db") });
  const manager = new DetachedProcessSupervisor(join(cwd, "output"));
  store.sessions.create({ id: "session", cwd, model: "offline" });
  const projector = new SessionExecutionProjector({ store, events: { checkpoint: () => 0, publishSince() {} }, traceIdForRun: id => id, log() {} });
  const service = new BackgroundShellService({ store: { getSession: id => store.sessions.get(id), listSessions: input => store.sessions.list(input), listSessionTasks: store.listSessionTasks.bind(store), getSessionTask: store.getSessionTask.bind(store), createSessionTask: store.createSessionTask.bind(store), reserveSessionTask: store.reserveSessionTask.bind(store), transitionPendingSessionTask: store.transitionPendingSessionTask.bind(store), updateSessionTask: store.updateSessionTask.bind(store) }, executionProjector: projector, getDetachedProcessSupervisor: () => manager, events: { checkpoint: () => 0, publishSince() {} }, getSettingsForCwd: async () => settings, acquireEnvironment });
  return { cwd, store, manager, service, close: async () => { await manager.aclose(); store.close(); rmSync(cwd, { recursive: true, force: true }); } };
}

describe("BackgroundShellService admission adapter", () => {
  it("combines a delayed WSL startup retry with real durable ownership and executionCwd", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oh-wsl-start-cwd-"));
    const store = new SessionStore({ path: join(dir, "store.db") });
    const manager = new DetachedProcessSupervisor(join(dir, "tasks"));
    // Persist a host-native absolute cwd on every OS. The acquired executor and
    // its WSL mount are simulated, so the execution root is independent of it.
    const hostRoot = dir;
    const binding = { kind: "wsl" as const, hostRoot, executionRoot: "/mnt/d/project" };
    const executionCwd = `${binding.executionRoot}/sub`;
    const gate = new DaemonOperationGate();
    let releaseAcquire!: (value: any) => void;
    let finishProcess!: (value: { exitCode: number }) => void;
    let launches = 0;
    let releases = 0;
    const acquired = new Promise<any>((resolve) => { releaseAcquire = resolve; });
    const waited = new Promise<{ exitCode: number }>((resolve) => { finishProcess = resolve; });
    const projector = new SessionExecutionProjector({ store,
      events: { checkpoint: () => 0, publishSince: () => {} }, traceIdForRun: () => "", log: () => {} });
    const service = new BackgroundShellService({ operationGate: gate, store: {
      getSession: (id: string) => store.sessions.get(id), getSessionTask: store.getSessionTask.bind(store),
      reserveSessionTask: store.reserveSessionTask.bind(store), updateSessionTask: store.updateSessionTask.bind(store),
      transitionPendingSessionTask: store.transitionPendingSessionTask.bind(store),
    } as any, executionProjector: projector, events: { checkpoint: () => 0, publishSince: () => {} },
      getDetachedProcessSupervisor: () => manager, acquireEnvironment: () => acquired });
    try {
      store.sessions.create({ id: "wsl-session", cwd: hostRoot, model: "test" });
      const input = { requestId: "same-cwd-start", sessionId: "wsl-session", command: "pwd", executionCwd,
        settings: { model: "test", sandbox: { enabled: false }, permission: { mode: "full_auto" } } as any };
      const first = service.create(input);
      const retry = service.create(input);
      await Promise.resolve(); await Promise.resolve();
      expect(manager.listExecutions()).toMatchObject([{ status: "pending" }]);
      expect(gate.tryEnterBarrier({ kind: "global" }, () => true)).toBeUndefined();
      releaseAcquire({ workspace: binding, paths: createWslPathResolver(binding), release: async () => { releases++; },
        process: { async execShell(command: string, options: { cwd: string }) {
          launches++;
          if (command !== "pwd") throw new Error("Unexpected process command");
          return { write() {}, end() {}, onOutput(listener: (chunk: Uint8Array) => void) { listener(Buffer.from(options.cwd)); return () => {}; },
            wait: () => waited, async signal() { finishProcess({ exitCode: 0 }); } };
        }, async execProcess() { throw new Error("Unexpected argv process"); } },
      });
      const [a, b] = await Promise.all([first, retry]);
      expect(a.execution.id).toBe(b.execution.id);
      expect(launches).toBe(1);
      expect(a.execution.cwd).toBe(hostRoot);
      await vi.waitFor(() => expect(manager.readOutput(a.execution.id)).toBe(executionCwd));
      await expect(service.create({ ...input, executionCwd: `${binding.executionRoot}/other` })).rejects.toMatchObject({ status: 409 });
      const barrier = gate.tryEnterBarrier({ kind: "global" }, () => true);
      expect(barrier).toBeDefined(); barrier?.release();
      finishProcess({ exitCode: 0 });
      await vi.waitFor(() => expect(releases).toBe(1));
      expect(store.getSessionTask(a.execution.id)?.status).toBe("completed");
    } finally { releaseAcquire({ release: async () => {}, paths: { resolve: async () => ({ mountPurpose: "workspace", executionPath: hostRoot }) }, workspace: { executionRoot: hostRoot } }); finishProcess({ exitCode: 0 }); await manager.aclose(); store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("reuses one real process and its durable record for concurrent equal requests", async () => {
    const f = fixture();
    try {
      const input = { requestId: "same", sessionId: "session", command: `${JSON.stringify(process.execPath)} -e "process.stdout.write('shell-adapter-ok')"`, settings };
      const [first, second] = await Promise.all([f.service.create(input), f.service.create(input)]);
      expect(first.execution.id).toBe(second.execution.id);
      await f.manager.awaitExecution(first.execution.id);
      expect(f.store.listSessionTasks("session")).toHaveLength(1);
      expect(f.store.getSessionTask(first.execution.id)).toMatchObject({ status: "completed", output: "shell-adapter-ok" });
      await expect(f.service.create({ ...input, command: "changed" })).rejects.toThrow(/identity conflict/);
    } finally { await f.close(); }
  });
  it("does not launch after cancellation while the environment is being acquired", async () => {
    const entered = gate(), released = gate();
    const launch = vi.fn(async () => { throw new Error("must not spawn"); });
    const release = vi.fn(async () => {});
    const f = fixture(async () => {
      entered.resolve(); await released.promise;
      return { workspace: { executionRoot: f.cwd }, paths: { resolve: async (executionPath: string) => ({ executionPath, mountPurpose: "workspace" }) }, process: { execShell: launch, execProcess: launch }, release };
    });
    try {
      const starting = f.service.create({ requestId: "cancel", sessionId: "session", command: "unused", settings });
      const outcome = Promise.allSettled([starting]);
      await entered.promise;
      const id = f.store.listSessionTasks("session")[0]!.id;
      const stopped = f.service.stop(id, { sessionId: "session" });
      expect(f.store.getSessionTask(id)?.status).toBe("pending");
      released.resolve();
      await Promise.all([outcome, stopped]);
      expect(launch).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledOnce();
      expect(f.store.getSessionTask(id)?.status).toBe("stopped");
    } finally { released.resolve(); await f.close(); }
  });
  it("releases an acquired environment when its execution directory is outside the workspace", async () => {
    const release = vi.fn(async () => {});
    const f = fixture(async () => ({ workspace: { executionRoot: "/workspace" }, paths: { resolve: async () => ({ executionPath: "/outside", mountPurpose: "external" }) }, release }));
    try {
      await expect(f.service.create({ requestId: "outside", sessionId: "session", command: "unused", executionCwd: "/outside", settings })).rejects.toThrow(/outside the workspace/);
      expect(release).toHaveBeenCalledOnce();
      expect(f.store.listSessionTasks("session")[0]?.status).toBe("failed");
    } finally { await f.close(); }
  });
  it("rejects archived sessions and cwd changes before process admission", async () => {
    const f = fixture();
    try {
      await expect(f.service.create({ requestId: "cwd", sessionId: "session", cwd: join(f.cwd, "other"), command: "unused" })).rejects.toThrow(/cwd mismatch/);
      f.store.sessions.archive("session");
      await expect(f.service.create({ requestId: "archived", sessionId: "session", command: "unused" })).rejects.toThrow(/not accepting/);
      expect(f.manager.listExecutions()).toEqual([]);
    } finally { await f.close(); }
  });
});


it("keeps settings in the immutable request identity and prevents dispatch before durable reservation", async () => {
  const f = fixture();
  try {
    const input = { requestId: "settings", sessionId: "session", command: `${JSON.stringify(process.execPath)} -e "process.stdout.write('settings')"`, settings };
    const execution = await f.service.create(input);
    await f.manager.awaitExecution(execution.execution.id);
    await expect(f.service.create({ ...input, settings: { ...settings, maxTurns: 2 } })).rejects.toMatchObject({ status: 409 });

    // Supply the fault through the actual adapter port; the executor must not reach environment acquisition.
    const ports = f.service.admissionForSession(f.store.sessions.get("session")!);
    ports.reserve = async () => { throw new Error("reservation unavailable"); };
    const acquire = vi.spyOn(ports, "acquireEnvironment");
    await expect(f.manager.startShellExecution({ id: "reservation-fault", requestId: "fault", sessionId: "session", cwd: f.cwd, description: "fault", command: "unused" }, ports)).rejects.toThrow("reservation unavailable");
    expect(acquire).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

it("preserves the durable result when a cold supervisor rejects a conflicting request", async () => {
  const f = fixture();
  const cold = new DetachedProcessSupervisor(join(f.cwd, "cold-output"));
  try {
    const input = { requestId: "cold-conflict", sessionId: "session", command: `${JSON.stringify(process.execPath)} -e "process.stdout.write('durable-result')"`, settings };
    const started = await f.service.create(input);
    await f.manager.awaitExecution(started.execution.id);
    const before = f.store.getSessionTask(started.execution.id)!;
    expect(before.status).toBe("completed");
    const ports = f.service.admissionForSession(f.store.sessions.get("session")!);
    await expect(cold.startShellExecution({ id: started.execution.id, requestId: input.requestId, requestNamespace: "http", sessionId: "session", cwd: f.cwd, description: "conflict", command: "different", settings }, ports)).rejects.toMatchObject({ status: 409 });
    expect(f.store.getSessionTask(started.execution.id)).toEqual(before);
    expect(cold.getExecution(started.execution.id)).toBeUndefined();
    const loadFailure = { ...ports, load: async () => { throw new Error("read unavailable"); } };
    await expect(cold.startShellExecution({ id: started.execution.id, requestId: input.requestId, requestNamespace: "http", sessionId: "session", cwd: f.cwd, description: input.command, command: input.command, settings }, loadFailure)).rejects.toThrow("read unavailable");
    expect(f.store.getSessionTask(started.execution.id)).toEqual(before);
    expect(cold.getExecution(started.execution.id)).toBeUndefined();
  } finally { await cold.aclose(); await f.close(); }
});
