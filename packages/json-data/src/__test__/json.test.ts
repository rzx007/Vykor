import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { copyBoundedJson, isJsonObject, isJsonRecord, JsonCopyError, stringifyCanonicalJson, validateJsonRecord } from "../json.js";

const nested = (depth: number, array = true): unknown => {
  let value: unknown = 0;
  for (let index = 0; index < depth; index++) value = array ? [value] : { value };
  return value;
};

describe("canonical JSON", () => {
  it.each([
    {
      name: "numeric-prototype-utf8",
      input: '{"z":"测试","2":2,"10":10,"__proto__":{"safe":true}}',
      canonical: '{"10":10,"2":2,"__proto__":{"safe":true},"z":"测试"}',
      bytes: 54,
      sha256: "8b91623f38c34f4e34c97ffa5d9ecb99e1923fc6bc9ef709bc49d4cc093e12f9",
    },
    {
      name: "finite-arrays",
      input: '{"b":[true,null,-0,1.25],"a":{}}',
      canonical: '{"a":{},"b":[true,null,0,1.25]}',
      bytes: 31,
      sha256: "7cbcc2b0d40e6ca906282b512582de4126985d91e0ffb9592b9bf15f788aeb2b",
    },
    {
      name: "empty",
      input: "{}",
      canonical: "{}",
      bytes: 2,
      sha256: "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
    },
  ])("preserves fixed bytes and fingerprint: $name", ({ input, canonical, bytes, sha256 }) => {
    const value = JSON.parse(input);
    expect(stringifyCanonicalJson(value)).toBe(canonical);
    expect(new TextEncoder().encode(canonical).byteLength).toBe(bytes);
    expect(createHash("sha256").update(canonical).digest("hex")).toBe(sha256);
    expect(validateJsonRecord(value, bytes)).toEqual({ valid: true, value });
    expect(validateJsonRecord(value, bytes - 1)).toEqual({ valid: false, reason: "payload_too_large" });
    expect(isJsonRecord(value, bytes)).toBe(true);
    expect(stringifyCanonicalJson(value)).toBe(canonical);
  });

  it.each([true, false])("keeps the depth >= 20 container boundary for arrays=%s", array => {
    expect(() => stringifyCanonicalJson(nested(20, array))).not.toThrow();
    expect(() => stringifyCanonicalJson(nested(21, array))).toThrow("Finite JSON nesting limit exceeded");
  });

  it("rejects non-finite, circular and non-JSON data", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    for (const value of [NaN, Infinity, -Infinity, undefined, () => {}, 1n, Symbol(), new Date(), circular, Object.create({ inherited: true })]) {
      expect(() => stringifyCanonicalJson({ value })).toThrow();
      expect(validateJsonRecord({ value }, 1024)).toEqual({ valid: false, reason: "invalid_json" });
    }
  });

  it("accepts ordinary and null prototypes while preserving literal prototype keys", () => {
    const value = Object.assign(Object.create(null), JSON.parse('{"__proto__":{"safe":true},"constructor":1,"value":"测试"}'));
    expect(isJsonObject(value)).toBe(true);
    expect(stringifyCanonicalJson(value)).toBe('{"__proto__":{"safe":true},"constructor":1,"value":"测试"}');
    expect(isJsonObject({})).toBe(true);
    for (const invalid of [null, [], new Date(), Object.create({}), "text", 1]) {
      expect(isJsonObject(invalid)).toBe(false);
      expect(validateJsonRecord(invalid, 1024)).toEqual({ valid: false, reason: "invalid_json" });
    }
  });

  it("keeps accessor and non-enumerable handling of canonical serialization", () => {
    const value = Object.defineProperties({}, {
      visible: { enumerable: true, get: () => "read" },
      hidden: { value: "ignored" },
      [Symbol("ignored")]: { value: "ignored", enumerable: true },
    });
    expect(stringifyCanonicalJson(value)).toBe('{"visible":"read"}');
  });
});

describe("bounded JSON copies", () => {
  const copy = (value: unknown, maxBytes = 1024, maxDepth = 32) => copyBoundedJson(value, { maxBytes, maxDepth });
  const failure = (value: unknown, maxBytes = 1024, maxDepth = 32) => {
    try { copy(value, maxBytes, maxDepth); } catch (error) {
      expect(error).toBeInstanceOf(JsonCopyError);
      return (error as JsonCopyError).reason;
    }
    throw new Error("Expected JSON rejection");
  };

  it("copies without retaining aliases, preserves prototype keys and permits repeated references", () => {
    const shared = { answer: 42 };
    const value = Object.assign(Object.create(null), JSON.parse('{"__proto__":{"safe":true},"2":2,"10":10}'), { b: shared, a: shared });
    const result = copy(value) as Record<string, unknown>;
    expect(result).toEqual(value);
    expect(result).not.toBe(value);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.hasOwn(result, "__proto__")).toBe(true);
    expect(result.a).not.toBe(shared);
    expect(result.a).not.toBe(result.b);
    expect(Object.keys(result)).toEqual(["2", "10", "__proto__", "a", "b"]);
  });

  it.each([true, false])("keeps the configured depth >= 32 container boundary for arrays=%s", array => {
    expect(() => copy(nested(32, array))).not.toThrow();
    expect(failure(nested(33, array))).toBe("invalid_json");
    expect(() => copy(nested(20, array), 1024, 20)).not.toThrow();
    expect(failure(nested(21, array), 1024, 20)).toBe("invalid_json");
  });

  it("counts UTF-8 JSON bytes including punctuation and escaping exactly", () => {
    const value = { value: "测试\n\"" };
    expect(() => copy(value, 22)).not.toThrow();
    expect(failure(value, 21)).toBe("too_large");
    expect(() => copy(null, 4)).not.toThrow();
    expect(failure(null, 3)).toBe("too_large");
    expect(failure({}, 0)).toBe("too_large");
  });

  it("rejects getters, setters and toJSON without invoking them", () => {
    let called = false;
    const getter = Object.defineProperty({}, "value", { enumerable: true, get() { called = true; return 1; } });
    const setter = Object.defineProperty({}, "value", { set(_value: unknown) { called = true; } });
    const toJSON = { toJSON() { called = true; return {}; } };
    for (const value of [getter, setter, toJSON]) expect(failure(value)).toBe("invalid_json");
    expect(called).toBe(false);
  });

  it("rejects symbols, sparse arrays, extra array keys, cycles and unsupported values", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const extra = Object.assign([1], { extra: true });
    for (const value of [{ [Symbol()]: true }, Array(1), extra, circular, new Date(), Object.create({}), NaN, Infinity, undefined, 1n, () => {}]) {
      expect(failure(value)).toBe("invalid_json");
    }
  });

  it("validates explicit byte and depth limits without business defaults", () => {
    for (const limit of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(failure(null, limit)).toBe("invalid_limit");
      expect(failure(null, 1024, limit)).toBe("invalid_limit");
    }
    expect(copy(null, 4, 0)).toBeNull();
    expect(failure({}, 1024, 0)).toBe("invalid_json");
  });
});
