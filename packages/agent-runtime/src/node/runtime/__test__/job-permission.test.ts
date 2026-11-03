import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "@vykor/agent-contracts";
import type { Settings } from "@vykor/host-config";
import { RoutedAgentJobHost } from "@vykor/jobs";
import { createVykorRuntime } from "../default-runtime.js";
import type { ResolvedAgentCapabilities } from "../../capabilities/capability-resolution.js";

const client = { async *streamMessage() { yield { type: "complete" as const, stopReason: "end_turn" as const }; } };
const settings: Settings = { model: "test", apiFormat: "anthropic", permission: { mode: "ask" } };
const observations = ["JobList", "JobRead", "JobWait"] as const;
const capabilities: ResolvedAgentCapabilities = {
  jobs: { status: "available", value: new RoutedAgentJobHost({}), source: "default" },
  terminal: { status: "disabled" }, backgroundShell: { status: "disabled" },
  memory: { status: "disabled" }, childEnvironment: { status: "disabled" },
  workflowRepository: { status: "disabled" }, schedules: { status: "disabled" },
};

describe("session-owned Job observation permissions", () => {
  it.each([
    ["ask", "execute"], ["auto_review", "execute"],
    ["ask", "plan"], ["auto_review", "plan"],
  ] as const)("allows trusted observations in %s/%s without approving control tools", async (approvalMode, workMode) => {
    const runtime = await createVykorRuntime({ settings, capabilities, configuration: { client, approvalMode, workMode } });
    try {
      for (const tool of observations) {
        expect(runtime.toolRegistry.inspect(tool)?.source.kind).toBe("builtin");
        await expect(runtime.permissionChecker.checkTool(tool, {})).resolves.toMatchObject({ action: "allow" });
      }
      for (const tool of ["JobSend", "JobCancel"]) {
        await expect(runtime.permissionChecker.checkTool(tool, {})).resolves.toMatchObject({ action: workMode === "plan" ? "deny" : "ask" });
      }
      // The default grant is limited to existing-job observations, not all read-only tools.
      await expect(runtime.permissionChecker.checkTool("WebFetch", { url: "https://example.test" })).resolves.toMatchObject({ action: "ask" });
    } finally {
      await runtime.close();
    }
  });

  it.each(["deniedTools", "denyRule", "allowedTools"] as const)("keeps %s restrictions ahead of the observation grant", async restriction => {
    const runtime = await createVykorRuntime({
      capabilities,
      settings: { ...settings, permission: { mode: "ask", ...(restriction === "deniedTools" ? { deniedTools: [...observations] } : {}), ...(restriction === "allowedTools" ? { allowedTools: ["Read"] } : {}) } },
      configuration: { client, approvalMode: "auto_review" },
    });
    try {
      for (const tool of observations) {
        if (restriction === "denyRule") runtime.permissionChecker.addRule({ tool, action: "deny" });
        await expect(runtime.permissionChecker.checkTool(tool, {})).resolves.toMatchObject({ action: "deny" });
      }
    } finally {
      await runtime.close();
    }
  });

  it.each(["execute", "plan"] as const)("does not trust same-name replacements in %s mode", async workMode => {
    const replacements: ToolDefinition[] = observations.map(name => ({ name, description: "External replacement", inputSchema: { type: "object" }, execute: async () => ({ content: [] }) }));
    const runtime = await createVykorRuntime({ settings, capabilities, configuration: { client, approvalMode: "auto_review", workMode, toolOverrides: replacements } });
    try {
      for (const tool of observations) {
        expect(runtime.toolRegistry.inspect(tool)?.source.kind).toBe("agent");
        await expect(runtime.permissionChecker.checkTool(tool, {})).resolves.toMatchObject({ action: workMode === "plan" ? "deny" : "ask" });
      }
    } finally {
      await runtime.close();
    }
  });
});
