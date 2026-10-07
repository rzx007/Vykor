import { describe, expect, it } from "vitest";
import { mergeAgentEnvironmentSettings, parseAgentEnvironmentSettings } from "./agent-environment-settings.js";

describe("runtime variable scope", () => {
  it("lets project ordinary values replace inherited secret references", () => {
    expect(mergeAgentEnvironmentSettings(
      { kind: "native", env: { KEEP: "yes" }, secretEnv: ["TENANT_ID"] },
      { kind: "native", env: { TENANT_ID: "project" } },
    )).toEqual({ kind: "native", env: { KEEP: "yes", TENANT_ID: "project" } });
  });
  it("lets project secrets replace inherited ordinary values without exposing them", () => {
    expect(mergeAgentEnvironmentSettings(
      { kind: "native", env: { TENANT_ID: "global", KEEP: "yes" } },
      { kind: "wsl", secretEnv: ["TENANT_ID"] },
      { kind: "native" },
    )).toEqual({ kind: "native", env: { KEEP: "yes" }, secretEnv: ["TENANT_ID"] });
  });
  it("preserves legal names that coincide with object properties", () => {
    const env = JSON.parse('{"__proto__":"value","constructor":"value2"}');
    const effective = mergeAgentEnvironmentSettings({ kind: "native", env });
    expect(Object.keys(effective.env!)).toEqual(["__proto__", "constructor"]);
    expect(effective.env!.__proto__).toBe("value");
  });
  it("rejects ambiguous secrecy and shell commands masquerading as arguments", () => {
    expect(() => parseAgentEnvironmentSettings({ kind: "native", env: { NAME: "value" }, secretEnv: ["NAME"] })).toThrow(/同时/);
    expect(() => parseAgentEnvironmentSettings({ kind: "native", shell: { executable: "sh", args: "-c ls" } })).toThrow(/参数/);
  });
});
