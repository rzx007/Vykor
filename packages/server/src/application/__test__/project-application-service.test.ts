import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ProjectRecord } from "@vykor/protocol";
import { SessionStore } from "@vykor/services";
import { getDetachedProcessSupervisor } from "@vykor/services/executions";
import { describe, expect, it, vi } from "vitest";

import {
  ProjectApplicationService,
  type ProjectOperations,
} from "../project-application-service.js";
import { DaemonApplication } from "../daemon-application.js";
import { createJobRoutes } from "../../http/routes/job.js";
import { createBackgroundShellRoutes } from "../../http/routes/background-shell.js";

const project: ProjectRecord = {
  id: "p1",
  name: "Project",
  path: "C:/project",
  lastOpenedAt: 1,
  createdAt: 1,
  updatedAt: 1,
};

function createOperations(): ProjectOperations & Record<string, ReturnType<typeof vi.fn>> {
  return {
    list: vi.fn(() => [project]),
    inspect: vi.fn(() => project),
    rename: vi.fn(() => project),
    setPinned: vi.fn(() => project),
    setDefaultShell: vi.fn(() => project),
    rebind: vi.fn(() => project),
    archive: vi.fn(() => project),
  };
}

describe("ProjectApplicationService", () => {
  it.each(["shell", "agent"])("blocks %s admission while rebind awaits warm Agent close", async (kind) => {
    const directory = mkdtempSync(join(tmpdir(), "vk-project-gate-forward-"));
    const store = new SessionStore({ path: join(directory, "store.db") });
    const project = store.projects.inspect(directory);
    store.sessions.create({ id: "s1", cwd: directory, projectId: project.id, model: "test" });
    const application = new DaemonApplication({ store, settings: { model: "test", sandbox: { enabled: false }, memory: { enabled: false } } as any, log: () => {} });
    const manager = getDetachedProcessSupervisor({ cwd: directory, sessionId: "s1" });
    let finishClose!: () => void;
    const closing = new Promise<void>(resolve => { finishClose = resolve; });
    let rebinding: Promise<any> | undefined;
    try {
      await (application as any).startupRecovery;
      if (kind === "agent") {
        await manager.startShellExecution({ id: "agent", type: "agent", cwd: directory, description: "agent", argv: [process.execPath, "-e", "process.stdin.once('data', d => {process.stdout.write(d);process.exit(0)})"] });
        await manager.writeInput("agent", "first");
        await manager.awaitExecution("agent", { timeoutMs: 10000 });
        store.createSessionTask({ id: "agent", sessionId: "s1", cwd: directory, type: "agent", description: "agent", metadata: { executionBackend: "detached_process" } });
        store.updateSessionTask("agent", { status: "completed", output: "first" });
      }
      const close = vi.spyOn((application as any).agentPool, "close").mockImplementation(() => closing);
      rebinding = application.projects.rebind(project.id, tmpdir());
      await vi.waitFor(() => expect(close).toHaveBeenCalledWith("s1"));
      const admitted = kind === "shell"
        ? application.backgroundShells.create({ requestId: "during-rebind", sessionId: "s1", command: "echo blocked" })
        : application.jobs.send({ sessionId: "s1", jobId: "agent", data: "continue" });
      await expect(admitted).rejects.toMatchObject({ status: 409 });
      const http = kind === "shell"
        ? createBackgroundShellRoutes({ backgroundShells: application.backgroundShells, jobs: application.jobs })
        : createJobRoutes(application.jobs);
      const response = await http.request(kind === "shell" ? "/" : "/agent/input", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(kind === "shell" ? { sessionId: "s1", command: "echo blocked" } : { sessionId: "s1", data: "continue" }),
      });
      expect(response.status).toBe(409);
      expect(store.sessions.get("s1")?.cwd).toBe(directory);
      if (kind === "shell") expect(store.listSessionTasks("s1")).toEqual([]);
      else expect(store.getSessionTask("agent")?.status).toBe("completed");
      finishClose();
      await rebinding;
      expect(store.sessions.get("s1")?.cwd).toBe(tmpdir());
      close.mockRestore();
    } finally {
      finishClose(); await rebinding?.catch(() => {}); await manager.aclose(); await application.close(); store.close(); rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(["shell", "agent"])("rejects rebind throughout in-flight %s admission and releases on failure", async (kind) => {
    const directory = mkdtempSync(join(tmpdir(), "vk-project-gate-reverse-"));
    const store = new SessionStore({ path: join(directory, "store.db") });
    const project = store.projects.inspect(directory);
    store.sessions.create({ id: "s1", cwd: directory, projectId: project.id, model: "test" });
    const application = new DaemonApplication({ store, settings: { model: "test", sandbox: { enabled: false }, memory: { enabled: false } } as any, log: () => {} });
    let rejectAdmission!: (error: Error) => void;
    const pending = new Promise<never>((_resolve, reject) => { rejectAdmission = reject; });
    let admitted: Promise<any> | undefined;
    try {
      await (application as any).startupRecovery;
      if (kind === "shell") {
        (application.backgroundShells as any).context.acquireEnvironment = () => pending;
        admitted = application.backgroundShells.create({ requestId: "acquiring", sessionId: "s1", command: "echo blocked" }).catch(error => error);
        await vi.waitFor(() => expect(store.listSessionTasks("s1")).toHaveLength(1));
        store.transitionPendingSessionTask(store.listSessionTasks("s1")[0]!.id, { status: "stopped" });
      } else {
        store.createSessionTask({ id: "agent", sessionId: "s1", cwd: directory, type: "agent", description: "agent", metadata: { executionBackend: "detached_process" } });
        store.updateSessionTask("agent", { status: "completed" });
        vi.spyOn(application.terminals, "list").mockImplementation(() => pending);
        admitted = application.jobs.send({ sessionId: "s1", jobId: "agent", data: "continue" }).catch(error => error);
      }
      await expect(application.projects.rebind(project.id, tmpdir())).rejects.toMatchObject({ status: 409 });
      expect(store.sessions.get("s1")?.cwd).toBe(directory);
      rejectAdmission(new Error("controlled admission failure"));
      await admitted;
      await expect(application.projects.rebind(project.id, tmpdir())).resolves.toMatchObject({ path: tmpdir() });
    } finally {
      rejectAdmission(new Error("cleanup")); await admitted; await application.close(); store.close(); rmSync(directory, { recursive: true, force: true }); vi.restoreAllMocks();
    }
  });
  it("rejects running rebinds and waits for affected warm Agents before publishing cwd changes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vk-project-runtime-rebind-"));
    const store = new SessionStore({ path: join(directory, "store.db") });
    const project = store.projects.inspect(directory);
    const old = join(directory, "sub");
    store.sessions.create({ id: "s1", projectId: project.id, cwd: old, model: "test" });
    const application = new DaemonApplication({ store, settings: { model: "test", sandbox: { enabled: false }, memory: { enabled: false } } as any, log: () => {} });
    try {
      await (application as any).startupRecovery;
      store.runs.createRun({ id: "active", sessionId: "s1" });
      await expect(application.projects.rebind(project.id, directory)).rejects.toThrow(/running|active/i);
      store.runs.updateRun("active", { status: "completed" });
      let finishClose!: () => void;
      const closing = new Promise<void>(resolve => { finishClose = resolve; });
      const close = vi.spyOn((application as any).agentPool, "close").mockImplementation(async () => { expect(store.sessions.get("s1")?.cwd).toBe(old); await closing; });
      const events: any[] = [];
      const publish = vi.spyOn((application as any).eventPublisher, "publishSince").mockImplementation((seq: any) => { events.push(...store.conversations.listEvents({ afterSeq: seq })); });
      const rebinding = application.projects.rebind(project.id, tmpdir());
      await vi.waitFor(() => expect(close).toHaveBeenCalledWith("s1"));
      expect(store.sessions.get("s1")?.cwd).toBe(old);
      finishClose();
      await rebinding;
      expect(store.sessions.get("s1")?.cwd).toBe(join(tmpdir(), "sub"));
      expect(events).toContainEqual(expect.objectContaining({ type: "session.updated", sessionId: "s1" }));
      publish.mockRestore(); close.mockRestore();
    } finally { await application.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  it("delegates every project operation through the narrow capability", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vk-project-service-"));
    const operations = createOperations();
    const service = new ProjectApplicationService(operations);
    try {
      expect(service.list({ includeArchived: true })).toEqual([project]);
      await expect(service.inspect(directory)).resolves.toEqual(project);
      expect(service.rename("p1", "Renamed")).toEqual(project);
      expect(service.setPinned("p1", true)).toEqual(project);
      expect(service.setDefaultShell("p1", null)).toEqual(project);
      await expect(service.rebind("p1", directory)).resolves.toEqual(project);
      expect(service.archive("p1")).toEqual(project);

      expect(operations.list).toHaveBeenCalledWith({ includeArchived: true });
      expect(operations.inspect).toHaveBeenCalledWith(directory);
      expect(operations.rename).toHaveBeenCalledWith("p1", "Renamed");
      expect(operations.setPinned).toHaveBeenCalledWith("p1", true);
      expect(operations.setDefaultShell).toHaveBeenCalledWith("p1", null);
      expect(operations.rebind).toHaveBeenCalledWith("p1", directory);
      expect(operations.archive).toHaveBeenCalledWith("p1");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("is composed with store.projects instead of the legacy Store methods", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vk-project-composition-"));
    const store = new SessionStore({ path: join(directory, "sessions.db") });
    const project = store.projects.inspect(directory);
    const application = new DaemonApplication({
      store,
      settings: {
        apiFormat: "anthropic",
        model: "test-model",
        maxTurns: 1,
        permission: { mode: "full_auto" },
        sandbox: { enabled: false },
        memory: { enabled: false },
      },
      log: () => undefined,
    });
    try {
      expect(application.projects.rename(project.id, "Renamed").name).toBe(
        "Renamed",
      );
    } finally {
      await application.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects files before calling inspect or rebind", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vk-project-service-file-"));
    const file = join(directory, "not-a-directory.txt");
    writeFileSync(file, "file");
    const operations = createOperations();
    const service = new ProjectApplicationService(operations);
    try {
      await expect(service.inspect(file)).rejects.toThrow("path is not a directory");
      await expect(service.rebind("p1", file)).rejects.toThrow(
        "path is not a directory",
      );
      expect(operations.inspect).not.toHaveBeenCalled();
      expect(operations.rebind).not.toHaveBeenCalled();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
