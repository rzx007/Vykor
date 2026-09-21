import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { getDataDir } from "@openharness/core";

import type {
  SessionInputRecord,
  SessionMessagePartRecord,
  SessionMessageRecord,
  SessionRecord,
} from "@openharness/protocol";

export type SessionExportFormat = "md" | "json";

export interface BuildSessionExportInput {
  session: SessionRecord;
  inputs: SessionInputRecord[];
  messages: SessionMessageRecord[];
  parts: SessionMessagePartRecord[];
  format: SessionExportFormat;
  filename?: string;
}

export interface SessionExportResult {
  format: SessionExportFormat;
  filepath: string;
  messageCount: number;
}

function partsForMessage(
  messageId: string,
  parts: SessionMessagePartRecord[],
): SessionMessagePartRecord[] {
  return parts
    .filter((part) => part.messageId === messageId)
    .sort((a, b) => a.seq - b.seq);
}

function textFromParts(parts: SessionMessagePartRecord[]): string {
  return parts
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("");
}

function markdownFromParts(parts: SessionMessagePartRecord[]): string {
  return parts
    .flatMap((part) => {
      if (part.type === "text") {
        return part.text ? [part.text] : [];
      }
      if (part.type === "attachment") {
        return [
          `[附件: ${part.displayName} | ${part.mediaType} | ${part.sizeBytes} bytes | assetId=${part.assetId}]`,
        ];
      }
      return [];
    })
    .join("\n");
}

function buildMarkdown(input: BuildSessionExportInput): string {
  const lines = [
    "# OpenHarness Conversation Export",
    "",
    `- **Date:** ${new Date().toISOString()}`,
    `- **Model:** ${input.session.model}`,
    `- **Session:** ${input.session.id}`,
    `- **Messages:** ${input.messages.length}`,
    "",
    "---",
    "",
  ];

  for (const message of [...input.messages].sort((a, b) => a.seq - b.seq)) {
    const messageParts = partsForMessage(message.id, input.parts);
    if (message.role === "user") {
      lines.push("## User", "", markdownFromParts(messageParts), "", "---", "");
      continue;
    }
    if (message.role === "system") {
      lines.push("## System", "", markdownFromParts(messageParts), "", "---", "");
      continue;
    }

    lines.push("## Assistant", "", textFromParts(messageParts) || "", "");
    for (const part of messageParts.filter((candidate) => candidate.type === "tool")) {
      lines.push(
        `**Tool call: \`${part.toolName ?? "unknown"}\`**`,
        "```json",
        JSON.stringify(part.input ?? {}, null, 2),
        "```",
        "",
      );
      if (part.output !== undefined) {
        const text = typeof part.output === "string"
          ? part.output
          : JSON.stringify(part.output, null, 2);
        const status = part.isError ? "error" : "ok";
        lines.push(`### Tool result (${status})`, "```", text.slice(0, 4000), "```", "");
      }
    }
    lines.push("---", "");
  }

  return lines.join("\n");
}

function buildJson(input: BuildSessionExportInput): string {
  const messages = [...input.messages]
    .sort((a, b) => a.seq - b.seq)
    .map((message) => {
      const messageParts = partsForMessage(message.id, input.parts);
      if (message.role === "user" || message.role === "system") {
        return { role: message.role, content: textFromParts(messageParts), parts: messageParts };
      }
      return {
        role: "assistant",
        content: textFromParts(messageParts) || null,
        parts: messageParts,
        tool_uses: messageParts
          .filter((part) => part.type === "tool" && part.toolUseId && part.toolName)
          .map((part) => ({
            id: part.toolUseId,
            name: part.toolName,
            input: part.input ?? {},
            ...(part.output !== undefined ? { output: part.output } : {}),
            ...(part.isError !== undefined ? { is_error: part.isError } : {}),
          })),
      };
    });

  return JSON.stringify(
    {
      session_id: input.session.id,
      model: input.session.model,
      exported_at: new Date().toISOString(),
      message_count: input.messages.length,
      inputs: [...input.inputs].sort((a, b) => a.seq - b.seq),
      messages,
    },
    null,
    2,
  );
}

export async function writeSessionExport(input: BuildSessionExportInput): Promise<SessionExportResult> {
  if (input.messages.length === 0) {
    throw new Error("No messages to export.");
  }

  const dir = join(getDataDir(), "exports");
  await mkdir(dir, { recursive: true });

  const defaultName = `export-${Date.now()}.${input.format === "json" ? "json" : "md"}`;
  const filename = input.filename?.trim() || defaultName;
  const filepath = isAbsolute(filename) || filename.includes("/") || filename.includes("\\")
    ? filename
    : join(dir, filename);

  const content = input.format === "json" ? buildJson(input) : buildMarkdown(input);
  await writeFile(filepath, content, "utf-8");

  return {
    format: input.format,
    filepath,
    messageCount: input.messages.length,
  };
}
