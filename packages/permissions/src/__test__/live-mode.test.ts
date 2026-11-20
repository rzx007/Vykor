import { describe, expect, it } from "vitest";
import type { PermissionMode } from "@vykor/agent-contracts";
import { PermissionChecker } from "../index.js";

describe("host-owned live permission mode", () => {
  it("captures a mode once for the whole compound command check", async () => {
    let mode: PermissionMode = "full_access";
    const checker = new PermissionChecker({ mode: () => mode, shellDialect: "posix" });
    const first = checker.checkTool("Shell", { command: "echo first; echo second" });
    mode = "ask";
    expect(await first).toMatchObject({ action: "allow" });
    expect(await checker.checkTool("Shell", { command: "echo third" })).toMatchObject({ action: "ask" });
    mode = "full_access";
    expect(await checker.checkTool("Shell", { command: "echo fourth" })).toMatchObject({ action: "allow" });
  });

  it("preserves deny rules and the planning ceiling after switching", async () => {
    let mode: PermissionMode = "ask";
    const checker = new PermissionChecker({ mode: () => mode, deniedCommands: ["remove-private*"], shellDialect: "posix" });
    mode = "full_access";
    expect(await checker.checkTool("Shell", { command: "echo ok; remove-private data" })).toMatchObject({ action: "deny" });
    checker.addRule({ tool: "Write", action: "deny" });
    expect(await checker.checkTool("Write", {})).toMatchObject({ action: "deny" });
    mode = "plan";
    expect(await checker.checkTool("Shell", { command: "echo ok" })).toMatchObject({ action: "deny" });
  });
});
