import { describe, expect, it } from "vitest";
import { resolveRuntimeModes } from "./runtime-modes.js";

describe("CLI runtime modes", () => {
  it.each(["ask", "auto_review", "full_access"])("keeps %s authorization when planning is enabled", (permissionMode) => {
    expect(resolveRuntimeModes({ permissionMode, plan: true }, "ask")).toEqual({
      approvalMode: permissionMode, workMode: "plan",
    });
  });

  it("migrates legacy plan and full_auto inputs", () => {
    expect(resolveRuntimeModes({ permissionMode: "plan" }, "full_auto")).toEqual({
      approvalMode: "ask", workMode: "plan",
    });
    expect(resolveRuntimeModes({}, "full_auto")).toEqual({
      approvalMode: "auto_review", workMode: "execute",
    });
  });

  it("gives explicit work mode priority and maps skip-permissions to full access", () => {
    expect(resolveRuntimeModes({ permissionMode: "plan", workMode: "execute" }, "ask")).toEqual({
      approvalMode: "ask", workMode: "execute",
    });
    expect(resolveRuntimeModes({ permissionMode: "auto_review", plan: true, dangerouslySkipPermissions: true }, "ask")).toEqual({
      approvalMode: "full_access", workMode: "plan",
    });
  });
});
