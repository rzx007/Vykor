import { describe, expect, it } from "vitest";
import { needsReconversion, type ConversionBehaviorIdentity } from "../reconversion.js";
const base: ConversionBehaviorIdentity = { sourceDigest: "a", converterVersion: "1", targetSchemaVersion: 1, optionsDigest: "b", mappingVersion: "1" };
describe("needsReconversion", () => {
  it("reacts to every behavior input and ignores unrelated timestamps", () => {
    expect(needsReconversion(base, { ...base })).toBe(false);
    for (const [key, value] of [["sourceDigest", "x"], ["converterVersion", "2"], ["targetSchemaVersion", 2], ["optionsDigest", "x"], ["mappingVersion", "2"]] as const) {
      expect(needsReconversion(base, { ...base, [key]: value })).toBe(true);
    }
  });
});
