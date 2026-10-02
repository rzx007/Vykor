const PROPERTY_ALIASES: Record<string, readonly string[]> = {
  file_path: ["path", "filePath"],
  path: ["file_path", "filePath"],
  content: ["contents"],
  contents: ["content"],
  old_string: ["oldString"],
  new_string: ["newString"],
  replace_all: ["replaceAll"],
};

export function normalizeToolInput(
  schema: Record<string, unknown> | undefined,
  input: unknown,
): unknown {
  if (!schema || !isRecord(input)) return input;
  if (hasSchemaComposition(schema)) return input;

  const properties = isRecord(schema.properties) ? schema.properties : {};
  const propertyNames = Object.keys(properties);
  if (propertyNames.length === 0) return input;

  const normalized = normalizePropertyAliases(schema, input);
  if (validateToolInput(schema, normalized) === null) return normalized;
  // Preserve legitimate arguments fields.
  if (Object.hasOwn(properties, "arguments")) return normalized;

  let candidate = input;
  // Bounded even for cyclic SDK input; only return a fully validated candidate.
  for (let depth = 0; depth < 8; depth++) {
    const keys = Object.keys(candidate);
    if (keys.length !== 1 || keys[0] !== "arguments"
      || !isRecord(candidate.arguments)) break;
    candidate = candidate.arguments;
    const result = normalizePropertyAliases(schema, candidate);
    if (validateToolInput(schema, result) === null) return result;
  }
  return normalized;
}

function normalizePropertyAliases(
  schema: Record<string, unknown>,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  if (propertyAliasConflict(properties, input)) return input;
  const normalized: Record<string, unknown> = { ...input };
  let changed = false;

  for (const key of Object.keys(properties)) {
    const aliases = propertyAliases(properties, key).filter(alias => Object.hasOwn(input, alias));
    if (!Object.hasOwn(input, key) && aliases.length > 0) {
      normalized[key] = input[aliases[0]!];
      changed = true;
    }
    if (schema.additionalProperties === false) {
      for (const alias of aliases) {
        delete normalized[alias];
        changed = true;
      }
    }
  }

  return changed ? normalized : input;
}

function propertyAliases(properties: Record<string, unknown>, key: string): readonly string[] {
  // Declared properties are independent business fields, never alias sources.
  return Object.hasOwn(PROPERTY_ALIASES, key)
    ? PROPERTY_ALIASES[key]!.filter(alias => !Object.hasOwn(properties, alias)) : [];
}

function propertyAliasConflict(properties: Record<string, unknown>, input: Record<string, unknown>): string | undefined {
  for (const key of Object.keys(properties)) {
    const names = [key, ...propertyAliases(properties, key)].filter(name => Object.hasOwn(input, name));
    if (names.some(name => !Object.is(input[name], input[names[0]!]))) {
      return `has conflicting aliases for "${key}": ${names.join(", ")}`;
    }
  }
  return undefined;
}

export function validateToolInput(
  schema: Record<string, unknown> | undefined,
  input: unknown,
): string | null {
  if (!schema || Object.keys(schema).length === 0) return null;

  const errors = validateValue(schema, input, "input");
  return errors[0] ?? null;
}

function hasSchemaComposition(schema: Record<string, unknown>): boolean {
  return ["anyOf", "oneOf", "allOf", "$ref"].some(key => key in schema);
}

function validateValue(schema: unknown, value: unknown, path: string, inferAliases = true): string[] {
  if (!isRecord(schema)) return [];
  inferAliases = inferAliases && !hasSchemaComposition(schema);

  const anyOf = schema.anyOf;
  if (Array.isArray(anyOf) && anyOf.length > 0) {
    const branchErrors = anyOf.map((branch) => validateValue(branch, value, path, inferAliases));
    if (branchErrors.some((errors) => errors.length === 0)) return [];
    return [branchErrors[0]?.[0] ?? `${path} must match at least one schema`];
  }

  const oneOf = schema.oneOf;
  if (Array.isArray(oneOf) && oneOf.length > 0) {
    const matches = oneOf.filter((branch) => validateValue(branch, value, path, inferAliases).length === 0);
    if (matches.length === 1) return [];
    return [`${path} must match exactly one schema`];
  }

  const allOf = schema.allOf;
  if (Array.isArray(allOf) && allOf.length > 0) {
    const errors = allOf.flatMap((branch) => validateValue(branch, value, path, inferAliases));
    if (errors.length > 0) return errors;
  }

  const errors: string[] = [];

  if ("const" in schema && !Object.is(value, schema.const)) {
    errors.push(`${path} must be ${JSON.stringify(schema.const)}`);
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((item) => Object.is(item, value))) {
    errors.push(`${path} must be one of ${schema.enum.map((item) => JSON.stringify(item)).join(", ")}`);
  }

  const typeError = validateType(schema.type, value, path);
  if (typeError) errors.push(typeError);

  if (isRecord(value)) {
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (typeof key === "string" && !Object.prototype.hasOwnProperty.call(value, key)) {
        errors.push(`${path} missing required property "${key}"`);
      }
    }

    const properties = isRecord(schema.properties) ? schema.properties : {};
    const aliasConflict = inferAliases ? propertyAliasConflict(properties, value) : undefined;
    if (aliasConflict) errors.push(`${path} ${aliasConflict}`);
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        errors.push(...validateValue(propertySchema, value[key], `${path}.${key}`, inferAliases));
      }
    }

    if (schema.additionalProperties === false) {
      const known = new Set(Object.keys(properties));
      for (const key of Object.keys(value)) {
        if (!known.has(key)) {
          errors.push(`${path} has unknown property "${key}"`);
        }
      }
    }
  }

  if (Array.isArray(value) && schema.items !== undefined) {
    value.forEach((item, index) => {
      errors.push(...validateValue(schema.items, item, `${path}[${index}]`, inferAliases));
    });
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      errors.push(`${path} must be >= ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      errors.push(`${path} must be <= ${schema.maximum}`);
    }
  }

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      errors.push(`${path} length must be >= ${schema.minLength}`);
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      errors.push(`${path} length must be <= ${schema.maxLength}`);
    }
  }

  return errors;
}

function validateType(schemaType: unknown, value: unknown, path: string): string | null {
  if (schemaType === undefined) return null;
  const allowed = Array.isArray(schemaType) ? schemaType : [schemaType];
  if (!allowed.every((type) => typeof type === "string")) return null;
  if (allowed.some((type) => matchesType(type, value))) return null;
  return `${path} must be ${allowed.join(" or ")}`;
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "object":
      return isRecord(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return true;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
