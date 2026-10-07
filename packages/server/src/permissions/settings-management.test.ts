import { describe, expect, it } from "vitest";
import {
  checkPermissionConfiguration,
  inspectPermissionConfiguration,
  validateIsolationConfiguration,
} from "./settings-management.js";

describe("permission settings host inspection", () => {
  it("converts the selected Windows workspace before checking WSL read rules", async () => {
    expect(
      await checkPermissionConfiguration({
        permission: { mode: "default" },
        toolName: "Read",
        cwd: "D:/workspace",
        path: "D:/workspace/app.ts",
        environment: "wsl",
      }),
    ).toMatchObject({ action: "allow" });
    expect(
      await checkPermissionConfiguration({
        permission: { mode: "default" },
        toolName: "Read",
        cwd: "D:/workspace",
        path: "/etc/passwd",
        environment: "wsl",
      }),
    ).toMatchObject({ action: "ask" });
  });
  it("rejects malformed isolation flags and paths", () => {
    const sandbox = inspectPermissionConfiguration({}).sandbox;
    expect(() =>
      validateIsolationConfiguration({ ...sandbox, failIfUnavailable: "yes" }),
    ).toThrow();
    expect(() =>
      validateIsolationConfiguration({
        ...sandbox,
        filesystem: { ...sandbox.filesystem, allowWrite: [null] },
      }),
    ).toThrow();
    expect(validateIsolationConfiguration(sandbox)).toEqual(sandbox);
  });
});
