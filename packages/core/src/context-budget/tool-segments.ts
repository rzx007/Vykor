import type { ContextLedgerSegment } from "@vykor/agent-contracts";

export type ToolSchemaKind = "builtin" | "mcp";

export interface ToolSchemaInput {
  kind: ToolSchemaKind;
  /** 已序列化的工具 schema 字符串 */
  text: string;
}

export function toolSchemasToLedgerSegments(
  schemas: ToolSchemaInput[],
): ContextLedgerSegment[] {
  return schemas.map((schema) => ({
    bucket: schema.kind === "builtin" ? "tools" : "mcp",
    text: schema.text,
  }));
}
