import { describe, expect, it } from "vitest";

import { buildSettingsPatch, coerceConfigValue } from "./config-coerce.js";

describe("config coerce helpers", () => {
  it("accepts only supported agent execution environments", () => {
    expect(coerceConfigValue("agentEnvironment.kind", "native")).toBe("native");
    expect(coerceConfigValue("agentEnvironment.kind", "wsl")).toBe("wsl");
    expect(coerceConfigValue("agentEnvironment.kind", "docker")).toBeUndefined();
  });
  it("coerces booleans and nested memory keys", () => {
    expect(coerceConfigValue("fastMode", "on")).toBe(true);
    expect(coerceConfigValue("memory.enabled", "false")).toBe(false);
    expect(coerceConfigValue("daemon.autoStart", "on")).toBe(true);
    expect(coerceConfigValue("plugins.enabled", "off")).toBe(false);
    expect(coerceConfigValue("permission.mode", "plan")).toBe("plan");
    expect(coerceConfigValue("permission.mode", "nope")).toBeUndefined();
  });

  it("builds nested settings patches", () => {
    expect(buildSettingsPatch({ memory: { enabled: true } }, "memory.enabled", false)).toEqual({
      memory: { enabled: false },
    });
    expect(buildSettingsPatch({}, "model", "gpt-x")).toEqual({ model: "gpt-x" });
    expect(buildSettingsPatch({ plugins: { enabled: true } }, "plugins.enabled", false)).toEqual({
      plugins: { enabled: false },
    });
  });
});
