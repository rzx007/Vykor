export interface TextBlock {
  type: "text";
  text: string;
}

export interface ImageBlock {
  type: "image";
  source: ImageSource;
}

export interface ImageSource {
  type: "file";
  mediaType: string;
  path: string;
  sizeBytes?: number;
  prepared?: VisionImagePreparationMetadata;
}

export interface VisionImagePreparationMetadata {
  mediaType: string;
  width: number;
  height: number;
  base64Bytes: number;
  policyVersion: string;
}

export type ContentBlock = TextBlock | ImageBlock;
/** Opaque handle into an authorized result store; never a filesystem path. */
export interface ToolResultRef { id: string; toolName: string; totalChars: number }
export interface ToolResultPage { ref: ToolResultRef; text: string; offset: number; nextOffset?: number }
export interface ToolResultSearch {
  ref: ToolResultRef;
  matches: Array<{ offset: number; text: string }>;
  nextOffset?: number;
}
export interface ToolResultList { items: ToolResultRef[]; nextOffset?: number }
export type { RunToolResultStore } from "./result-data.js";
export { assertToolResultId, ToolResultAccessError, toolResultBounds, toolResultText, toolResultList, toolResultPage, toolResultSearch } from "./result-text.js";

export interface ToolResult {
  /** Checked builtin proof; free tool text/metadata cannot establish visible project rules. */
  hostProjectInstructionKeys?: string[];
  /** Added by the trusted result archive after preserving the original output. */
  resultRef?: ToolResultRef;
  content: ContentBlock[];
  /** Original bounded MCP response; private to the authorized application host. */
  mcpResult?: McpCallResultData;
  isError?: boolean;
  failureKind?: ToolFailureKind;
  executionState?: ToolExecutionState;
  recoveryHint?: string;
  /** Controlled builtin/host summary, at most 1,000 characters; never an instruction. */
  compactSummary?: string;
  /** Set only by checked execution after verifying the captured builtin definition. */
  hostFileFacts?: HostFileFacts;
  metadata?: Record<string, unknown>;
}

/** File observations emitted by a captured builtin; free metadata is not a trust boundary. */
export interface HostFileFacts {
  environmentKey: string;
  executionRoot?: string;
  pathStyle?: "windows" | "posix";
  files: Array<{
    path: string;
    subjectKey: string;
    operation: "read" | "write" | "edit" | "patch";
    beforeDigest?: "missing" | `sha256:${string}`;
    afterDigest: "missing" | `sha256:${string}`;
    completed: true;
    bodyVisible?: boolean;
  }>;
}

export interface ToolExecutionResult extends ToolResult {
  toolUseId: string;
  toolName: string;
  toolAttemptId?: string;
}

/** A definite result does not imply success or completion of the user's goal. */
export type ToolExecutionState = "not_started" | "completed" | "unknown";

export type ToolFailureKind =
  | "permission" | "policy" | "timeout" | "command" | "transport"
  | "provider" | "interrupted" | "unknown_outcome"
  | "invalid_input" | "precondition" | "authentication" | "configuration";

/** JSON transported to an application; no runtime objects or host execution facts. */
export type McpJsonValue = null | boolean | number | string | McpJsonValue[] | McpJsonObject;
export interface McpJsonObject { [key: string]: McpJsonValue }

export interface McpCallResultData {
  content: McpJsonObject[];
  structuredContent?: McpJsonObject;
  _meta?: McpJsonObject;
  isError?: boolean;
  [key: string]: McpJsonValue | undefined;
}

export interface McpToolUiMetadata {
  resourceUri?: string;
  visibility: Array<"model" | "app">;
}

export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export const MCP_CALL_RESULT_MAX_BYTES = 1024 * 1024;

/** Fixed diagnostic messages never include rejected private response data. */
export class McpResultDataError extends Error {
  constructor(message: string) { super(message); this.name = "McpResultDataError"; }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Copy bounded JSON without invoking toJSON/getters or silently dropping fields. */
export function parseMcpCallResultData(value: unknown): McpCallResultData {
  const ancestors = new Set<object>();
  let nodes = 0;
  let stringBytes = 0;
  const encoder = new TextEncoder();
  const visit = (item: unknown, depth: number): McpJsonValue => {
    if (++nodes > 100_000 || depth > 32) throw new McpResultDataError("MCP result exceeds JSON complexity limit");
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (typeof item === "string") {
      stringBytes += encoder.encode(item).byteLength;
      if (stringBytes > MCP_CALL_RESULT_MAX_BYTES) throw new McpResultDataError("MCP result exceeds 1 MiB limit");
      return item;
    }
    if (!item || typeof item !== "object" || ancestors.has(item)) throw new McpResultDataError("MCP result must contain finite JSON data");
    const prototype = Object.getPrototypeOf(item);
    if (Array.isArray(item) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
      throw new McpResultDataError("MCP result must contain plain JSON data");
    }
    ancestors.add(item);
    const entries: Array<[string, McpJsonValue]> = [];
    for (const key of Reflect.ownKeys(item)) {
      if (Array.isArray(item) && key === "length") continue;
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
      if (typeof key !== "string" || !descriptor.enumerable || !("value" in descriptor)) throw new McpResultDataError("MCP result must contain plain JSON data");
      if (Array.isArray(item) && !/^(0|[1-9][0-9]*)$/.test(key)) throw new McpResultDataError("MCP result must contain plain JSON arrays");
      stringBytes += encoder.encode(key).byteLength;
      if (stringBytes > MCP_CALL_RESULT_MAX_BYTES) throw new McpResultDataError("MCP result exceeds 1 MiB limit");
      entries.push([key, visit(descriptor.value, depth + 1)]);
    }
    ancestors.delete(item);
    if (Array.isArray(item)) {
      if (entries.length !== item.length) throw new McpResultDataError("MCP result must not contain sparse arrays");
      return entries.map(([, entry]) => entry);
    }
    return Object.fromEntries(entries);
  };
  const copied = visit(value, 0);
  if (!object(copied) || !Array.isArray(copied.content)
    || !copied.content.every(block => object(block) && typeof block.type === "string" && (block.type !== "text" || typeof block.text === "string"))
    || (copied.structuredContent !== undefined && !object(copied.structuredContent))
    || (copied._meta !== undefined && !object(copied._meta))
    || (copied.isError !== undefined && typeof copied.isError !== "boolean")) {
    throw new McpResultDataError("Invalid MCP call result shape");
  }
  if (encoder.encode(JSON.stringify(copied)).byteLength > MCP_CALL_RESULT_MAX_BYTES) throw new McpResultDataError("MCP result exceeds 1 MiB limit");
  return copied as McpCallResultData;
}

/** Only original text or structured content enters model feedback; never stringify _meta. */
export function mcpResultModelText(result: McpCallResultData): string {
  const text = result.content.filter(block => block.type === "text" && typeof block.text === "string").map(block => block.text as string).join("\n");
  return text.trim() ? text : result.structuredContent !== undefined ? JSON.stringify(result.structuredContent) : "(no output)";
}

/** Discovery hints describe presentation only and never authorize execution. */
export function normalizeMcpToolMetadata(value: unknown): { ui?: McpToolUiMetadata; annotations?: McpToolAnnotations } {
  if (!object(value)) return {};
  const meta = object(value._meta) ? value._meta : undefined;
  let ui: McpToolUiMetadata | undefined;
  if (meta && "ui" in meta) {
    if (!object(meta.ui)) throw new McpResultDataError("Invalid MCP tool UI metadata");
    const candidate = meta.ui;
    if (candidate.resourceUri !== undefined && (typeof candidate.resourceUri !== "string" || !candidate.resourceUri.startsWith("ui://"))) throw new McpResultDataError("Invalid MCP tool UI resource URI");
    const visibility = candidate.visibility === undefined ? ["model", "app"] : candidate.visibility;
    if (!Array.isArray(visibility) || visibility.length === 0 || visibility.some(item => item !== "model" && item !== "app")) throw new McpResultDataError("Invalid MCP tool visibility");
    ui = { ...(typeof candidate.resourceUri === "string" ? { resourceUri: candidate.resourceUri } : {}), visibility: [...new Set(visibility)] as Array<"model" | "app"> };
  }
  let annotations: McpToolAnnotations | undefined;
  if (object(value.annotations)) {
    annotations = {};
    if (typeof value.annotations.title === "string") annotations.title = value.annotations.title;
    for (const key of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const) {
      if (typeof value.annotations[key] === "boolean") annotations[key] = value.annotations[key];
    }
  }
  return { ...(ui ? { ui } : {}), ...(annotations ? { annotations } : {}) };
}

/** Ordinary lists, exports, hooks and imports must use this view, never the durable raw body. */
export function publicToolResult(value: unknown): unknown {
  if (!object(value)) return value;
  const { mcpResult: _raw, _meta: _private, appData: _appData, ...rest } = value;
  if (object(rest.metadata)) {
    const { mcpResult: _metadataRaw, _meta: _metadataPrivate, appData: _metadataAppData, ...metadata } = rest.metadata;
    return { ...rest, metadata };
  }
  return rest;
}

/** Canonical MCP App HTML media type used by resource producers and consumers. */
export const MCP_APP_HTML_MIME_TYPE = "text/html;profile=mcp-app";
