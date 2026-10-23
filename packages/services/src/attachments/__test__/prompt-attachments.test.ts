import { describe, expect, it } from "vitest";

import {
  normalizePromptAttachments,
  promptAttachmentFingerprint,
  uniqueReferencedBytes,
} from "../prompt-attachments.js";

describe("prompt attachment helpers", () => {
  it("normalizes intent without changing the requested order", () => {
    expect(
      normalizePromptAttachments([
        { assetId: "b", displayName: "renamed.png" },
        { assetId: "a", intent: "ocr" },
      ]),
    ).toEqual([
      { assetId: "b", intent: "auto", displayName: "renamed.png" },
      { assetId: "a", intent: "ocr" },
    ]);
  });

  it("rejects the same asset twice", () => {
    expect(() =>
      normalizePromptAttachments([
        { assetId: "a" },
        { assetId: "a", intent: "ocr" },
      ]),
    ).toThrow(/attachment_duplicate_reference/);
  });

  it("uses attachment order in the stable fingerprint", () => {
    const first = promptAttachmentFingerprint([
      { assetId: "b", intent: "auto", displayName: "b.png" },
      { assetId: "a", intent: "ocr", displayName: "a.png" },
    ]);
    const reversed = promptAttachmentFingerprint([
      { assetId: "a", intent: "ocr", displayName: "a.png" },
      { assetId: "b", intent: "auto", displayName: "b.png" },
    ]);
    expect(first).not.toEqual(reversed);
    expect(first).toEqual(
      promptAttachmentFingerprint([
        { assetId: "b", intent: "auto", displayName: "b.png" },
        { assetId: "a", intent: "ocr", displayName: "a.png" },
      ]),
    );
  });

  it("charges each asset once across existing and proposed references", () => {
    expect(
      uniqueReferencedBytes(
        [
          { assetId: "a", sizeBytes: 100 },
          { assetId: "a", sizeBytes: 100 },
        ],
        [
          { assetId: "a", sizeBytes: 100 },
          { assetId: "b", sizeBytes: 200 },
        ],
      ),
    ).toBe(300);
  });
});
