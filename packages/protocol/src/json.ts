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

export function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

export function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
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
