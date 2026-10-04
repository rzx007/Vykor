import { describe, expect, it } from "vitest";
import { stringifyPluginUiJson } from "./index.js";

describe("stringifyPluginUiJson", () => {
  it("sorts object keys recursively while preserving array order", () => {
    expect(stringifyPluginUiJson({ z: [{ b: 2, a: 1 }, false], a: null }))
      .toBe('{"a":null,"z":[{"a":1,"b":2},false]}');
    expect(stringifyPluginUiJson(JSON.parse('{"2":2,"10":10}')))
      .toBe('{"10":10,"2":2}');
  });

  it("preserves empty containers and literal special property names", () => {
    expect(stringifyPluginUiJson({ list: [], record: {} })).toBe('{"list":[],"record":{}}');
    expect(stringifyPluginUiJson(JSON.parse('{"__proto__":{"safe":true},"constructor":1}')))
      .toBe('{"__proto__":{"safe":true},"constructor":1}');
  });

  it.each([NaN, Infinity, -Infinity, undefined, 1n, new Date(), () => 1, Symbol("ui")])
    ("rejects non-JSON values: %s", value => {
      expect(() => stringifyPluginUiJson(value)).toThrow();
    });

  it("rejects nested undefined and sparse arrays instead of dropping values", () => {
    expect(() => stringifyPluginUiJson({ value: undefined })).toThrow();
    expect(() => stringifyPluginUiJson(new Array(2))).toThrow();
  });

  it("accepts twenty containers and rejects deeper or cyclic data", () => {
    let value: unknown = null;
    for (let i = 0; i < 20; i++) value = { nested: value };
    expect(() => stringifyPluginUiJson(value)).not.toThrow();
    expect(() => stringifyPluginUiJson({ nested: value })).toThrow();
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => stringifyPluginUiJson(cycle)).toThrow();
  });
});
