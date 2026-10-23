import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateNativePlugin } from "../../manifest/validate.js";
import { loadNativeSkills } from "../skills.js";

const fixture = fileURLToPath(new URL("../../../fixtures/native-v1/minimal-skill", import.meta.url));

describe("loadNativeSkills", () => {
  it("loads only declared skills and namespaces their command identity with manifest name", async () => {
    const validation = await validateNativePlugin(fixture);
    expect(validation.status).toBe("valid");
    const result = await loadNativeSkills(validation.plugin!);
    expect(result.status).toBe("loaded");
    expect(result.value?.map((skill) => skill.commandName)).toEqual(["minimal-skill:review"]);
    expect(result.value?.[0]?.source).toBe("plugin");
  });
});
