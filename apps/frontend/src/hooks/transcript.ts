import {
  selectSessionMessagesWithParts,
  type SessionBucket,
  type SessionMessagePartRecord,
  type SessionMessageRecord,
} from "@openharness/client";

import type { TranscriptItem } from "../types";

export type TranscriptView = { items: TranscriptItem[]; assistantBuffer: string };

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (block && typeof block === "object" && "text" in block) return String(block.text ?? "");
        return JSON.stringify(block);
      })
      .join("");
  }
  if (content == null) return "";
  return JSON.stringify(content);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function textFromParts(parts: SessionMessagePartRecord[]): string {
  return parts
    .filter((part) => part.type === "text" || part.type === "reasoning")
    .map((part) => part.text ?? "")
    .join("");
}

function messageToTranscriptItems(
  message: SessionMessageRecord,
  parts: SessionMessagePartRecord[],
  inputText?: string,
): TranscriptItem[] {
  if (message.role === "user") {
    return [{
      id: message.inputId ? `input:${message.inputId}` : message.id,
      role: "user",
      text: textFromParts(parts) || inputText || "",
    }];
  }
  if (message.role === "system") return [{ id: message.id, role: "system", text: textFromParts(parts) }];

  const items: TranscriptItem[] = [];
  for (const part of parts) {
    if (part.type === "text") {
      if (part.text) items.push({
        id: `${message.id}:${part.id}`,
        role: "assistant",
        text: part.text,
        streaming: part.status === "pending" || part.status === "running",
      });
      continue;
    }
    if (part.type === "reasoning") {
      if (part.text) items.push({
        id: `${message.id}:${part.id}`,
        role: "reasoning",
        text: part.text,
        streaming: part.status === "pending" || part.status === "running",
      });
      continue;
    }
    if (part.type === "tool") {
      const toolName = part.toolName ?? "tool";
      items.push({
        id: `${message.id}:${part.id}:tool`,
        role: "tool",
        text: toolName,
        tool_name: toolName,
        tool_input: part.input,
      });
      if (part.output !== undefined) {
        const output = isRecord(part.output) ? part.output : {};
        items.push({
          id: `${message.id}:${part.id}:result`,
          role: "tool_result",
          text: contentToText(output.content),
          tool_name: toolName,
          is_error: part.isError === true,
        });
      }
      continue;
    }
    if (part.type === "tool_result") {
      items.push({
        id: `${message.id}:${part.id}:result`,
        role: "tool_result",
        text: contentToText(part.output ?? part.text ?? ""),
        tool_name: part.toolName,
        is_error: part.isError === true,
      });
      continue;
    }
    if (part.type === "error") {
      items.push({ id: `${message.id}:${part.id}`, role: "system", text: part.text ?? "error" });
      continue;
    }
    if (part.type === "log") {
      items.push({ id: `${message.id}:${part.id}`, role: "log", text: part.text ?? "" });
    }
  }
  return items;
}

function projectBucketToItems(bucket: SessionBucket | undefined): TranscriptItem[] {
  if (!bucket) return [];
  const inputById = new Map(bucket.inputs.map((input) => [input.id, input]));
  const projectedInputIds = new Set<string>();
  const items: TranscriptItem[] = [];
  const activeRuns = Object.values(bucket.runs)
    .filter((run) => run.status === "pending" || run.status === "running");
  const activeRunInputIds = new Set(activeRuns.flatMap((run) => run.inputId ? [run.inputId] : []));
  const transcriptUpdatedAt = bucket.messages.reduce(
    (latest, message) => Math.max(latest, message.updatedAt),
    bucket.session?.updatedAt ?? 0,
  );

  for (const { message, parts } of selectSessionMessagesWithParts(bucket)) {
    if (message.role === "user" && message.inputId) projectedInputIds.add(message.inputId);
    items.push(...messageToTranscriptItems(
      message,
      parts,
      message.inputId ? inputById.get(message.inputId)?.content : undefined,
    ));
  }

  // Admission and transcript projection are separate daemon steps. Until the user message
  // exists, keep its input-backed placeholder at the canonical transcript tail. input.seq
  // and message.seq are independent counters and must never be compared. Transcript rewrites
  // such as compact/rewind drop historical inputId links, so old inputs are not placeholders.
  for (const input of [...bucket.inputs].sort((a, b) => a.seq - b.seq)) {
    if (projectedInputIds.has(input.id)) continue;
    const belongsToActiveRun = activeRunInputIds.has(input.id)
      || (input.delivery === "steer" && activeRuns.some((run) => input.createdAt >= run.createdAt));
    const admittedAfterTranscript = input.createdAt >= transcriptUpdatedAt;
    if (!belongsToActiveRun && !admittedAfterTranscript) continue;
    items.push({ id: `input:${input.id}`, role: "user", text: input.content });
  }
  return items;
}

export function bucketToTranscript(
  bucket: SessionBucket | undefined,
  options: { showReasoning?: boolean } = {},
): TranscriptItem[] {
  const items = projectBucketToItems(bucket);
  if (options.showReasoning === false) {
    return items.filter((item) => item.role !== "reasoning");
  }
  return items;
}

export function splitStreamingAssistant(items: TranscriptItem[]): TranscriptView {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!item) continue;
    if (item.role !== "assistant" || item.streaming !== true || !item.text) continue;
    return {
      items: [
        ...items.slice(0, index),
        ...items.slice(index + 1),
      ],
      assistantBuffer: item.text,
    };
  }
  return { items, assistantBuffer: "" };
}
