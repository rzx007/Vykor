import { describe, expect, it } from "vitest";
import { assertNoRemovedLifecycleToolNames } from "./tool-configuration.js";

describe("configuration tool names", () => {
  it("reports removed lifecycle tools without rejecting dynamic plugin names", () => {
    expect(() => assertNoRemovedLifecycleToolNames(
      ["DynamicPluginTool", "TaskWait", "terminal_send", "TaskUpdate"],
      "configuration.allowedTools",
    )).toThrow(
      'configuration.allowedTools contains removed lifecycle tool names: "TaskWait" -> "JobWait", "terminal_send" -> "JobSend", "TaskUpdate" (remove it; no Job equivalent). Compatibility aliases are not supported.',
    );
    expect(() => assertNoRemovedLifecycleToolNames(
      ["DynamicPluginTool"],
      "configuration.allowedTools",
    )).not.toThrow();
  });
});
