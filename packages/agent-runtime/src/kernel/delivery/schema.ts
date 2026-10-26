const kinds = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const keys = new Set(["type", "properties", "required", "additionalProperties", "items", "enum", "const", "minimum", "maximum", "minLength", "maxLength", "title", "description"]);

export function assertJsonData(value: unknown, seen = new Set<object>(), depth = 0): void {
  if (depth > 32) throw new Error("JSON data is too deeply nested");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (!value || typeof value !== "object" || seen.has(value)) throw new Error("Value must be finite JSON data");
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    throw new Error("Value must use plain JSON objects");
  seen.add(value);
  const entries = Object.getOwnPropertyDescriptors(value);
  if (Object.getOwnPropertySymbols(value).length) throw new Error("JSON data cannot contain symbols");
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) throw new Error("JSON arrays must be dense and contain only indices");
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index)) throw new Error("JSON arrays must be dense and contain only indices");
    }
  }
  for (const [key, descriptor] of Object.entries(entries)) {
    if (Array.isArray(value) && key === "length") continue;
    if (!descriptor.enumerable || !("value" in descriptor)) throw new Error("JSON data cannot contain accessors");
    assertJsonData(descriptor.value, seen, depth + 1);
  }
  seen.delete(value);
}

/** Closed subset supported by the existing tool validator; unsupported assertions fail at setup. */
export function assertSupportedOutputSchema(schema: unknown): asserts schema is Record<string, unknown> {
  assertJsonData(schema);
  let nodes = 0;
  const visit = (node: unknown, depth: number): void => {
    if (++nodes > 512 || depth > 16 || !node || typeof node !== "object" || Array.isArray(node))
      throw new Error("Output schema must be a bounded object schema");
    const data = node as Record<string, unknown>;
    for (const key of Object.keys(data)) if (!keys.has(key)) throw new Error(`Unsupported output schema constraint: ${key}`);
    if (data.type !== undefined) {
      const types = Array.isArray(data.type) ? data.type : [data.type];
      if (!types.length || types.some(type => typeof type !== "string" || !kinds.has(type))) throw new Error("Invalid output schema type");
    }
    if (data.properties !== undefined) {
      if (!data.properties || typeof data.properties !== "object" || Array.isArray(data.properties)) throw new Error("Output schema properties must be an object");
      for (const child of Object.values(data.properties)) visit(child, depth + 1);
    }
    if (data.items !== undefined) visit(data.items, depth + 1);
    if (data.required !== undefined && (!Array.isArray(data.required) || data.required.some(key => typeof key !== "string")))
      throw new Error("Output schema required must contain property names");
    if (data.additionalProperties !== undefined && typeof data.additionalProperties !== "boolean") throw new Error("Output schema additionalProperties must be boolean");
    for (const key of ["minimum", "maximum", "minLength", "maxLength"]) {
      if (data[key] !== undefined && (typeof data[key] !== "number" || !Number.isFinite(data[key]))) throw new Error(`Invalid output schema ${key}`);
      if (["minLength", "maxLength"].includes(key) && data[key] !== undefined && (!Number.isSafeInteger(data[key]) || (data[key] as number) < 0)) throw new Error(`Invalid output schema ${key}`);
    }
    for (const key of ["title", "description"]) if (data[key] !== undefined && typeof data[key] !== "string") throw new Error(`Invalid output schema ${key}`);
    const primitive = (value: unknown) => value === null || ["string", "boolean", "number"].includes(typeof value);
    if (data.enum !== undefined && (!Array.isArray(data.enum) || !data.enum.length || !data.enum.every(primitive))) throw new Error("Output schema enum supports primitive values");
    if (Object.hasOwn(data, "const") && !primitive(data.const)) throw new Error("Output schema const supports primitive values");
  };
  visit(schema, 0);
}
