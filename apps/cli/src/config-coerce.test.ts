import { describe, expect, it } from "vitest";

import { buildSettingsPatch, coerceConfigValue } from "./config-coerce.js";

describe("config coerce helpers", () => {
  it("accepts concrete reply styles and rejects unknown or inheritance values", () => {
    for (const style of ["collaborative", "direct", "explanatory"]) expect(coerceConfigValue("replyStyle", style)).toBe(style);
    for (const style of ["inherit", "chatty", "", "Direct"]) expect(coerceConfigValue("replyStyle", style)).toBeUndefined();
  });
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
    expect(coerceConfigValue("permission.mode", "plan")).toBe("ask");
    expect(coerceConfigValue("permission.mode", "full_auto")).toBe("auto_review");
    for (const mode of ["ask", "auto_review", "full_access"]) {
      expect(coerceConfigValue("permission.mode", mode)).toBe(mode);
    }
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
