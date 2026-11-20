import { describe, expect, it } from "vitest";
import type { AgentChildInvocation, AgentEvent, StreamMessageParams, ToolDefinition } from "@vykor/agent-contracts";
import { readonlyMap } from "@vykor/agent-contracts";
import { createAgentKernel, createBasicAgentKernelRuntime } from "../index.js";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(options: { fail?: string; maxTurns?: number; lateStart?: boolean; structured?: boolean } = {}) {
  const releases = new Map(["first", "second"].map(label => [label, gate()]));
  const attemptedFinal = gate();
  const delegated = gate();
  const startChildren = gate();
  const events: AgentEvent[] = [];
  const requests: StreamMessageParams[] = [];
  const children: AgentChildInvocation[] = [];
  const dispatch: ToolDefinition = {
    name: "Dispatch", description: "delegate independent work", inputSchema: { type: "object" },
    async execute(input, context) {
      if (options.lateStart) await startChildren.promise;
      for (const label of options.lateStart ? ["first", "second"] : [String(input.label)]) {
        const child = await context.agent!.children.spawnChildAgent({
          prompt: label, description: label, agent: "worker", cwd: "/workspace",
        });
        children.push(child);
        if (children.length === 2) delegated.resolve();
      }
      return { content: [{ type: "text", text: JSON.stringify(children.map(child => ({ jobId: child.id, runId: child.runId }))) }] };
    },
  };
  const root = await createAgentKernel({
    id: "root", cwd: "/workspace", effects: { requestPermission: async () => ({ status: "approved" }) },
    ...(options.structured ? { outputContract: { schema: { type: "object" } } } : {}),
    onEvent: event => { events.push(event); },
    preparation: { prepare: async () => ({ run: { tools: readonlyMap([[dispatch.name, { definition: dispatch, invoke: dispatch.execute }]]) } }) },
    engine: createBasicAgentKernelRuntime({ model: "offline", tools: [dispatch], maxTurns: options.maxTurns,
      ...(options.lateStart ? { toolTimeoutMs: 10 } : {}), client: {
      async *streamMessage(request) {
        requests.push(request);
        if (requests.length === 1) {
          for (const label of options.lateStart ? ["both"] : ["first", "second"]) yield { type: "tool_use_start", toolUse: {
            type: "tool_use", id: label, name: "Dispatch", input: { label },
          } };
          yield { type: "complete", stopReason: "tool_use" };
        } else {
          if (options.lateStart) { startChildren.resolve(); await delegated.promise; }
          if (request.messages.some(message => message.type === "user" && message.content === "release delegates")) {
            for (const release of releases.values()) release.resolve();
          }
          const report = request.messages.filter(message => message.type === "user").map(message => message.content).join("\n");
          const ready = report.includes("findings:first") && (options.fail || report.includes("findings:second"));
          if (!ready) attemptedFinal.resolve();
          const summary = ready ? (options.fail ? "summary: first completed; second failed" : "summary: first + second") : "PREMATURE SUMMARY";
          if (options.structured) yield { type: "tool_use_start", toolUse: {
            type: "tool_use", id: `delivery-${requests.length}`, name: "SubmitResult", input: { status: "done", summary, data: {} },
          } };
          else yield { type: "text_delta", delta: summary };
          yield { type: "complete", stopReason: options.structured ? "tool_use" : "end_turn" };
        }
      },
    } }),
    resolveChild: ({ spawn, sessionId }) => ({ spawn, createAgent: async () => createAgentKernel({
      id: sessionId, cwd: "/workspace", effects: { requestPermission: async () => ({ status: "approved" }) },
      preparation: { prepare: async () => ({ run: { tools: readonlyMap([]) } }) },
      engine: createBasicAgentKernelRuntime({ model: "offline", client: { async *streamMessage(params) {
        const signal = params.abortSignal!;
        signal.throwIfAborted();
        let abort!: () => void;
        try {
          await Promise.race([releases.get(spawn.prompt)!.promise, new Promise<never>((_, reject) => {
            abort = () => reject(signal.reason);
            signal.addEventListener("abort", abort, { once: true });
          })]);
        } finally { signal.removeEventListener("abort", abort); }
        if (options.fail === spawn.prompt) throw new Error(`failure:${spawn.prompt}`);
        yield { type: "text_delta", delta: `findings:${spawn.prompt}` };
        yield { type: "complete", stopReason: "end_turn" };
      } } }),
    }) }),
  });
  return { root, events, requests, children, attemptedFinal, delegated,
    release: (label: string) => releases.get(label)!.resolve(),
    async close() { startChildren.resolve(); for (const release of releases.values()) release.resolve(); await root.close(); },
  };
}

describe("collecting child results before the final response", () => {
  // Catches finishing or streaming a summary after only one of several delegates has stopped.
  it("waits for every delegated result and regenerates the summary without publishing the premature answer", async () => {
    const f = await fixture();
    try {
      const run = f.root.submitMessage("delegate both and summarize");
      let finished = false;
      void run.result.then(() => { finished = true; }, () => {});
      await f.attemptedFinal.promise;
      expect(f.children).toHaveLength(2);
      f.release("first");
      await f.children[0]!.result;
      expect(finished).toBe(false);
      expect(f.events.filter(event => event.type === "output.text.delta")).toEqual([]);
      f.release("second");
      expect((await run.result).output).toBe("summary: first + second");
      expect(f.requests).toHaveLength(3);
      expect(f.events.filter(event => event.type === "output.text.delta").map(event => event.data.delta)).toEqual(["summary: first + second"]);
      expect(f.root.getHistory().some(message => message.type === "assistant" && message.content === "PREMATURE SUMMARY")).toBe(false);
    } finally { await f.close(); }
  });

  it("collects a child failure alongside successful results instead of hanging or reporting universal success", async () => {
    const f = await fixture({ fail: "second" });
    try {
      const run = f.root.submitMessage("delegate both and summarize");
      await f.attemptedFinal.promise;
      f.release("first"); f.release("second");
      expect((await run.result).output).toBe("summary: first completed; second failed");
      expect(JSON.stringify(f.requests.at(-1)!.messages)).toContain("failure:second");
    } finally { await f.close(); }
  });

  it("keeps cancellation responsive while the parent is waiting for its children", async () => {
    const f = await fixture();
    try {
      const run = f.root.submitMessage("delegate both and summarize");
      await f.attemptedFinal.promise;
      await new Promise<void>(resolve => setImmediate(resolve));
      await run.interrupt("cancel collection");
      await expect(run.result).rejects.toThrow("cancel collection");
      expect(f.events.filter(event => event.type === "output.text.delta")).toEqual([]);
    } finally { await f.close(); }
  });

  it("handles new parent input during the last permitted turn before building its request", async () => {
    const f = await fixture({ maxTurns: 2 });
    try {
      const run = f.root.submitMessage("delegate both and summarize");
      await f.delegated.promise;
      await new Promise<void>(resolve => setImmediate(resolve));
      await run.steer({ content: "release delegates" });
      expect((await run.result).output).toBe("summary: first + second");
      expect(f.requests[1]!.messages.some(message => message.type === "user" && message.content === "release delegates")).toBe(true);
    } finally { await f.close(); }
  });

  it("includes children admitted by an invocation that outlives its tool timeout", async () => {
    const f = await fixture({ lateStart: true });
    try {
      const run = f.root.submitMessage("delegate both and summarize");
      await f.attemptedFinal.promise;
      expect(f.events.filter(event => event.type === "output.text.delta")).toEqual([]);
      f.release("first"); f.release("second");
      expect((await run.result).output).toBe("summary: first + second");
    } finally { await f.close(); }
  });

  it("waits before the reserved last request without exceeding the fixed turn ceiling", async () => {
    const f = await fixture();
    try {
      const run = f.root.submitMessage("delegate both and summarize", { hardMaxTurns: 2 });
      await f.delegated.promise;
      expect(f.requests).toHaveLength(1);
      f.release("first"); f.release("second");
      await expect(run.result).rejects.toMatchObject({ name: "MaxTurnsExceeded" });
      expect(f.requests).toHaveLength(2);
      expect(JSON.stringify(f.requests[1]!.messages)).toContain("findings:second");
    } finally { await f.close(); }
  });

  it("does not allow SubmitResult to accept a delivery formed before child results arrived", async () => {
    const f = await fixture({ structured: true });
    try {
      const run = f.root.submitMessage("delegate both and summarize");
      await f.attemptedFinal.promise;
      expect(f.events.filter(event => event.type === "tool.started" && event.data.toolUse.name === "SubmitResult")).toEqual([]);
      f.release("first"); f.release("second");
      expect((await run.result).delivery).toMatchObject({ status: "done", summary: "summary: first + second" });
      expect(f.events.filter(event => event.type === "tool.started" && event.data.toolUse.name === "SubmitResult")).toHaveLength(1);
    } finally { await f.close(); }
  });

  it("does not collect a previous parent run's retained children again", async () => {
    const f = await fixture();
    try {
      const first = f.root.submitMessage("delegate both and summarize");
      await f.attemptedFinal.promise;
      f.release("first"); f.release("second");
      await first.result;
      const requestsBefore = f.requests.length;
      await f.root.runMessage("another question");
      expect(f.requests).toHaveLength(requestsBefore + 1);
      expect(f.root.getHistory().filter(message => message.type === "user" &&
        typeof message.content === "string" && message.content.startsWith("<subagent_results>"))).toHaveLength(1);
    } finally { await f.close(); }
  });

  it("keeps reports when new parent input coincides with child completion", async () => {
    const f = await fixture();
    try {
      const run = f.root.submitMessage("delegate both and summarize");
      await f.attemptedFinal.promise;
      await new Promise<void>(resolve => setImmediate(resolve));
      const steering = Promise.all(f.children.map(child => child.result)).then(() =>
        run.steer({ content: "review the evidence before the summary" }));
      f.release("first"); f.release("second");
      await steering;
      expect((await run.result).output).toBe("summary: first + second");
      expect(f.root.getHistory().filter(message => message.type === "user" &&
        typeof message.content === "string" && message.content.startsWith("<subagent_results>"))).toHaveLength(1);
    } finally { await f.close(); }
  });
});
