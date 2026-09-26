import { describe, expect, it } from "vitest";

import {
  checkProtocolCompatibility,
  CURRENT_PROTOCOL_VERSION,
  parseServerCapabilities,
  supportsFeature,
} from "./capabilities.js";

describe("protocol capabilities", () => {
  const server = parseServerCapabilities({
    serverVersion: "0.4.0",
    protocol: { version: CURRENT_PROTOCOL_VERSION },
    features: { jobs: 2, workflow: 2 },
  });

  it("accepts only an exact protocol version", () => {
    expect(checkProtocolCompatibility(server, { version: CURRENT_PROTOCOL_VERSION })).toEqual({ compatible: true });
    expect(supportsFeature(server, "jobs", 2)).toBe(true);
    expect(supportsFeature(server, "backup", 1)).toBe(false);
  });

  it("rejects older and newer protocol versions", () => {
    expect(checkProtocolCompatibility(server, { version: 3 })).toMatchObject({ compatible: false });
    expect(checkProtocolCompatibility(server, { version: CURRENT_PROTOCOL_VERSION + 1 })).toMatchObject({ compatible: false });
  });

  it("rejects malformed feature versions", () => {
    expect(() => parseServerCapabilities({
      serverVersion: "x",
      protocol: { version: 2 },
      features: { jobs: 0 },
    })).toThrow("features.jobs");
  });

  it("allows current servers without attachment support", () => {
    expect(server.attachments).toBeUndefined();
  });

  it("parses attachment transfer capabilities", () => {
    const capabilities = parseServerCapabilities({
      serverVersion: "0.4.0",
      protocol: { version: 2 },
      features: { attachments: 1 },
      attachments: {
        limits: {
          maxFilesPerPrompt: 20,
          maxBytesPerFile: 104_857_600,
          maxBytesPerPrompt: 262_144_000,
          maxSessionReferencedBytes: 2_147_483_648,
          resumableThresholdBytes: 26_214_400,
          uploadSessionTtlMs: 86_400_000,
          stagingTtlMs: 86_400_000,
        },
        uploadModes: ["single"],
      },
    });

    expect(capabilities.attachments).toEqual({
      limits: expect.objectContaining({ maxBytesPerFile: 104_857_600 }),
      uploadModes: ["single"],
    });
  });

  it("rejects malformed attachment limits and upload modes", () => {
    const base = {
      serverVersion: "0.4.0",
      protocol: { version: 2 },
      features: { attachments: 1 },
      attachments: {
        limits: {
          maxFilesPerPrompt: 20,
          maxBytesPerFile: 104_857_600,
          maxBytesPerPrompt: 262_144_000,
          maxSessionReferencedBytes: 2_147_483_648,
          resumableThresholdBytes: 26_214_400,
          uploadSessionTtlMs: 86_400_000,
          stagingTtlMs: 86_400_000,
        },
        uploadModes: ["single"],
      },
    };

    expect(() =>
      parseServerCapabilities({
        ...base,
        attachments: {
          ...base.attachments,
          limits: { ...base.attachments.limits, maxBytesPerFile: 0 },
        },
      }),
    ).toThrow("maxBytesPerFile");
    expect(() =>
      parseServerCapabilities({
        ...base,
        attachments: { ...base.attachments, uploadModes: ["multipart"] },
      }),
    ).toThrow("uploadModes");
    for (const uploadModes of [
      ["resumable"],
      ["resumable", "single"],
      ["single", "single"],
      ["single", "resumable", "single"],
    ]) {
      expect(() =>
        parseServerCapabilities({
          ...base,
          attachments: { ...base.attachments, uploadModes },
        }),
      ).toThrow("uploadModes");
    }
  });
});
