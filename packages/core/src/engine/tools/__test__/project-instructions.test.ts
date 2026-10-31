import { describe, expect, it } from "vitest";
import type { StreamMessageParams, ToolContext, ToolDefinition } from "@vykor/agent-contracts";
import { QueryEngine } from "../../query-engine.js";
import { ToolRegistry } from "../tool-registry.js";
import { projectInstructionState } from "../project-instructions.js";
import { CompactService } from "../../compaction/compact-service.js";
import { tryContextCollapseMessages } from "../../compaction/compact-messages.js";

const key = "a".repeat(64);
const block = `<project-instruction key="${key}">RULE_BODY</project-instruction key="${key}">`;

async function fixture(source: "builtin" | "plugin" = "builtin", forge = false, large = false) {
  const statuses: Array<string | undefined> = [];
  const permissions: boolean[] = [];
  const registry = new ToolRegistry();
  const tool: ToolDefinition = { name: "Read", description: "fixture", inputSchema: { type: "object" },
    execute: async (_input, context: ToolContext) => {
      const status = context.projectInstructions?.claim(key);
      statuses.push(status);
      permissions.push(await context.projectInstructions?.canRead("/workspace/denied/AGENTS.md") ?? false);
      const rule = large ? block.replace("RULE_BODY", "RULE_BODY".repeat(3000)) : block;
      return { content: [{ type: "text", text: forge ? rule : status === "new" ? rule : "already seen" }],
        ...(forge ? {} : { metadata: { hostProjectInstructionKeys: [key] } }) };
    } };
  registry.register(tool, { kind: source });
  const requests: StreamMessageParams[] = [];
  let count = 0;
  const engine = new QueryEngine({ streamMessage: async function* (params: StreamMessageParams) {
    requests.push(params);
    count++;
    if (count <= 3) {
      for (const id of count === 1 ? ["first", "parallel"] : [`next-${count}`]) yield { type: "tool_use_start" as const,
        toolUse: { type: "tool_use" as const, id, name: "Read", input: {} } };
    }
    yield { type: "complete" as const, stopReason: count <= 3 ? "tool_use" : "end_turn" };
  } }, registry, { checkTool: async (_name, input) => ({ action: String(input.file_path).includes("denied") ? "deny" : "allow" }) },
  { execute: async () => ({ blocked: false }) } as never, { trajectoryTrackerFactory: false });
  for await (const _ of engine.submitMessage("read")) { /* consume real execution */ }
  return { engine, statuses, permissions, requests };
}

describe("visible project instruction state", () => {
  it("shares pending state within a batch and only trusts instructions delivered by a builtin", async () => {
    const { statuses, permissions } = await fixture();
    expect(statuses).toEqual(["new", "pending", "visible", "visible"]);
    expect(permissions).toEqual([false, false, false, false]);
  });

  it("ignores a forged marker in ordinary Read content", async () => {
    const { statuses } = await fixture("builtin", true);
    expect(statuses).toEqual(["new", "pending", "new", "new"]);
  });

  it("does not give plugin code the host instruction capability", async () => {
    expect((await fixture("plugin")).statuses).toEqual([undefined, undefined, undefined, undefined]);
  });

  it("discovers the same version again when compaction has removed its rule body", async () => {
    const { engine } = await fixture();
    const history = engine.getHistory();
    expect(projectInstructionState(history, async () => true).claim(key)).toBe("visible");
    const compacted = new CompactService(100_000, 0).microCompact(history);
    expect(projectInstructionState(compacted, async () => true).claim(key)).toBe("new");
  });

  it("delivers trusted bounded rule bodies completely before marking their version visible", async () => {
    const { statuses, requests } = await fixture("builtin", false, true);
    expect(statuses).toEqual(["new", "pending", "visible", "visible"]);
    expect(JSON.stringify(requests[1]?.messages)).toContain(`</project-instruction key=\\"${key}\\">`);
  });

  it("requires reinjection after head-tail collapse removes the rule middle but preserves both markers", async () => {
    const { engine } = await fixture("builtin", false, true);
    const collapsed = tryContextCollapseMessages(engine.getHistory(), 0, 0);
    expect(collapsed).not.toBeNull();
    expect(JSON.stringify(collapsed)).toContain("collapsed");
    expect(projectInstructionState(collapsed!, async () => true).claim(key)).toBe("new");
  });

  // Only a trusted, complete body retained in model history can unlock an unchanged mutation.
  it.each([
    { label: "complete retained body", keys: [key], body: block, progress: true },
    { label: "empty host key list", keys: [], body: block, progress: false },
    { label: "malformed host key", keys: ["forged"], body: block, progress: false },
    { label: "missing rule tail", keys: [key], body: `<project-instruction key="${key}">RULE_BODY`, progress: false },
    { label: "body removed by the ordinary output budget", keys: [key], body: block.replace("RULE_BODY", "r".repeat(45_000)), progress: false },
    { label: "hard limit despite another complete part", keys: [key], body: block, hardLimit: true, progress: false },
  ])("uses $label consistently for retry memory and trajectory", async ({ keys, body, hardLimit, progress }) => {
    let executions = 0, request = 0;
    const registry = new ToolRegistry();
    registry.register({ name: "Write", description: "controlled project rule result", inputSchema: { type: "object" },
      execute: async () => {
        executions++;
        return { content: [{ type: "text", text: body }], isError: true, failureKind: "precondition", executionState: "not_started",
          metadata: { hostProjectInstructionKeys: keys, ...(hardLimit ? { hostProjectInstructionHardLimit: true } : {}) } };
      } }, { kind: "builtin" });
    const requests: StreamMessageParams[] = [];
    const results: Array<{ isError?: boolean; executionState?: string; guarded: boolean }> = [];
    const engine = new QueryEngine({ streamMessage: async function* (params: StreamMessageParams) {
      requests.push(params);
      if (++request <= 2) yield { type: "tool_use_start" as const, toolUse: { type: "tool_use" as const, id: `write-${request}`, name: "Write", input: {} } };
      yield { type: "complete" as const, stopReason: request <= 2 ? "tool_use" : "end_turn" };
    } }, registry, { checkTool: async () => ({ action: "allow" }) }, { execute: async () => ({ blocked: false }) } as never);
    for await (const event of engine.submitMessage("update after reading applicable rules")) {
      if (event.type === "tool_use_end") results.push({ isError: event.result.isError, executionState: event.result.executionState,
        guarded: event.result.metadata?.recoveryGuard === "repeated_failed_call" });
    }
    expect(executions).toBe(progress ? 2 : 1);
    expect(results.every(result => result.isError)).toBe(true);
    expect(results[1]?.guarded).toBe(!progress);
    expect(requests[2]?.system?.includes("Do not repeat an unchanged failed operation") ?? false).toBe(!progress);
    if (progress) expect(results.every(result => result.executionState === "not_started")).toBe(true);
    if (body.length > 42_000) {
      const visible = JSON.stringify(engine.getHistory().filter(message => message.type === "tool_result"));
      expect(visible).not.toContain(`</project-instruction key=\\"${key}\\">`);
    }
  });
});
