import { describe, expect, it } from "vitest";

import {
  classifyAttachmentCandidate,
  decodeAttachmentText,
} from "../attachment-text.js";

describe("classifyAttachmentCandidate", () => {
  it.each([
    ["photo.png", "image/png", "image"],
    ["notes.txt", "", "text"],
    ["README.md", "application/octet-stream", "text"],
    ["index.ts", "", "text"],
    ["payload.json", "application/json", "text"],
    ["report.pdf", "application/pdf", "document"],
    ["proposal.docx", "application/zip", "document"],
    ["table.xlsx", "application/octet-stream", "document"],
    ["slides.pptx", "", "document"],
    ["source.zip", "application/zip", "archive"],
    ["archive.tar.gz", "application/gzip", "archive"],
    ["program.exe", "application/octet-stream", "binary"],
  ] as const)("classifies %s as %s", (displayName, mediaType, expected) => {
    expect(classifyAttachmentCandidate({ displayName, mediaType })).toBe(expected);
  });

  it("does not let a text-looking name override a PDF signature media type", () => {
    expect(
      classifyAttachmentCandidate({
        displayName: "disguised.txt",
        mediaType: "application/pdf",
      }),
    ).toBe("document");
  });
});

describe("decodeAttachmentText", () => {
  it("strictly decodes supported Unicode encodings and normalizes newlines", () => {
    expect(decodeAttachmentText(new TextEncoder().encode("你好\r\nworld\r"))).toEqual({
      text: "你好\nworld\n",
      encoding: "utf-8",
    });
    expect(decodeAttachmentText(Uint8Array.from([0xef, 0xbb, 0xbf, 0x6f, 0x6b]))).toEqual({
      text: "ok",
      encoding: "utf-8",
    });
    expect(
      decodeAttachmentText(Uint8Array.from([0xff, 0xfe, 0x41, 0x00, 0x0a, 0x00])),
    ).toEqual({ text: "A\n", encoding: "utf-16le" });
    expect(
      decodeAttachmentText(Uint8Array.from([0xfe, 0xff, 0x00, 0x41, 0x00, 0x0a])),
    ).toEqual({ text: "A\n", encoding: "utf-16be" });
  });

  it.each([
    ["invalid UTF-8", Uint8Array.from([0xc3, 0x28])],
    ["NUL bytes", Uint8Array.from([0x61, 0x00, 0x62])],
    ["binary controls", Uint8Array.from([0x61, 0x01, 0x62])],
    ["UTF-16 without BOM", Uint8Array.from([0x41, 0x00, 0x42, 0x00])],
  ])("rejects %s", (_name, bytes) => {
    expect(() => decodeAttachmentText(bytes)).toThrow();
  });
});
