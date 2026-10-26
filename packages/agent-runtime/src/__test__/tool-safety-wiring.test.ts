import { describe, expect, it, vi } from "vitest";
import type { AgentExecutionContext, AgentToolSafety } from "@vykor/agent-contracts";
import { readonlyMap } from "@vykor/agent-contracts";
import { AgentChildManager } from "../kernel/children/child-agent.js";
import { AgentEventBus } from "../kernel/event-source.js";
import { createAgentKernel, createBasicAgentKernelRuntime } from "../kernel/index.js";
import { createDefaultNodeAgentWithInternals } from "../node/agent/default-agent.js";
import { deriveChildAgentOptions } from "../node/children/child-agent-options.js";
const safety = { operations: { prepare: async () => { throw new Error("unused"); }, authorize: async () => { throw new Error("unused"); }, dispatch: async () => { throw new Error("unused"); }, settle: async () => {}, reject: async () => {} }, requiredPolicy: { check: async () => ({ allowed: true, policyVersion: "v1" }) } } as AgentToolSafety;
const effects = { requestPermission: async () => ({ status: "approved" as const }) };
function runtime() { return createBasicAgentKernelRuntime({ client: { async *streamMessage() { yield { type: "complete", stopReason: "end_turn" }; } } }); }
describe("host tool safety wiring", () => {
  it("rejects an incomplete Node safety pair before creating local resources", async () => {
    const createLocalTerminal = vi.fn();
    await expect(createDefaultNodeAgentWithInternals({ toolSafety: { operations: {} } as AgentToolSafety }, { createLocalTerminal })).rejects.toThrow(/toolSafety/);
    expect(createLocalTerminal).not.toHaveBeenCalled();
  });
  it("retains host safety when root preparation is overridden", async () => {
    const engine = runtime();
    let captured: AgentExecutionContext | undefined;
    engine.submitMessage = async function* (_content, options) { captured = options?.execution; yield { type: "complete", stopReason: "end_turn" }; };
    const agent = await createAgentKernel({ cwd: "/work", engine, effects, toolSafety: safety, preparation: { prepare: async () => ({ run: { tools: readonlyMap([]) } }) } });
    await agent.runMessage("run", { preparation: { prepare: async () => ({ run: { tools: readonlyMap([]) } }) } });
    expect(captured?.toolSafety).toBe(safety);
    await agent.close();
  });
  it("includes host safety in direct runTool with no caller safety context", async () => {
    const engine = runtime(), release = vi.fn();
    const prepare = vi.fn(async () => ({ run: { tools: readonlyMap([]) }, release }));
    let captured: AgentExecutionContext | undefined;
    engine.executeTool = async (_tool, options) => { captured = options?.execution; return { content: "ok", toolUseId: "call", toolName: "Tool" }; };
    const agent = await createAgentKernel({ sessionId: "s", cwd: "/work", engine, effects, toolSafety: safety, preparation: { prepare } });
    await agent.runTool({ type: "tool_use", id: "call", name: "Tool", input: {} }, { tools: readonlyMap([]), scope: { agentId: "wrong", sessionId: "wrong", runId: "r", inputId: "i", traceId: "t", cwd: "/wrong", signal: new AbortController().signal } });
    expect(captured?.toolSafety).toBe(safety);
    expect(captured?.scope.sessionId).toBe("s");
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    await agent.close();
  });
  it("inherits the same trusted pair in child configuration", () => {
    const child = deriveChildAgentOptions({ configuration: { toolSafety: safety }, settings: {} as never, child: { prompt: "child" } as never, cwd: "/work", sessionId: "child" });
    expect(child.toolSafety).toBe(safety);
  });
  it("prepares and releases safety for a manual tool from a preparation-only Kernel host", async () => {
    const engine = runtime(), release = vi.fn();
    let captured: AgentExecutionContext | undefined;
    engine.executeTool = async (_tool, options) => { captured = options?.execution; return { content: "ok", toolUseId: "call", toolName: "Tool" }; };
    const agent = await createAgentKernel({ sessionId: "s", cwd: "/work", engine, effects, preparation: { prepare: async () => ({ run: { tools: readonlyMap([]), toolSafety: safety }, release }) } });
    await agent.runTool({ type: "tool_use", id: "call", name: "Tool", input: {} }, { tools: readonlyMap([]), scope: { agentId: "s", sessionId: "s", runId: "r", inputId: "i", traceId: "t", cwd: "/work", signal: new AbortController().signal } });
    expect(captured?.toolSafety).toBe(safety);
    expect(release).toHaveBeenCalledTimes(1);
    await agent.close();
  });

  it.each([false, true])("prepares and releases safety for a post-run child, including spawn failure %s", async failSpawn => {
    let captured: AgentExecutionContext | undefined;
    const release = vi.fn();
    const agent = await createAgentKernel({
      sessionId: "s", cwd: "/work", engine: runtime(), effects,
      preparation: { prepare: async () => ({ run: { tools: readonlyMap([]), toolSafety: safety }, release }) },
      resolveChild: input => {
        if (failSpawn) throw new Error("spawn failed");
        return { spawn: input.spawn, createAgent: async () => {
          const engine = runtime();
          engine.submitMessage = async function* (_content, options) { captured = options?.execution; yield { type: "complete", stopReason: "end_turn" }; };
          return createAgentKernel({ sessionId: input.sessionId, cwd: "/work", engine, effects, preparation: { prepare: async () => ({ run: { tools: readonlyMap([]) } }) } });
        } };
      },
    });
    const result = agent.runChildForCompletedRun({ description: "review", prompt: "review", agent: "worker", cwd: "/work" }, { runId: "r", inputId: "i", traceId: "t" }, "review");
    if (failSpawn) await expect(result).rejects.toThrow("spawn failed");
    else { await result; expect(captured?.toolSafety).toBe(safety); }
    expect(release).toHaveBeenCalledTimes(1);
    await agent.close();
  });
  it("carries safety through the parent context into a child Kernel run", async () => {
    let captured: AgentExecutionContext | undefined;
    const manager = new AgentChildManager({ cwd: "/work", eventBus: new AgentEventBus(), resolveChild: input => ({ spawn: input.spawn, createAgent: async () => {
      const engine = runtime();
      engine.submitMessage = async function* (_content, options) { captured = options?.execution; yield { type: "complete", stopReason: "end_turn" }; };
      return createAgentKernel({ sessionId: input.sessionId, cwd: "/work", engine, effects, preparation: { prepare: async () => ({ run: { tools: readonlyMap([]) } }) } });
    } }) });
    const invocation = await manager.createController({ agentId: "root", sessionId: "root", runId: "r", inputId: "i", traceId: "t", cwd: "/work", signal: new AbortController().signal, toolSafety: safety }).spawnChildAgent({ description: "child", prompt: "task", agent: "worker", cwd: "/work" });
    await invocation.result;
    expect(captured?.toolSafety).toBe(safety);
    await manager.closeAll();
  });

});
