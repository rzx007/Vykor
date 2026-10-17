import { describe, expect, it } from "vitest";
import { RuntimeBundle, ToolRegistry, type AgentEvent, type StreamMessageParams, type StreamingMessageClient } from "@vykor/core";
import { createAssembledAgent } from "./agent.js";
import { AgentEventBus } from "./event-source.js";

function fixture(withSelection = true) {
  const requests: StreamMessageParams[] = [];
  const events: AgentEvent[] = [];
  const client: StreamingMessageClient = { async *streamMessage(params) {
    requests.push(params);
    yield { type: "text_delta", delta: '{"pluginId":"office"}' };
    yield { type: "complete", stopReason: "end_turn" };
  } };
  const runtime = new RuntimeBundle({ model: "old-model", permission: { mode: "default" } } as any,
    { async *streamMessage() { throw new Error("stale client"); } }, new ToolRegistry(), {} as any, {} as any, {} as any);
  runtime.resolveRequestConfiguration = async () => ({ revision: 2, client, model: "current-model" });
  const candidate = { pluginId: "office", displayName: "Office", description: "Create PPTX", version: "1", behaviorDigest: "digest" };
  let validated = 0;
  const pluginSelection = { candidates: [candidate], validate: async () => { validated++; } };
  const history: unknown[] = [];
  const agent = createAssembledAgent({ runtime, ...(withSelection ? { pluginSelection } : {}), session: { id: "s1", getHistory: () => history } as any,
    mcpConnections: () => [], eventBus: new AgentEventBus(event => { events.push(event); }), effects: {} as any,
    childManager: {} as any, childDirectory: {} as any, capabilities: {} as any, model: "old-model" });
  const options = { runId: "r1", inputId: "i1", traceId: "t1", signal: new AbortController().signal };
  return { agent, runtime, pluginSelection, candidate, requests, events, history, options, get validated() { return validated; } };
}

describe("Agent plugin selection boundary", () => {
  it("skips selection without an agent-owned catalog", async () => {
    const f = fixture(false);
    await expect(f.agent.selectPluginForRun("create slides", f.options)).resolves.toEqual({ pluginId: null, reason: "no_candidates" });
    expect(f.requests).toHaveLength(0);
    expect(f.validated).toBe(0);
  });
  it("uses the current request client and model and scopes usage to the existing Run without adding conversation history", async () => {
    const f = fixture();
    const result = await f.agent.selectPluginForRun("create slides", f.options);
    expect(result.pluginId).toBe("office");
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0].model).toBe("current-model");
    expect(f.events[0].context).toMatchObject({ agentId: "s1", sessionId: "s1", runId: "r1", inputId: "i1", traceId: "t1" });
    expect(f.validated).toBe(1);
    expect(f.history).toEqual([]);
    expect(f.agent.state).toBe("idle");
  });
  it("revalidates a recovered selection without calling the model", async () => {
    const f = fixture();
    const result = await f.agent.selectPluginForRun("", { ...f.options,
      resolvedSelection: { pluginId: "office", version: "1", behaviorDigest: "digest", reason: "matched" } });
    expect(result.pluginId).toBe("office");
    expect(f.validated).toBe(1);
    expect(f.requests).toHaveLength(0);
  });
  it.each([{ version: "2", behaviorDigest: "digest" }, { version: "1", behaviorDigest: "changed" }])
    ("refuses a recovered selection whose source identity changed: %j", async identity => {
      const f = fixture();
      await expect(f.agent.selectPluginForRun("", { ...f.options,
        resolvedSelection: { pluginId: "office", ...identity, reason: "matched" } })).rejects.toThrow("Plugin changed");
      expect(f.requests).toHaveLength(0);
      expect(f.validated).toBe(0);
    });
  it("refuses changed files after selection and does not return a usable plugin", async () => {
    const f = fixture();
    f.pluginSelection.validate = async () => { throw new Error("plugin files changed"); };
    await expect(f.agent.selectPluginForRun("create slides", f.options)).rejects.toThrow("files changed");
    expect(f.requests).toHaveLength(1);
    expect(f.agent.state).toBe("idle");
  });
});
