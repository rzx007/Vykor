import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateNativePlugin } from "../manifest/validate.js";
import { loadNativeAgents } from "./agents.js";

const fixture = fileURLToPath(new URL("../../fixtures/native-v1/agents-hooks-mcp", import.meta.url));

describe("loadNativeAgents", () => {
  it("uses stable plugin ID in agent identity", async () => {
    const validation = await validateNativePlugin(fixture);
    const result = await loadNativeAgents(validation.plugin!);
    expect(result.status).toBe("loaded");
    expect(result.value?.map((agent) => agent.name)).toEqual(["dev.vykor.full:reviewer"]);
  });
});
