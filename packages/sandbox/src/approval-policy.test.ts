import { describe, expect, it } from "vitest";
import type { Settings } from "@vykor/core";
import { settingsForApprovalMode } from "./approval-policy.js";
import { resolveSandboxPolicy } from "./policy.js";
import { validateSandboxPath } from "./path-validator.js";

describe("session approval execution settings", () => {
  const settings = { permission: { mode: "ask" }, sandbox: { enabled: true, filesystem: { denyRead: [".secrets"] }, network: { mode: "none" } } } as Settings;
  it("full access uses a session copy without changing another session", () => {
    const full = settingsForApprovalMode(settings, "full_access");
    expect(full.sandbox?.enabled).toBe(false);
    expect(full.sandbox?.network?.mode).toBe("host");
    expect(settingsForApprovalMode(settings, "ask").sandbox?.enabled).toBe(true);
    expect(settings.sandbox?.network?.mode).toBe("none");
  });
  it("restores the original isolation when a full-access session is narrowed", () => {
    const full = settingsForApprovalMode(settings, "full_access");
    expect(settingsForApprovalMode(full, "full_access")).toBe(full);
    expect(settingsForApprovalMode(full, "ask")).toBe(settings);
    expect(settingsForApprovalMode(full, "auto_review")).toBe(settings);
    expect(JSON.stringify(full)).not.toContain("approval-baseline");
  });
  it("retains explicit file denies when lifting ordinary boundaries", async () => {
    const full = settingsForApprovalMode(settings, "full_access");
    const policy = resolveSandboxPolicy({ cwd: process.cwd(), settings: full });
    expect(await validateSandboxPath(".secrets/password", { sandboxRoot: process.cwd(), operation: "read", policy })).toMatchObject({ allowed: false });
    expect(await validateSandboxPath("../outside.txt", { sandboxRoot: process.cwd(), operation: "read", policy })).toMatchObject({ allowed: true });
  });
});
