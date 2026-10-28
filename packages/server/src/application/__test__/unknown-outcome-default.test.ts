import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDefaultNodeAgent } from "@vykor/agent-runtime";
import type { AgentEvent } from "@vykor/agent-contracts";
import { SessionStore } from "@vykor/services";
import { hostedAgentFactory } from "../../../test-helpers/hosted-agent.js";
import { DaemonApplication } from "../daemon-application.js";

describe("unknown tool outcomes in the default daemon", () => {
  it.each([
    { enabled: undefined, denyShell: false, executes: true },
    { enabled: false, denyShell: false, executes: true },
    { enabled: true, denyShell: false, executes: false },
    { enabled: false, denyShell: true, executes: false },
  ])("retains audit and ordinary permissions with the guard setting %j", async ({ enabled, denyShell, executes }) => {
    const directory = mkdtempSync(join(tmpdir(), "vykor-default-guard-"));
    const store = new SessionStore({ path: join(directory, "store.db") });
    const outputPath = join(directory, "build-finished.txt");
    const events: AgentEvent[] = [];
    let turn = 0;
    const application = new DaemonApplication({
      store,
      settings: { model: "offline", apiFormat: "openai", maxTurns: 4, sandbox: { enabled: false },
        permission: { mode: "full_access", ...(denyShell ? { deniedTools: ["Shell"] } : {}) },
        memory: { enabled: false }, plugins: { enabled: false },
        ...(enabled === undefined ? {} : { blockOnUnknownToolOutcome: enabled }),
      },
      browserHost: { execute: async () => { throw new Error("ERR_ABORTED (-3) loading http://localhost:5173/"); } },
      createAgent: hostedAgentFactory(async context => createDefaultNodeAgent({ ...context.options,
        onEvent: async event => { events.push(event); await context.options.onEvent?.(event); },
        client: { async *streamMessage() {
          turn++;
          if (turn <= 2) {
            yield { type: "tool_use_start", toolUse: turn === 1
              ? { type: "tool_use", id: "navigate", name: "Browser", input: { action: "navigate", url: "http://localhost:5173" } }
              : { type: "tool_use", id: "build", name: "Shell", input: { command: "node -e \"require('node:fs').writeFileSync('build-finished.txt','build finished')\"", timeout: 2000 } } };
            yield { type: "complete", stopReason: "tool_use" };
          } else {
            yield { type: "text_delta", delta: "verification finished" };
            yield { type: "complete", stopReason: "end_turn" };
          }
        } },
      })), log: () => {},
    });
    try {
      await application.ready();
      const session = application.commands.createSession({ cwd: directory, model: "offline" });
      const admitted = await application.interactions.admitPrompt(session.id, { items: [{ type: "text", text: "navigate, then build" }] });
      expect(await application.runControl.awaitRun(session.id, admitted.run!.id)).toMatchObject({ status: "completed" });
      expect(existsSync(outputPath)).toBe(executes);
      if (executes) expect(readFileSync(outputPath, "utf8")).toBe("build finished");
      const navigation = store.toolOperations.list({ sessionId: session.id }).find(operation => operation.toolName === "Browser");
      expect(navigation).toMatchObject({ state: "unknown" });
      expect(store.toolOperations.listAttempts(navigation!.operationId)).toHaveLength(1);
      const result = events.find(event => event.type === "tool.completed" && event.data.toolUseId === "build");
      expect(result).toBeDefined();
      if (result?.type === "tool.completed") expect(result.data.result.executionState).toBe(executes ? "completed" : "not_started");
    } finally {
      await application.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
