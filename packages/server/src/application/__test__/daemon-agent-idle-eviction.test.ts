import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SessionStore } from "@vykor/services";
import { DaemonApplication } from "../daemon-application.js";
import { hostedAgentFixture } from "../../../test-helpers/hosted-agent.js";

describe("daemon idle root eviction", () => {
  it.each(["approval", "question", "queued run", "background task"])("keeps durable %s work and rebuilds only after it settles", async kind => {
    vi.useFakeTimers();
    const directory = mkdtempSync(join(tmpdir(), "vykor-idle-root-"));
    const store = new SessionStore({ path: join(directory, "store.db") });
    let closed = 0;
    const loadedHistory: unknown[][] = [];
    let application: DaemonApplication | undefined;
    try {
      application = new DaemonApplication({ store, settings: { model: "test", plugins: { enabled: false }, memory: { enabled: false } }, log: () => {},
        createAgent: async ({ session }) => hostedAgentFixture({
          id: session.id, state: "idle", children: { list: () => [] }, canSuspend: () => true,
          loadHistory: (history: unknown[]) => { loadedHistory.push(history); },
          setCompactContextProvider() {}, inspect: () => ({ hooks: [] }),
          close: async () => { closed++; },
        }),
      });
      await application.ready();
      const session = application.commands.createSession({ cwd: directory, model: "test" });
      await application.control.inspectRuntimeHooks(session.id);
      expect(application.control.runtimeSnapshot().warmAgentCount).toBe(1);
      let settle: () => void;
      if (kind === "queued run") {
        const admitted = store.conversationTransactions.admitPromptWithRun({ prompt: { sessionId: session.id, items: [{ type: "text", text: "queued" }] }, run: {} });
        settle = () => { store.runs.updateRun(admitted.run!.id, { status: "completed" }); };
      } else if (kind === "background task") {
        const task = store.runs.createSessionTask({ sessionId: session.id, type: "shell", description: "long shell", cwd: directory, status: "running" });
        settle = () => { store.runs.updateSessionTask(task.id, { status: "completed" }); };
      } else {
        const permission = store.permissions.create({ sessionId: session.id, toolName: kind === "question" ? "AskUserQuestion" : "Write", payload: { kind } });
        settle = () => { store.permissions.reply({ requestId: permission.id, status: "approved" }); };
      }
      await vi.advanceTimersByTimeAsync(31 * 60_000);
      expect(application.control.runtimeSnapshot().warmAgentCount).toBe(1);
      expect(closed).toBe(0);
      settle();
      const message = store.conversations.createMessage({ sessionId: session.id, role: "user" });
      store.conversations.upsertMessagePart({ sessionId: session.id, messageId: message.id, type: "text", text: "durable continuation" });
      await vi.advanceTimersByTimeAsync(31 * 60_000);
      expect(application.control.runtimeSnapshot().warmAgentCount).toBe(0);
      expect(closed).toBe(1);
      expect(store.sessions.get(session.id)?.status).toBe("idle");
      await application.control.inspectRuntimeHooks(session.id);
      expect(JSON.stringify(loadedHistory[1])).toContain("durable continuation");
      await application.close();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await application?.close().catch(() => {});
      store.close();
      vi.useRealTimers();
      const withinTemp = relative(tmpdir(), directory);
      if (!withinTemp || withinTemp.startsWith("..") || isAbsolute(withinTemp)) throw new Error("Fixture escaped temporary directory");
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
