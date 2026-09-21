/**
 * Pure transcript rewind helper for POST /sessions/:id/rewind.
 * Counts user turns from the end.
 */

import type {
  ReplaceTranscriptMessageInput,
  SessionMessagePartRecord,
  SessionMessageRecord,
} from "@openharness/protocol";
import { publicTextFromParts } from "./transcript-text.js";

export interface RewindTranscriptResult {
  kept: ReplaceTranscriptMessageInput[];
  turns: number;
  removed: number;
}

function userText(parts: SessionMessagePartRecord[]): string {
  return publicTextFromParts(parts).trim();
}

function toReplaceInput(
  message: SessionMessageRecord,
  parts: SessionMessagePartRecord[],
): ReplaceTranscriptMessageInput {
  return {
    role: message.role,
    ...(Object.keys(message.metadata).length > 0 ? { metadata: { ...message.metadata } } : {}),
    parts: parts.map((part) => ({
      type: part.type,
      status: part.status,
      ...(part.text !== undefined ? { text: part.text } : {}),
      ...(part.toolUseId !== undefined ? { toolUseId: part.toolUseId } : {}),
      ...(part.toolName !== undefined ? { toolName: part.toolName } : {}),
      ...(part.input !== undefined ? { input: part.input } : {}),
      ...(part.output !== undefined ? { output: part.output } : {}),
      ...(part.isError !== undefined ? { isError: part.isError } : {}),
      ...(Object.keys(part.metadata).length > 0 ? { metadata: { ...part.metadata } } : {}),
    })),
  };
}

export function rewindTranscript(
  messages: SessionMessageRecord[],
  parts: SessionMessagePartRecord[],
  turnCount: number,
): RewindTranscriptResult {
  const byMessage = new Map<string, SessionMessagePartRecord[]>();
  for (const part of parts) {
    const rows = byMessage.get(part.messageId) ?? [];
    rows.push(part);
    byMessage.set(part.messageId, rows);
  }
  for (const rows of byMessage.values()) {
    rows.sort((a, b) => a.seq - b.seq);
  }

  const ordered = [...messages].sort((a, b) => a.seq - b.seq);
  let removed = 0;
  let turns = 0;

  while (turns < turnCount && ordered.length > 0) {
    const message = ordered.pop()!;
    removed += 1;
    const messageParts = byMessage.get(message.id) ?? [];
    if (message.role === "user" && userText(messageParts)) {
      turns += 1;
    }
  }

  return {
    kept: ordered.map((message) => toReplaceInput(message, byMessage.get(message.id) ?? [])),
    turns,
    removed,
  };
}
