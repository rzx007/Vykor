export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export function isJsonObject(
  value: unknown,
): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Reject the whole payload; no data or identifiers are truncated. */
export function isJsonRecord(
  value: unknown,
  byteLimit: number,
): value is Record<string, JsonValue> {
  return validateJsonRecord(value, byteLimit).valid;
}

/** Stable failure reasons for request boundaries; serialization and byte counting happen once. */
export function validateJsonRecord(
  value: unknown,
  byteLimit: number,
):
  | { valid: true; value: Record<string, JsonValue> }
  | { valid: false; reason: "invalid_json" | "payload_too_large" } {
  if (!isJsonObject(value)) return { valid: false, reason: "invalid_json" };
  try {
    if (
      new TextEncoder().encode(stringifyCanonicalJson(value)).byteLength >
      byteLimit
    ) {
      return { valid: false, reason: "payload_too_large" };
    }
    return { valid: true, value: value as Record<string, JsonValue> };
  } catch {
    return { valid: false, reason: "invalid_json" };
  }
}

/** JSON with deterministic object-key order, including numeric and literal prototype keys. */
export function stringifyCanonicalJson(value: unknown): string {
  const render = (item: unknown, depth: number): string => {
    if (
      item === null ||
      typeof item === "string" ||
      typeof item === "boolean"
    ) {
      return JSON.stringify(item);
    }
    if (typeof item === "number" && Number.isFinite(item))
      return JSON.stringify(item);
    if (typeof item !== "object" || item === null)
      throw new Error("Finite requires JSON data");
    if (depth >= 20)
      throw new Error("Finite JSON nesting limit exceeded");
    if (Array.isArray(item)) {
      return `[${Array.from(item, (child) => render(child, depth + 1)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(item);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("Finite requires plain JSON objects");
    }
    const record = item as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${render(record[key], depth + 1)}`)
      .join(",")}}`;
  };
  return render(value, 0);
}

export class JsonCopyError extends Error {
  constructor(readonly reason: "invalid_limit" | "too_large" | "invalid_json") {
    super(reason);
    this.name = "JsonCopyError";
  }
}

/** Copy finite, plain JSON without invoking accessors/toJSON or retaining input aliases. */
export function copyBoundedJson(value: unknown, options: { maxBytes: number; maxDepth: number }): JsonValue {
  const { maxBytes, maxDepth } = options;
  const ancestors = new Set<object>();
  let budget = maxBytes;
  const spend = (text: string): void => {
    budget -= new TextEncoder().encode(text).byteLength;
    if (budget < 0) throw new JsonCopyError("too_large");
  };
  const copy = (item: unknown, depth: number): JsonValue => {
    if (item === null || typeof item === "boolean" || typeof item === "string" || (typeof item === "number" && Number.isFinite(item))) {
      spend(JSON.stringify(item)); return item;
    }
    if (typeof item !== "object" || item === null || depth >= maxDepth || ancestors.has(item)) throw new JsonCopyError("invalid_json");
    const array = Array.isArray(item);
    if (!array && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new JsonCopyError("invalid_json");
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (Object.getOwnPropertySymbols(item).length || Object.values(descriptors).some(descriptor => descriptor.get || descriptor.set)) throw new JsonCopyError("invalid_json");
    ancestors.add(item); spend(array ? "[]" : "{}");
    try {
      if (array) {
        const result: JsonValue[] = [];
        if (Object.keys(item).length !== item.length) throw new JsonCopyError("invalid_json");
        for (let index = 0; index < item.length; index++) {
          if (index) spend(","); result.push(copy(descriptors[index]!.value, depth + 1));
        }
        return result;
      }
      const result: Record<string, JsonValue> = {};
      let count = 0;
      for (const key of Object.keys(item).sort()) {
        if (count++) spend(","); spend(`${JSON.stringify(key)}:`);
        Object.defineProperty(result, key, { value: copy(descriptors[key]!.value, depth + 1), enumerable: true, writable: true, configurable: true });
      }
      return result;
    } finally { ancestors.delete(item); }
  };
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || !Number.isSafeInteger(maxDepth) || maxDepth < 0) throw new JsonCopyError("invalid_limit");
  return copy(value, 0);
}
