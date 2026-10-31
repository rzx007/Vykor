import { describe, expect, it } from "vitest";
import { PermissionChecker } from "../index.js";

describe("operation confirmation uses the session permission policy", () => {
  it.each(["default", "ask", "auto_review"] as const)("preserves a concrete operation confirmation in %s", async mode => {
    const checker = new PermissionChecker({ mode, autoApproveTools: ["Browser"] });
    expect((await checker.checkTool("Browser", { action: "inspect" })).action).toBe("allow");
    expect((await checker.checkTool("Browser", { action: "inspect" }, undefined, {
      requireConfirmation: true,
    })).action).toBe("ask");
  });

  it.each(["full_access", "full_auto"] as const)("honors %s after checking operation restrictions", async mode => {
    const checker = new PermissionChecker({ mode, deniedTools: ["Write"] });
    for (const tool of ["Browser", "BrowserDeveloper", "PluginInstall", "McpConfigure", "mcp__service__action", "NativePluginTool"]) {
      expect((await checker.checkTool(tool, {}, undefined, { requireConfirmation: true })).action).toBe("allow");
    }
    expect((await checker.checkTool("Write", {}, undefined, { requireConfirmation: true })).action).toBe("deny");
    checker.setMode("plan");
    expect((await checker.checkTool("Browser", {}, undefined, { requireConfirmation: true })).action).toBe("deny");
  });
});
