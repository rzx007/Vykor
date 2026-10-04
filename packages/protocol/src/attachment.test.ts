import { describe, expect, it } from "vitest";

import {
  DEFAULT_ATTACHMENT_LIMITS,
  parseAttachmentAssetRecord,
  parseAttachmentLimits,
} from "./attachment.js";

describe("attachment protocol", () => {
  it("retains validated chat sources when reading persistent attachments", () => {
    const sources = [
      { storage: "sqlite", sessionId: "main" },
      { storage: "memory", sessionId: "temporary", sourceSessionId: "main" },
    ];
    expect(parseAttachmentAssetRecord({
      id: "asset", displayName: "a.txt", status: "importing", createdAt: 1, updatedAt: 1,
      chatSources: sources,
    })).toHaveProperty("chatSources", sources);
    expect(() => parseAttachmentAssetRecord({
      id: "asset", displayName: "a.txt", status: "importing", createdAt: 1, updatedAt: 1,
      chatSources: [{ storage: "disk", sessionId: "temporary" }],
    })).toThrow("storage");
  });

  it("parses the documented default limits", () => {
    expect(parseAttachmentLimits(DEFAULT_ATTACHMENT_LIMITS)).toEqual({
      maxFilesPerPrompt: 20,
      maxBytesPerFile: 100 * 1024 * 1024,
      maxBytesPerPrompt: 250 * 1024 * 1024,
      maxSessionReferencedBytes: 2 * 1024 * 1024 * 1024,
      resumableThresholdBytes: 25 * 1024 * 1024,
      uploadSessionTtlMs: 24 * 60 * 60 * 1_000,
      stagingTtlMs: 24 * 60 * 60 * 1_000,
    });
  });

  it.each([
    ["missing field", { ...DEFAULT_ATTACHMENT_LIMITS, stagingTtlMs: undefined }, "stagingTtlMs"],
    ["negative value", { ...DEFAULT_ATTACHMENT_LIMITS, maxBytesPerFile: -1 }, "maxBytesPerFile"],
    ["fractional value", { ...DEFAULT_ATTACHMENT_LIMITS, maxFilesPerPrompt: 1.5 }, "maxFilesPerPrompt"],
    [
      "resumable threshold above the file limit",
      {
        ...DEFAULT_ATTACHMENT_LIMITS,
        resumableThresholdBytes: DEFAULT_ATTACHMENT_LIMITS.maxBytesPerFile + 1,
      },
      "resumableThresholdBytes",
    ],
  ])("rejects %s", (_label, value, field) => {
    expect(() => parseAttachmentLimits(value)).toThrow(field);
  });

  it("parses a ready attachment without leaking storage details", () => {
    const record = parseAttachmentAssetRecord({
      id: "att_1",
      displayName: "截图.png",
      declaredMediaType: "image/png",
      mediaType: "image/png",
      sizeBytes: 8,
      sha256: "a".repeat(64),
      status: "ready",
      createdAt: 10,
      updatedAt: 11,
      storageKey: "blobs/aa/secret",
      stagingName: "att_1.part",
    });

    expect(record).toEqual({
      id: "att_1",
      displayName: "截图.png",
      declaredMediaType: "image/png",
      mediaType: "image/png",
      sizeBytes: 8,
      sha256: "a".repeat(64),
      status: "ready",
      createdAt: 10,
      updatedAt: 11,
    });
    expect(record).not.toHaveProperty("storageKey");
    expect(record).not.toHaveProperty("stagingName");
  });

  it.each([
    ["sha256", { sha256: undefined }],
    ["sha256", { sha256: "not-a-sha" }],
    ["sizeBytes", { sizeBytes: -1 }],
    ["mediaType", { mediaType: undefined }],
  ])("rejects a ready attachment with invalid %s", (field, patch) => {
    expect(() =>
      parseAttachmentAssetRecord({
        id: "att_1",
        displayName: "a.png",
        mediaType: "image/png",
        sizeBytes: 8,
        sha256: "b".repeat(64),
        status: "ready",
        createdAt: 10,
        updatedAt: 11,
        ...patch,
      }),
    ).toThrow(field);
  });
});
