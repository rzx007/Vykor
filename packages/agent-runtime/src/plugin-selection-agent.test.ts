import { describe, expect, it } from "vitest";
import { RuntimeBundle, ToolRegistry } from "@vykor/core";
import { createAssembledAgent } from "./agent.js";
import { AgentEventBus } from "./event-source.js";

function fixture(withCatalog = true) {
  let modelCalls = 0;
  const runtime = new RuntimeBundle({ model: "test", permission: { mode: "default" } } as any,
    { async *streamMessage() { modelCalls++; throw new Error("validation cannot call a model"); } }, new ToolRegistry(), {} as any, {} as any, {} as any);
  const candidate = { pluginId: "office", displayName: "Office", description: "Create PPTX", version: "1", behaviorDigest: "digest" };
  const validated: string[] = [];
  const pluginSelection = { candidates: [candidate], validate: async (item: typeof candidate) => { validated.push(item.pluginId); } };
  const agent = createAssembledAgent({ runtime, ...(withCatalog ? { pluginSelection } : {}),
    session: { id: "s1", getHistory: () => [] } as any, mcpConnections: () => [], eventBus: new AgentEventBus(), effects: {} as any,
    childManager: {} as any, childDirectory: {} as any, capabilities: {} as any, model: "test" });
  return { agent, candidate, pluginSelection, validated, signal: new AbortController().signal, get modelCalls() { return modelCalls; } };
}

describe("Agent plugin catalog boundary", () => {
  it("returns an empty catalog and permits baseline validation without a plugin catalog", async () => {
    const f = fixture(false);
    expect(f.agent.getPluginCandidates()).toEqual([]);
    await f.agent.validatePluginScope([], f.signal);
    await expect(f.agent.validatePluginScope([f.candidate], f.signal)).rejects.toThrow(/changed|available/);
    expect(f.modelCalls).toBe(0);
  });
  it("validates captured plugin identities without a model request or maintenance operation", async () => {
    const f = fixture();
    const candidates = f.agent.getPluginCandidates();
    expect(candidates).toEqual([f.candidate]);
    expect(() => { (candidates as any).push(f.candidate); }).toThrow();
    await f.agent.validatePluginScope(candidates, f.signal);
    expect(f.validated).toEqual(["office"]);
    expect(f.modelCalls).toBe(0);
    expect(f.agent.state).toBe("idle");
  });
  it.each([{ version: "2" }, { behaviorDigest: "changed" }, { pluginId: "foreign" }])
    ("rejects a changed or foreign candidate before catalog validation: %j", async identity => {
      const f = fixture();
      await expect(f.agent.validatePluginScope([{ ...f.candidate, ...identity }], f.signal)).rejects.toThrow(/changed|available/);
      expect(f.validated).toEqual([]);
      expect(f.modelCalls).toBe(0);
    });
  it("fails when an installed plugin is revoked after the snapshot", async () => {
    const f = fixture();
    f.pluginSelection.validate = async () => { throw new Error("plugin disabled"); };
    await expect(f.agent.validatePluginScope(f.agent.getPluginCandidates(), f.signal)).rejects.toThrow("plugin disabled");
    expect(f.modelCalls).toBe(0);
  });
  it("honors cancellation before reading plugin files", async () => {
    const f = fixture();
    await expect(f.agent.validatePluginScope(f.agent.getPluginCandidates(), AbortSignal.abort(new Error("cancelled")))).rejects.toThrow("cancelled");
    expect(f.validated).toEqual([]);
  });
});
