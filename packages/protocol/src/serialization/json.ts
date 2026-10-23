export type { JsonValue } from "@vykor/json-data/json";
export { isJsonObject, isJsonRecord, validateJsonRecord, stringifyCanonicalJson } from "@vykor/json-data/json";

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
