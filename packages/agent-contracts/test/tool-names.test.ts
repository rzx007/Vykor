import { describe, expect, it } from "vitest";
import {
  canonicalToolName,
  canonicalToolNames,
  normalizeToolName,
  normalizeToolNames,
  resolveAllowedToolNames,
} from "../src/index.js";

describe("shell tool name migration", () => {
  it("canonicalizes Bash references without registering an alias", () => {
    expect(canonicalToolName("Bash")).toBe("Shell");
    expect(canonicalToolName("Read")).toBe("Read");
    expect(canonicalToolNames(["Read", "Bash", "Shell"])).toEqual(["Read", "Shell"]);
  });
});

describe("tool name normalization", () => {
  it("keeps tool names exact", () => {
    expect(normalizeToolNames(["Agent", "JobList", "Edit"]))
      .toEqual(["Agent", "JobList", "Edit"]);
  });

  it("does not repair case and preserves dynamic names", () => {
    expect(normalizeToolName("mcp__Github__Search", ["mcp__github__search"]))
      .toBe("mcp__Github__Search");
    expect(normalizeToolName("CustomPluginTool", ["Bash", "Read"]))
      .toBe("CustomPluginTool");
  });

  it("deduplicates normalized names and treats '*' as an unrestricted allowlist", () => {
    expect(normalizeToolNames(["Bash", "Bash", "Edit", "Edit"]))
      .toEqual(["Shell", "Edit"]);
    expect(resolveAllowedToolNames(["JobWait", "*", "Read"]))
      .toEqual([]);
  });

  it("does not translate removed Task control aliases", () => {
    expect(normalizeToolNames(["task_wait", "task_output", "send_message"]))
      .toEqual(["task_wait", "task_output", "send_message"]);
  });

});
