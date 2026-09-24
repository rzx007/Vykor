import { describe, expect, it } from "vitest";

import {
  BUILTIN_SESSION_COMMANDS,
  mergeCommandCatalog,
  normalizeCommandName,
  parseSlashLine,
} from "../commands.js";

describe("command catalog helpers", () => {
  it("normalizes and parses slash lines", () => {
    expect(normalizeCommandName("models")).toBe("/models");
    expect(normalizeCommandName("/commit")).toBe("/commit");
    expect(parseSlashLine("/commit fix parser")).toEqual({
      name: "/commit",
      args: "fix parser",
    });
    expect(parseSlashLine("not-a-command")).toBeNull();
  });

  it("merges builtins with extras while keeping builtin precedence", () => {
    const merged = mergeCommandCatalog([
      { name: "commit", description: "Commit skill", kind: "template", source: "user" },
      { name: "/skills", description: "hijack", kind: "template", source: "user" },
    ]);
    expect(merged.find((entry) => entry.name === "/skills")).toEqual(
      BUILTIN_SESSION_COMMANDS.find((entry) => entry.name === "/skills"),
    );
    expect(merged.find((entry) => entry.name === "/commit")).toEqual(
      BUILTIN_SESSION_COMMANDS.find((entry) => entry.name === "/commit"),
    );
    expect(merged.map((entry) => entry.name)).toContain("/skills");
  });

  it("advertises usage in /context argumentHint", () => {
    const context = BUILTIN_SESSION_COMMANDS.find((entry) => entry.name === "/context");
    expect(context?.argumentHint).toBe("[preview|status|usage]");
  });

  it("advertises /facts separately from semantic /memory", () => {
    const facts = BUILTIN_SESSION_COMMANDS.find((entry) => entry.name === "/facts");
    expect(facts?.argumentHint).toBe("[list|replace OLD_KEY => NEW_VALUE]");
    expect(facts?.description).toContain("environment facts");
  });
});
