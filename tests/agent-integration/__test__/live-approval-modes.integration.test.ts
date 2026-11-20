import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createDefaultNodeAgent } from "@vykor/agent-runtime";
import { SessionStore } from "@vykor/services";
import { DaemonApplication } from "../../../packages/server/src/application/daemon-application.js";

const reviewer = vi.hoisted(() => ({ entered: undefined as (() => void) | undefined, held: undefined as Promise<void> | undefined, calls: 0 }));
vi.mock("@vykor/agent-runtime", async importOriginal => ({
  ...await importOriginal<typeof import("@vykor/agent-runtime")>(),
  createConfiguredApprovalReviewer: async () => ({ review: async () => {
    reviewer.calls++;
    reviewer.entered?.();
    await reviewer.held;
    return { decision: "approve", risk: "low", authorization: "task_implied", reason: "Fixture operation requested by user" };
  } }),
}));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

it("hot-switches one active daemon Run while preserving pending human and automatic approvals", async () => {
  const directory = mkdtempSync(join(tmpdir(), "vk-live-approval-"));
  const output = join(directory, "operations.txt");
  const store = new SessionStore({ path: join(directory, "state.db") });
  const modelEntered = [deferred(), deferred(), deferred(), deferred()];
  const modelReleased = [deferred(), deferred(), deferred(), deferred()];
  const reviewEntered = deferred(), reviewReleased = deferred();
  reviewer.entered = reviewEntered.resolve; reviewer.held = reviewReleased.promise; reviewer.calls = 0;
  let calls = 0, agents = 0;
  const app = new DaemonApplication({
    store, log: () => {},
    settings: { model: "offline", apiFormat: "openai", maxTurns: 6, permission: { mode: "ask" },
      sandbox: { enabled: false }, memory: { enabled: false }, plugins: { enabled: false } },
    createAgent: async ({ options }) => {
      agents++;
      const agent = await createDefaultNodeAgent({ ...options,
        tools: [...(options.tools ?? []), { name: "Step", description: "Perform requested fixture operation", inputSchema: { type: "object" },
          execute: async input => {
            appendFileSync(output, `${input.step}\n`);
            return { content: [{ type: "text", text: `completed ${input.step}` }] };
          } }],
        client: { async *streamMessage() {
          const step = ++calls;
          if (step <= 4) {
            modelEntered[step - 1]!.resolve();
            if (step > 1) await modelReleased[step - 1]!.promise;
            yield { type: "tool_use_start", toolUse: { type: "tool_use", id: `step-${step}`, name: "Step", input: { step } } };
            yield { type: "complete", stopReason: "tool_use" };
          } else yield { type: "complete", stopReason: "end_turn" };
        } },
      });
      return { agent, host: agent.host };
    },
  });
  try {
    await app.ready();
    const session = app.commands.createSession({ cwd: directory, model: "offline" });
    const admitted = await app.interactions.admitPrompt(session.id, { items: [{ type: "text", text: "Complete the four fixture operations." }] });
    const pending = () => store.permissions.list({ sessionId: session.id, status: "pending" });
    await vi.waitFor(() => expect(pending(), JSON.stringify({ calls, agents, run: store.runs.getRun(admitted.run!.id) })).toHaveLength(1), { timeout: 10_000 });
    const original = pending()[0]!;
    const revision = store.sessions.get(session.id)!.metadata.runtimeRevision ?? 0;
    await app.commands.updateSession(session.id, { metadata: { runtime: { approvalMode: "full_access" } } });
    expect(store.sessions.get(session.id)!.metadata.runtimeRevision).toBe(revision);
    expect(store.permissions.get(original.id)?.status).toBe("pending");
    app.permissions.reply({ requestId: original.id, status: "approved", decision: "once" });

    await modelEntered[1]!.promise;
    modelReleased[1]!.resolve();
    await modelEntered[2]!.promise;
    expect(readFileSync(output, "utf8")).toBe("1\n2\n");
    expect(store.permissions.list({ sessionId: session.id })).toHaveLength(1);

    await app.commands.updateSession(session.id, { metadata: { runtime: { approvalMode: "auto_review" } } });
    modelReleased[2]!.resolve();
    await reviewEntered.promise;
    const automatic = pending()[0]!;
    expect(automatic.payload.approvalMode).toBe("auto_review");
    await app.commands.updateSession(session.id, { metadata: { runtime: { approvalMode: "ask" } } });
    reviewReleased.resolve();
    await modelEntered[3]!.promise;
    expect(store.permissions.get(automatic.id)?.status).toBe("approved");
    expect(readFileSync(output, "utf8")).toBe("1\n2\n3\n");

    modelReleased[3]!.resolve();
    await vi.waitFor(() => expect(pending()).toHaveLength(1));
    expect(pending()[0]!.payload.approvalMode).toBe("ask");
    app.permissions.reply({ requestId: pending()[0]!.id, status: "approved", decision: "once" });
    expect(await app.runControl.awaitRun(session.id, admitted.run!.id)).toMatchObject({ status: "completed" });
    expect(readFileSync(output, "utf8")).toBe("1\n2\n3\n4\n");
    expect(reviewer.calls).toBe(1);
    expect(agents).toBe(1);
  } finally {
    for (const gate of modelReleased) gate.resolve();
    reviewReleased.resolve();
    await app.close(); store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
