import { describe, expect, it } from "vitest";
import { ConverterRegistry } from "../registry.js";
import type { PluginConverter } from "../converter.js";
const converter = (id: string, confidence: number): PluginConverter => ({ id, version: "1", sourceFormat: id,
  async detect() { return { converterId: id, confidence, evidence: [id] }; },
  async inspect() { throw new Error(); }, async plan() { throw new Error(); }, async convert() { throw new Error(); } });
describe("ConverterRegistry", () => {
  it("selects one best match and rejects tied ambiguity", async () => {
    const registry = new ConverterRegistry(); registry.register(converter("a", .9)); registry.register(converter("b", .5));
    expect((await registry.detect("x")).converter.id).toBe("a");
    const tied = new ConverterRegistry(); tied.register(converter("a", .9)); tied.register(converter("b", .9));
    await expect(tied.detect("x")).rejects.toThrow("Ambiguous");
  });
});
