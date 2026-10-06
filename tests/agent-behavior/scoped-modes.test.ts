import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentExecutionContext, PermissionMode, StreamMessageParams, ToolUseBlock } from "@vykor/core";
import { PermissionChecker } from "@vykor/permissions";
import { createVykorRuntime } from "../../packages/agent-runtime/src/default-runtime.js";
import { createRunCapabilityView } from "../../packages/agent-runtime/src/run-capability-view.js";

const dirs: string[] = [];
const previousConfig = process.env.VYKOR_CONFIG_DIR;
afterEach(() => {
  if (previousConfig === undefined) delete process.env.VYKOR_CONFIG_DIR;
  else process.env.VYKOR_CONFIG_DIR = previousConfig;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function directory() {
  const cwd = mkdtempSync(join(tmpdir(), "oh-scoped-mode-")); dirs.push(cwd); return cwd;
}
const use = (name: string, input: Record<string, unknown> = {}): ToolUseBlock => ({ type: "tool_use", id: name, name, input });
function context(runtime: Awaited<ReturnType<typeof createVykorRuntime>>, cwd: string, approvals: string[]): AgentExecutionContext {
  return {
    scope: { agentId: cwd, sessionId: cwd, runId: "run", inputId: "input", traceId: "trace", cwd, signal: new AbortController().signal },
    capabilityView: createRunCapabilityView({ toolRegistry: runtime.toolRegistry }),
    effects: { requestPermission: async (input) => { approvals.push(input.toolName); return { status: "approved" }; } },
    emit: async () => {}, takeSteeredInputs: async () => [], closeSteering: () => {},
    children: { hasChildAgent: () => false, spawnChildAgent: async () => { throw new Error("No child in mode fixture"); }, sendChildInput: async () => { throw new Error("No child in mode fixture"); }, interruptChildAgent: async () => {}, awaitChildAgent: async () => { throw new Error("No child in mode fixture"); } },
  };
}
async function fixture(mode: PermissionMode, actions: ToolUseBlock[] = []) {
  const cwd = directory();
  process.env.VYKOR_CONFIG_DIR = join(cwd, "config");
  const requests: StreamMessageParams[] = [];
  const approvals: string[] = [];
  const runtime = await createVykorRuntime({ cwd,
    settings: { model: "offline", permission: { mode, autoApproveTools: ["Write", "EnterPlanMode", "ExitPlanMode"] }, sandbox: { enabled: false } },
    configuration: { client: { async *streamMessage(params) {
      requests.push({ ...params, messages: structuredClone(params.messages) });
      const action = actions.shift();
      if (action) yield { type: "tool_use_start", toolUse: action };
      yield { type: "complete", stopReason: action ? "tool_use" : "end_turn" };
    } } },
  });
  return { cwd, runtime, requests, approvals, execution: context(runtime, cwd, approvals) };
}
async function run(sample: Awaited<ReturnType<typeof fixture>>) {
  for await (const _ of sample.runtime.queryEngine.submitMessage("Inspect the adopted plan; implementation requires the existing permission ceiling.", { execution: sample.execution })) { /* consume */ }
}

describe("scoped-mode-v1: actual checker, tools, requests and filesystem", () => {
  it("denies mutations in analysis mode before auto approvals and path rules", async () => {
    const checker = new PermissionChecker({ mode: "plan", cwd: directory(), autoApproveTools: ["Write", "Shell", "Agent"], pathRules: [{ pattern: "*", allow: true }] });
    for (const name of ["Write", "Edit", "ApplyPatch", "Shell", "Agent", "JobSend", "ScheduleCreate", "UnknownPluginMutation"]) {
      expect(await checker.checkTool(name, { file_path: "notes.txt" })).toMatchObject({ action: "deny" });
    }
    expect(await checker.checkTool("Read", { file_path: "notes.txt" })).toMatchObject({ action: "allow" });
  });

  it("narrows the current runtime, changes the next request and leaves other sessions/global settings alone", async () => {
    const sample = await fixture("full_auto", [use("EnterPlanMode"), use("Write", { file_path: "blocked.txt", content: "forbidden" })]);
    const other = await fixture("default");
    const globalConfig = join(other.cwd, "config", "settings.json");
    try {
      await run(sample);
      expect(sample.runtime.permissionChecker.getMode()).toBe("plan");
      expect(sample.requests[1]!.system).toContain("Plan mode is enabled");
      expect(existsSync(join(sample.cwd, "blocked.txt"))).toBe(false);
      expect(other.runtime.permissionChecker.getMode()).toBe("default");
      expect(existsSync(globalConfig)).toBe(false);
      expect(sample.approvals).toEqual([]);
      await run(sample);
      expect(sample.requests.at(-1)!.system).toContain("Plan mode is enabled");
      console.info("MODE baseline: requests=%d effective=%s other=%s configWritten=%s projectWritten=%s", sample.requests.length, sample.runtime.permissionChecker.getMode(), other.runtime.permissionChecker.getMode(), existsSync(globalConfig), existsSync(join(sample.cwd, "blocked.txt")));
    } finally { await sample.runtime.close(); await other.runtime.close(); }
  });

  it.each(["default", "full_auto"] as const)("restores only the selected %s ceiling", async (mode) => {
    const sample = await fixture(mode, [use("EnterPlanMode"), use("ExitPlanMode"), use("Write", { file_path: "authorized.txt", content: "authorized" })]);
    try {
      await run(sample);
      expect(sample.runtime.permissionChecker.getMode()).toBe(mode);
      expect(readFileSync(join(sample.cwd, "authorized.txt"), "utf8")).toBe("authorized");
      expect(sample.requests[1]!.system).toContain("Plan mode is enabled");
      expect(sample.requests[2]!.system).toContain(mode === "full_auto" ? "Full-auto permission mode" : "Default permission mode");
      expect(existsSync(join(sample.cwd, "config", "settings.json"))).toBe(false);
    } finally { await sample.runtime.close(); }
  });

  it("cannot exit a user-selected analysis ceiling even with host approval", async () => {
    const sample = await fixture("plan", [use("ExitPlanMode"), use("Write", { file_path: "blocked.txt", content: "forbidden" })]);
    writeFileSync(join(sample.cwd, "existing.txt"), "unchanged");
    try {
      await run(sample);
      expect(sample.runtime.permissionChecker.getMode()).toBe("plan");
      expect(existsSync(join(sample.cwd, "blocked.txt"))).toBe(false);
      expect(readFileSync(join(sample.cwd, "existing.txt"), "utf8")).toBe("unchanged");
      expect(existsSync(join(sample.cwd, "config", "settings.json"))).toBe(false);
    } finally { await sample.runtime.close(); }
  });
});
