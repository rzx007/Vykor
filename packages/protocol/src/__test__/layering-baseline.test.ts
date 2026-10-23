import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { stringifyCanonicalJson, validateJsonRecord } from "../serialization/json.js";
import { copyPluginAppJson } from "../extensions/plugin-apps.js";
import { parseAdmitPromptRequest, parseCreateSessionRequest, ProtocolValidationError } from "../requests/requests.js";

const baseline = JSON.parse(readFileSync(new URL("../../../../docs/superpowers/reviews/2026-10-22-protocol-layering-baseline.json", import.meta.url), "utf8")) as {
  jsonSamples: Array<{ name: string; inputJson: string; canonical: string; utf8Bytes: number; sha256: string }>;
  validationErrors: Array<{ expected?: unknown; expectedField?: string }>;
};

describe("Protocol layering frozen behavior", () => {
  it.each(baseline.jsonSamples)("preserves canonical bytes and fingerprint: $name", sample => {
    const input = JSON.parse(sample.inputJson);
    const canonical = stringifyCanonicalJson(input);
    expect(canonical).toBe(sample.canonical);
    expect(new TextEncoder().encode(canonical).byteLength).toBe(sample.utf8Bytes);
    expect(createHash("sha256").update(canonical).digest("hex")).toBe(sample.sha256);
    expect(validateJsonRecord(input, sample.utf8Bytes).valid).toBe(true);
    expect(validateJsonRecord(input, sample.utf8Bytes - 1)).toEqual({ valid: false, reason: "payload_too_large" });
  });

  it("keeps canonical and plugin depth rules separate and rejects non-JSON values", () => {
    const nested = (depth: number): unknown => {
      let value: unknown = 0;
      for (let index = 0; index < depth; index++) value = [value];
      return value;
    };
    expect(() => stringifyCanonicalJson(nested(20))).not.toThrow();
    expect(() => stringifyCanonicalJson(nested(21))).toThrow();
    expect(() => copyPluginAppJson(nested(32), 1024)).not.toThrow();
    expect(() => copyPluginAppJson(nested(33), 1024)).toThrow("plugin_app_invalid_json");
    const circular: Record<string, unknown> = {}; circular.self = circular;
    for (const value of [NaN, Infinity, undefined, () => {}, circular]) {
      expect(validateJsonRecord({ value }, 1024)).toEqual({ valid: false, reason: "invalid_json" });
    }
    const plain = Object.assign(Object.create(null), { value: "测试" });
    expect(stringifyCanonicalJson(plain)).toBe('{"value":"测试"}');
  });

  it("preserves parser error code, field and optional reason envelope", () => {
    const errorOf = (run: () => unknown): ProtocolValidationError => {
      try { run(); } catch (error) {
        expect(error).toBeInstanceOf(ProtocolValidationError);
        return error as ProtocolValidationError;
      }
      throw new Error("Expected parser rejection");
    };
    expect(errorOf(() => parseCreateSessionRequest({ cwd: 7 })).toProtocolError()).toEqual(baseline.validationErrors[0].expected);
    const rejected = errorOf(() => parseAdmitPromptRequest({ content: "hello", metadata: { pluginAppSource: {} } }));
    expect(rejected.code).toBe("invalid_request");
    expect(rejected.details?.field).toBe(baseline.validationErrors[1].expectedField);
    expect(new ProtocolValidationError("too large", "args", "payload_too_large").toProtocolError()).toEqual(baseline.validationErrors[2].expected);
  });
});
