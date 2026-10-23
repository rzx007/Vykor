import { describe, expect, it } from "vitest";
import { getSandboxAvailability, normalizeSandboxConfig } from "../index.js";

describe("local SRT sandbox", () => {
  it("normalizes an SRT-only configuration", () => {
    expect(normalizeSandboxConfig({ enabled: true })).toMatchObject({ enabled: true, backend: "srt", srt: { runtimeCommand: "srt" } });
  });
  it("reports disabled without probing a container runtime", () => {
    expect(getSandboxAvailability({ enabled: false })).toMatchObject({ enabled: false, backend: "srt" });
  });
});
