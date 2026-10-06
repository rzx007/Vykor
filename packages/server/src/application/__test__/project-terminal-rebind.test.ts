import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "@vykor/services";
import { expect, it, vi } from "vitest";
import { DaemonApplication } from "../daemon-application.js";
import { createTerminalRoutes, TerminalHttpEventHub } from "../../http/routes/terminal.js";

async function fixture(withSession = true) {
  const directory = mkdtempSync(join(tmpdir(), "project-terminal-rebind-"));
  const store = new SessionStore({ path: join(directory, "store.db") });
  const project = store.projects.inspect(directory);
  if (withSession) store.sessions.create({ id: "s1", cwd: directory, projectId: project.id, model: "test" });
  const application = new DaemonApplication({ store, settings: { model: "test", sandbox: { enabled: false }, memory: { enabled: false } } as any, log: () => {} });
  await (application as any).startupRecovery;
  const spawnPty = vi.fn(() => {
    let exit: ((event: { exitCode: number }) => void) | undefined;
    return { write() {}, resize() {}, kill() { exit?.({ exitCode: 0 }); },
      onData() { return { dispose() {} }; },
      onExit(listener: typeof exit) { exit = listener; return { dispose() {} }; } };
  });
  (application.terminals as any).provider.options.spawnPty = spawnPty;
  return { directory, store, project, application, spawnPty,
    async dispose() { await application.close(); store.close(); rmSync(directory, { recursive: true, force: true }); vi.restoreAllMocks(); } };
}

it("blocks terminal create and returns HTTP 409 while rebind awaits close", async () => {
  const f = await fixture();
  let finishClose!: () => void;
  const closing = new Promise<void>(resolve => { finishClose = resolve; });
  let rebinding: Promise<unknown> | undefined;
  const events = new TerminalHttpEventHub(f.application.terminals);
  try {
    const close = vi.spyOn((f.application as any).agentPool, "close").mockImplementation(() => closing);
    rebinding = f.application.projects.rebind(f.project.id, tmpdir());
    await vi.waitFor(() => expect(close).toHaveBeenCalledWith("s1"));
    const input = { scope: { kind: "session" as const, sessionId: "s1" }, runtime: "local" as const, cols: 80, rows: 24 };
    const result = await f.application.terminals.create(input).catch(error => error);
    const response = await createTerminalRoutes(f.application.terminals, events).request("/", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
    });
    expect(result).toMatchObject({ status: 409 });
    expect(response.status).toBe(409);
    expect(f.spawnPty).not.toHaveBeenCalled();
    finishClose(); await rebinding;
    const terminal = await f.application.terminals.create({ ...input, cwd: tmpdir() });
    expect(terminal).toMatchObject({ cwd: tmpdir(), sessionId: "s1", status: "running" });
    await f.application.terminals.close(terminal.id);
  } finally { finishClose(); await rebinding?.catch(() => {}); events.closeClients(); await f.dispose(); }
});

it.each(["session", "project"] as const)("blocks rebind for an active %s terminal and allows it after close", async (kind) => {
  const f = await fixture(kind === "session");
  try {
    const terminal = await f.application.terminals.create({
      scope: kind === "session" ? { kind, sessionId: "s1" } : { kind, projectId: f.project.id },
      runtime: "local", cols: 80, rows: 24, cwd: f.directory,
    });
    await expect(f.application.projects.rebind(f.project.id, tmpdir())).rejects.toMatchObject({ status: 409 });
    expect(f.store.projects.get(f.project.id)?.path).toBe(f.directory);
    await f.application.terminals.close(terminal.id);
    await expect(f.application.projects.rebind(f.project.id, tmpdir())).resolves.toMatchObject({ path: tmpdir() });
  } finally { await f.dispose(); }
});

it("blocks rebind throughout environment acquisition and releases failed admission", async () => {
  const f = await fixture();
  let rejectAcquire!: (error: Error) => void;
  const acquiring = new Promise<never>((_resolve, reject) => { rejectAcquire = reject; });
  const acquire = vi.fn(() => acquiring);
  (f.application.terminals as any).options.acquireEnvironment = acquire;
  let creating: Promise<unknown> | undefined;
  try {
    creating = f.application.terminals.create({ scope: { kind: "session", sessionId: "s1" }, runtime: "environment", cols: 80, rows: 24 }).catch(error => error);
    await vi.waitFor(() => expect(acquire).toHaveBeenCalledOnce());
    await expect(f.application.projects.rebind(f.project.id, tmpdir())).rejects.toMatchObject({ status: 409 });
    rejectAcquire(new Error("controlled acquisition failure"));
    expect(await creating).toMatchObject({ message: "controlled acquisition failure" });
    expect(f.spawnPty).not.toHaveBeenCalled();
    await expect(f.application.projects.rebind(f.project.id, tmpdir())).resolves.toMatchObject({ path: tmpdir() });
  } finally { rejectAcquire(new Error("cleanup")); await creating; await f.dispose(); }
});

it("does not block rebind for a terminal belonging to another project", async () => {
  const f = await fixture(false);
  try {
    const independentProject = f.store.projects.inspect(process.cwd());
    f.store.sessions.create({ id: "independent", cwd: process.cwd(), projectId: independentProject.id, model: "test" });
    const terminal = await f.application.terminals.create({ scope: { kind: "session", sessionId: "independent" }, runtime: "local", cols: 80, rows: 24 });
    expect(terminal.projectId).toBe(independentProject.id);
    await expect(f.application.projects.rebind(f.project.id, tmpdir())).resolves.toMatchObject({ path: tmpdir() });
    await expect(f.application.terminals.get(terminal.id)).resolves.toMatchObject({ status: "running", cwd: process.cwd() });
    await f.application.terminals.close(terminal.id);
  } finally { await f.dispose(); }
});
