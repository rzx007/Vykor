import { describe, expect, it } from "vitest";

import { getBuiltinAgentDefinitions } from "./agent-definitions.js";

describe("builtin review role", () => {
  it("exposes a strictly read-only review role", () => {
    const review = getBuiltinAgentDefinitions().find((agent) => agent.name === "review");

    expect(review).toBeDefined();
    expect(review!.tools).toEqual(["Read", "Grep", "Glob"]);
    for (const denied of ["Shell", "Write", "Edit", "Agent"]) {
      expect(review!.disallowedTools).toContain(denied);
    }
    expect(review!.systemPrompt?.toLowerCase()).toContain("evidence");
  });

  it("keeps verification as the implementation verifier", () => {
    const verification = getBuiltinAgentDefinitions().find((agent) => agent.name === "verification");

    expect(verification).toBeDefined();
    expect(verification!.disallowedTools).not.toContain("Shell");
    expect(verification!.systemPrompt).toContain("VERDICT");
  });
});
