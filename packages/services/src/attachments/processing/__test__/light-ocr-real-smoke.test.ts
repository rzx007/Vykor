import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { LightOcrEngine } from "../light-ocr-engine.js";

describe("light-ocr real runtime smoke", () => {
  it("recognizes locally rendered text with geometry and confidence", async () => {
    const image = await sharp(Buffer.from(`
      <svg width="1200" height="260" xmlns="http://www.w3.org/2000/svg">
        <rect width="100%" height="100%" fill="white"/>
        <text x="50" y="170" font-family="Arial, sans-serif" font-size="112" fill="black">OPENHARNESS 2026</text>
      </svg>
    `)).png().toBuffer();
    const engine = new LightOcrEngine();
    try {
      const result = await engine.recognize(image, { applyExif: true });
      expect(result.lines.length).toBeGreaterThan(0);
      expect(result.lines.map((line) => line.text).join(" ").toUpperCase()).toContain("OPENHARNESS");
      expect(result.lines[0]).toEqual(expect.objectContaining({
        confidence: expect.any(Number),
        box: expect.any(Array),
      }));
    } finally {
      await engine.close();
    }
  }, 30_000);
});
