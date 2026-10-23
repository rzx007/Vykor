import {describe,it,expect} from "vitest";
import {QueryEngine,ToolRegistry} from "@vykor/core/engine";
import {NodeRuntimeBuilder} from "../node-runtime-builder.js";
function allowAll():any{return {checkTool:async()=>({action:"allow"})};}
function noopHooks():any{return {execute:async()=>({blocked:false})};}
describe("Integration: NodeRuntimeBuilder", () => {
  it("builds a valid RuntimeBundle", () => {
    const mockClient = { streamMessage: async function* () {} };
    const registry = new ToolRegistry();
    const checker = allowAll();
    const hooks = noopHooks();
    const engine = new QueryEngine(mockClient, registry, checker, hooks);

    const bundle = new NodeRuntimeBuilder()
      .setApiClient(mockClient)
      .setToolRegistry(registry)
      .setPermissionChecker(checker)
      .setHookExecutor(hooks)
      .setQueryEngine(engine)
      .build({ model: "test", apiFormat: "anthropic", permission: { mode: "default" }, maxTurns: 10 });

    expect(bundle.settings.model).toBe("test");
    expect(bundle.apiClient).toBe(mockClient);
    expect(bundle.queryEngine).toBe(engine);
  });

  it("switchApiClient updates the query engine client for subsequent calls", async () => {
    const usedClients: string[] = [];
    const clientA = {
      streamMessage: async function* () {
        usedClients.push("A");
        yield { type: "complete" as const, stopReason: "end_turn" };
      },
    };
    const clientB = {
      streamMessage: async function* () {
        usedClients.push("B");
        yield { type: "complete" as const, stopReason: "end_turn" };
      },
    };
    const registry = new ToolRegistry();
    const checker = allowAll();
    const hooks = noopHooks();
    const engine = new QueryEngine(clientA, registry, checker, hooks);

    const bundle = new NodeRuntimeBuilder()
      .setApiClient(clientA)
      .setToolRegistry(registry)
      .setPermissionChecker(checker)
      .setHookExecutor(hooks)
      .setQueryEngine(engine)
      .build({ model: "test", apiFormat: "anthropic", permission: { mode: "default" }, maxTurns: 10 });

    for await (const _ of bundle.queryEngine.submitMessage("before")) {}
    bundle.switchApiClient(clientB);
    for await (const _ of bundle.queryEngine.submitMessage("after")) {}

    expect(bundle.apiClient).toBe(clientB);
    expect(usedClients).toEqual(["A", "B"]);
  });

  it("throws if missing required components", () => {
    expect(() => new NodeRuntimeBuilder().build({ model: "x", apiFormat: "anthropic", permission: { mode: "default" }, maxTurns: 1 }))
      .toThrow("ApiClient is required");
  });
});
