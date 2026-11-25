import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { StreamingMessageClient } from "@vykor/agent-contracts";
import { createDefaultNodeAgent } from "@vykor/agent-runtime";
import { SessionStore } from "@vykor/services";
import { DaemonApplication } from "../../../daemon-application.js";

it("uses the admitted reply format for one run and saves its answer as ordinary text", async () => {
  const directory = mkdtempSync(join(tmpdir(), "vykor-interactive-ui-run-"));
  const store = new SessionStore({ path: join(directory, "sessions.db") });
  const table = 'Two results.\n\n```vykor-ui-v1\nroot = FilterableTable("Results", ["Name"], [["Alpha"], ["Beta"]])\n```';
  const client: StreamingMessageClient = { async *streamMessage({ system }) {
    yield { type: "text_delta", delta: system?.includes("root = FilterableTable(") ? table : "Ordinary reply" };
    yield { type: "complete", stopReason: "end_turn" };
  } };
  const app = new DaemonApplication({
    store, log: () => {},
    settings: { model: "offline", apiFormat: "openai", permission: { mode: "default" },
      sandbox: { enabled: false }, plugins: { enabled: false }, memory: { enabled: false, sessionMemoryEnabled: false } },
    createAgent: async ({ options }) => {
      const agent = await createDefaultNodeAgent({ ...options, client,
        capabilityOverrides: { ...options.capabilityOverrides, terminal: false, backgroundShell: false, memory: false },
      });
      return { agent, host: agent.host };
    },
  });
  try {
    await app.ready();
    const session = app.commands.createSession({ cwd: directory, model: "offline" });
    const first = await app.interactions.admitPrompt(session.id, {
      items: [{ type: "text", text: "Make an interactive table" }],
      metadata: { replyPresentation: "vykor-ui-v1" },
    });
    const next = await app.interactions.admitPrompt(session.id, {
      items: [{ type: "text", text: "Answer normally" }],
    });
    const result = await app.runControl.awaitRun(session.id, first.run!.id);
    const ordinary = await app.runControl.awaitRun(session.id, next.run!.id);
    expect(result).toMatchObject({ status: "completed", output: table });
    expect(ordinary).toMatchObject({ status: "completed", output: "Ordinary reply" });
    expect(store.conversations.getInput(first.input.id)?.metadata.replyPresentation).toBe("vykor-ui-v1");
    expect(store.conversations.listMessageParts(session.id)).toContainEqual(expect.objectContaining({ type: "text", text: table }));
  } finally {
    await app.close();
    store.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
