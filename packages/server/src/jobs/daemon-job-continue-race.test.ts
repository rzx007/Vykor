import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "@vykor/services";
import { ChildAgentExecutionRegistry } from "@vykor/services/executions";
import { expect, it } from "vitest";
import { DaemonJobService } from "./daemon-job-service.js";
import { SessionExecutionProjector } from "../application/session/session-execution-projector.js";

it.each(["cancel", "complete", "progress", "unchanged"] as const)(
  "keeps the current child result when rejected continue follows %s",
  async (interleaving) => {
    const directory = mkdtempSync(join(tmpdir(), "job-continue-race-"));
    const store = new SessionStore({ path: join(directory, "store.db") });
    const registry = new ChildAgentExecutionRegistry(join(directory, "output"));
    let rejectInput!: (error: Error) => void;
    let inputStarted!: () => void;
    const started = new Promise<void>(resolve => { inputStarted = resolve; });
    const pending = new Promise<void>((_resolve, reject) => { rejectInput = reject; });
    const projector = new SessionExecutionProjector({
      store, getChildAgentExecutionRegistry: () => registry,
      events: { checkpoint: () => 0, publishSince: () => {} },
      traceIdForRun: () => "", log: () => {},
    });
    const bridge = projector.createBridge({ id: "parent", cwd: directory });
    let sending: Promise<unknown> | undefined;
    try {
      store.sessions.create({ id: "parent", cwd: directory, model: "test" });
      store.sessions.create({ id: "child-session", parentId: "parent", cwd: directory, model: "test" });
      bridge.registerChildExecution({
        id: "child", sessionId: "parent", childSessionId: "child-session", cwd: directory,
        description: "child", prompt: "first", onStop: async () => {},
        onInput: async () => { inputStarted(); await pending; },
      });
      await bridge.completeChildExecution("child", { status: "failed", output: "original error" });
      const service = new DaemonJobService({
        getSession: id => store.sessions.get(id),
        listSessionTasks: store.listSessionTasks.bind(store),
        getSessionTask: store.getSessionTask.bind(store),
        updateSessionTask: store.updateSessionTask.bind(store),
        transitionPendingSessionTask: store.transitionPendingSessionTask.bind(store),
        waitForSessionTaskChange: store.waitForSessionTaskChange.bind(store),
      }, { list: async () => [] } as any, () => registry, () => registry, {} as any);
      sending = service.send({ sessionId: "parent", jobId: "child", data: "continue" }).catch(error => error);
      await started;
      const reopened = store.getSessionTask("child")!;
      const changed = store.waitForSessionTaskChange("child", reopened.updatedAt, { timeoutMs: 1000 });
      if (interleaving === "cancel") await service.cancel({ sessionId: "parent", jobId: "child" });
      if (interleaving === "complete") await bridge.completeChildExecution("child", { status: "completed", output: "new result" });
      if (interleaving === "progress") store.updateSessionTask("child", { status: "running", output: "new progress" });
      const current = store.getSessionTask("child")!;
      rejectInput(new Error("controlled input rejection"));
      expect(await sending).toMatchObject({ message: "controlled input rejection" });
      if (interleaving === "unchanged") {
        expect(store.getSessionTask("child")).toMatchObject({ status: "failed", output: "original error", error: "original error" });
        expect(await changed).toMatchObject({ status: "failed" });
      } else {
        expect(store.getSessionTask("child")).toEqual(current);
        expect(await changed).toMatchObject({ updatedAt: current.updatedAt });
        if (interleaving === "cancel") expect(registry.getExecution("child")?.status).toBe("stopped");
      }
    } finally {
      if (sending) { rejectInput(new Error("cleanup")); await sending; }
      registry.close(); store.close(); rmSync(directory, { recursive: true, force: true });
    }
  },
);
