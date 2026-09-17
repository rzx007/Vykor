import { describe, expect, it } from "vitest";

import { decodeAttachmentFilename } from "../attachment-filename.js";
import { sniffAttachmentMediaType } from "../attachment-media-type.js";

describe("sniffAttachmentMediaType", () => {
  it.each([
    ["image/png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
    ["image/jpeg", [0xff, 0xd8, 0xff, 0xe0]],
    ["image/gif", Array.from(new TextEncoder().encode("GIF89a"))],
    [
      "image/webp",
      [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50],
    ],
    ["application/pdf", Array.from(new TextEncoder().encode("%PDF-1.7"))],
    ["application/zip", [0x50, 0x4b, 0x03, 0x04]],
  ])("detects %s from magic bytes", (mediaType, bytes) => {
    expect(sniffAttachmentMediaType(Uint8Array.from(bytes))).toBe(mediaType);
  });

  it("prefers detected bytes over a forged declared media type", () => {
    expect(
      sniffAttachmentMediaType(
        new TextEncoder().encode("%PDF-1.7"),
        "image/png",
      ),
    ).toBe("application/pdf");
  });

  it("keeps a normalized text media type only for valid UTF-8 without NUL", () => {
    expect(
      sniffAttachmentMediaType(
        new TextEncoder().encode("hello, 世界"),
        "Text/Plain; charset=UTF-8",
      ),
    ).toBe("text/plain");
    expect(
      sniffAttachmentMediaType(
        Uint8Array.from([0x68, 0x69, 0x00]),
        "text/plain",
      ),
    ).toBe("application/octet-stream");
    expect(
      sniffAttachmentMediaType(Uint8Array.from([0xc3, 0x28]), "text/plain"),
    ).toBe("application/octet-stream");
  });

  it("accepts a truncated inspection prefix ending inside a valid UTF-8 character", () => {
    const prefix = new Uint8Array(4_100);
    prefix.fill(0x61);
    prefix[4_099] = 0xe4;

    expect(sniffAttachmentMediaType(prefix, "text/plain", false)).toBe(
      "text/plain",
    );
    expect(sniffAttachmentMediaType(prefix, "text/plain", true)).toBe(
      "application/octet-stream",
    );
  });

  it("still rejects malformed UTF-8 before the end of a truncated prefix", () => {
    expect(
      sniffAttachmentMediaType(
        Uint8Array.from([0x61, 0xc3, 0x28, 0x62]),
        "text/plain",
        false,
      ),
    ).toBe("application/octet-stream");
  });

  it("uses application/octet-stream for empty or unknown content", () => {
    expect(sniffAttachmentMediaType(new Uint8Array(), "text/plain")).toBe(
      "application/octet-stream",
    );
    expect(
      sniffAttachmentMediaType(Uint8Array.from([1, 2, 3]), "image/png"),
    ).toBe("application/octet-stream");
  });
});

describe("decodeAttachmentFilename", () => {
  it("decodes and NFC-normalizes a URI encoded Unicode filename", () => {
    expect(decodeAttachmentFilename("%E6%88%AA%E5%9B%BE.png")).toBe(
      "截图.png",
    );
    expect(decodeAttachmentFilename(encodeURIComponent("cafe\u0301.txt"))).toBe(
      "café.txt",
    );
  });

  it("drops path components and control characters", () => {
    expect(decodeAttachmentFilename(encodeURIComponent("../a\u0000.png"))).toBe(
      "a.png",
    );
    expect(
      decodeAttachmentFilename(encodeURIComponent("C:\\secret\\report.txt")),
    ).toBe("report.txt");
  });

  it.each([
    ["malformed URI encoding", "%E0%A4%A"],
    ["an empty safe name", encodeURIComponent("../\u0000\u0001")],
    ["more than 255 code points", encodeURIComponent(`${"a".repeat(256)}.txt`)],
  ])("rejects %s", (_label, value) => {
    expect(() => decodeAttachmentFilename(value)).toThrow(
      "attachment_invalid_request",
    );
  });
});
