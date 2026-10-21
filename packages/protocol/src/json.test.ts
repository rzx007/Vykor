import { expect, it } from "vitest";
import { stringifyCanonicalJson, validateJsonRecord } from "./json.js";
it("canonicalizes finite JSON without mutating or losing numeric/prototype keys", () => {
  expect(stringifyCanonicalJson(JSON.parse('{"2":2,"10":10,"__proto__":{"safe":true}}'))).toBe('{"10":10,"2":2,"__proto__":{"safe":true}}');
  for (const value of [NaN, Infinity, undefined, () => {}, new Date()]) expect(() => stringifyCanonicalJson({ value })).toThrow();
  const circular: Record<string, unknown> = {}; circular.self = circular;
  expect(() => stringifyCanonicalJson(circular)).toThrow();
  expect(validateJsonRecord({ value: "测试" }, 4)).toEqual({ valid: false, reason: "payload_too_large" });
});
