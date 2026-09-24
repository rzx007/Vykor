import type { ToolContext, ToolResult } from "@vykor/core";
import { NativeToolHostError } from "./tool-host.js";

export interface NativeToolAuditEvent {
  pluginId: string;
  toolName: string;
  cwd: string;
  sessionId?: string;
  inputSummary: string;
  durationMs: number;
  status: "completed" | "failed";
  errorCode?: string;
}

export interface NativeToolCallGuardOptions {
  pluginId: string;
  maxConcurrentCalls?: number;
  onAudit?: (event: NativeToolAuditEvent) => void;
}

export class NativeToolCallGuard {
  private activeCalls = 0;

  constructor(private readonly options: NativeToolCallGuardOptions) {}

  async run(
    toolName: string,
    inputSchema: Record<string, unknown>,
    input: Record<string, unknown>,
    context: ToolContext,
    call: () => Promise<ToolResult>,
  ): Promise<ToolResult> {
    const started = Date.now();
    const cwd = context.cwd;
    const inputSummary = summarizeInput(input);
    let errorCode: string | undefined;
    let status: NativeToolAuditEvent["status"] = "failed";
    try {
      const maxConcurrentCalls = this.options.maxConcurrentCalls ?? 4;
      if (this.activeCalls >= maxConcurrentCalls) {
        throw new NativeToolHostError(
          "tool_concurrency_limit",
          `Native Tool ${toolName} has reached its concurrency limit (${maxConcurrentCalls}). Retry after another call finishes.`,
        );
      }
      const validation = validateJsonSchemaInput(inputSchema, input);
      if (validation) {
        throw new NativeToolHostError(
          "tool_input_invalid",
          `Native Tool ${toolName} input is invalid: ${validation}`,
        );
      }
      this.activeCalls += 1;
      try {
        const result = await call();
        status = "completed";
        return result;
      } finally {
        this.activeCalls -= 1;
      }
    } catch (error) {
      errorCode = error instanceof NativeToolHostError ? error.code : "tool_call_failed";
      throw error;
    } finally {
      this.options.onAudit?.({
        pluginId: this.options.pluginId,
        toolName,
        cwd,
        ...(context.sessionId ? { sessionId: context.sessionId } : {}),
        inputSummary,
        durationMs: Date.now() - started,
        status,
        ...(errorCode ? { errorCode } : {}),
      });
    }
  }
}

export function formatNativeToolAuditEvent(event: NativeToolAuditEvent): string {
  return JSON.stringify({
    type: "native_tool_call",
    pluginId: event.pluginId,
    toolName: event.toolName,
    cwd: event.cwd,
    ...(event.sessionId ? { sessionId: event.sessionId } : {}),
    inputSummary: event.inputSummary,
    durationMs: event.durationMs,
    status: event.status,
    ...(event.errorCode ? { errorCode: event.errorCode } : {}),
  });
}

function summarizeInput(input: Record<string, unknown>): string {
  const keys = Object.keys(input).sort();
  const parts = keys.slice(0, 12).map((key) => `${key}:${summarizeValue(input[key])}`);
  const suffix = keys.length > 12 ? `,+${keys.length - 12} keys` : "";
  return `{${parts.join(",")}${suffix}}`;
}

function summarizeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(${value.length})`;
  switch (typeof value) {
    case "string":
      return `string(${value.length})`;
    case "number":
    case "boolean":
    case "bigint":
      return typeof value;
    case "object":
      return `object(${Object.keys(value as Record<string, unknown>).length})`;
    case "undefined":
      return "undefined";
    default:
      return "unknown";
  }
}

function validateJsonSchemaInput(schema: Record<string, unknown>, input: Record<string, unknown>): string | undefined {
  if (Object.keys(schema).length === 0) return undefined;
  return validateValue(schema, input, "input");
}

function validateValue(schema: Record<string, unknown>, value: unknown, path: string): string | undefined {
  if (typeof schema.const !== "undefined" && value !== schema.const) return `${path} must equal ${JSON.stringify(schema.const)}`;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return `${path} must be one of ${schema.enum.map((item) => JSON.stringify(item)).join(", ")}`;
  const type = schema.type;
  if (typeof type === "string") {
    const typeError = validateType(type, value, path);
    if (typeError) return typeError;
  }
  const hasObjectKeywords = isPlainObject(schema.properties) || Array.isArray(schema.required) || schema.additionalProperties === false;
  if (type === "object" || hasObjectKeywords) {
    if (!isPlainObject(value)) return `${path} must be an object`;
    const objectValue = value as Record<string, unknown>;
    const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : [];
    for (const key of required) if (!(key in objectValue)) return `${path}.${key} is required`;
    const properties = isPlainObject(schema.properties) ? schema.properties as Record<string, unknown> : {};
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (!(key in objectValue) || !isPlainObject(propertySchema)) continue;
      const nested = validateValue(propertySchema as Record<string, unknown>, objectValue[key], `${path}.${key}`);
      if (nested) return nested;
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(objectValue)) if (!(key in properties)) return `${path}.${key} is not allowed`;
    }
  }
  if (type === "array" || (schema.items && Array.isArray(value))) {
    if (!Array.isArray(value)) return `${path} must be an array`;
    if (typeof schema.minItems === "number" && value.length < schema.minItems) return `${path} must have at least ${schema.minItems} item(s)`;
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return `${path} must have at most ${schema.maxItems} item(s)`;
    if (isPlainObject(schema.items)) {
      for (let index = 0; index < value.length; index += 1) {
        const nested = validateValue(schema.items as Record<string, unknown>, value[index], `${path}[${index}]`);
        if (nested) return nested;
      }
    }
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) return `${path} must have at least ${schema.minLength} character(s)`;
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) return `${path} must have at most ${schema.maxLength} character(s)`;
  }
  return undefined;
}

function validateType(type: string, value: unknown, path: string): string | undefined {
  if (type === "array") return Array.isArray(value) ? undefined : `${path} must be an array`;
  if (type === "object") return isPlainObject(value) ? undefined : `${path} must be an object`;
  if (type === "integer") return Number.isInteger(value) ? undefined : `${path} must be an integer`;
  if (type === "number") return typeof value === "number" && Number.isFinite(value) ? undefined : `${path} must be a number`;
  if (type === "string") return typeof value === "string" ? undefined : `${path} must be a string`;
  if (type === "boolean") return typeof value === "boolean" ? undefined : `${path} must be a boolean`;
  if (type === "null") return value === null ? undefined : `${path} must be null`;
  return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
