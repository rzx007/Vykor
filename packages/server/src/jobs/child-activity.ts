import { isCommittedModelPart, type SessionMessagePartRecord, type SessionMessageRecord, type SessionRecord, type SessionRunAttemptRecord, type SessionRunRecord } from "@vykor/protocol";
import type { ChildActivitySnapshot } from "@vykor/core";

const MAX_ACTIVITY_TEXT = 2_000;

/** Minimal read-only durable queries needed to build one child Run's activity view. */
export interface ChildActivityReader {
  getSession(sessionId: string): SessionRecord | undefined;
  listMessages(sessionId: string): SessionMessageRecord[];
  listMessageParts(sessionId: string): SessionMessagePartRecord[];
  getRun(runId: string): SessionRunRecord | undefined;
  listRunAttempts(runId: string): SessionRunAttemptRecord[];
}

/**
 * Build the bounded activity view from persisted child records. Returns undefined
 * when the parent/child/run identities cannot be verified, so a forged
 * childSessionId or foreign Run is never exposed.
 */
export function readPersistedChildActivity(
  reader: ChildActivityReader,
  input: { parentSessionId: string; childSessionId: string; runId?: string },
): ChildActivitySnapshot | undefined {
  if (!input.runId) return undefined;
  const child = reader.getSession(input.childSessionId);
  if (!child || child.parentId !== input.parentSessionId) return undefined;
  const run = reader.getRun(input.runId);
  if (!run || run.sessionId !== input.childSessionId) return undefined;

  const messages = new Map(
    reader.listMessages(input.childSessionId)
      .filter((message) => message.runId === input.runId)
      .map((message) => [message.id, message] as const),
  );
  const parts = reader.listMessageParts(input.childSessionId)
    .filter((part) => messages.has(part.messageId) && isCommittedModelPart(part))
    .sort((left, right) => left.seq - right.seq);
  const latestText = parts
    .filter((part) =>
      part.type === "text" &&
      messages.get(part.messageId)?.role === "assistant" &&
      (part.text ?? "").length > 0)
    .at(-1)?.text;
  const toolParts = parts.filter((part) => part.type === "tool" && part.toolName);
  const latestToolPart = toolParts.at(-1);
  const attempts = reader.listRunAttempts(input.runId);
  const knownAttempts = attempts.filter(
    (attempt) => attempt.inputTokens !== undefined && attempt.outputTokens !== undefined,
  );
  const usage = attempts.length === 0
    ? undefined
    : {
        ...(knownAttempts.length > 0
          ? {
              inputTokens: knownAttempts.reduce((total, attempt) => total + (attempt.inputTokens ?? 0), 0),
              outputTokens: knownAttempts.reduce((total, attempt) => total + (attempt.outputTokens ?? 0), 0),
            }
          : {}),
        incomplete: knownAttempts.length !== attempts.length,
      };

  return {
    version: 1,
    runId: input.runId,
    updatedAt: Math.max(
      run.updatedAt,
      ...parts.map((part) => part.updatedAt),
      ...attempts.map((attempt) => attempt.updatedAt),
    ),
    ...(latestText ? { latestAssistantText: latestText.slice(0, MAX_ACTIVITY_TEXT) } : {}),
    ...(latestToolPart
      ? {
          latestTool: {
            name: latestToolPart.toolName!,
            status: persistedToolStatus(latestToolPart),
            at: latestToolPart.updatedAt,
          },
        }
      : {}),
    toolCalls: toolParts.length,
    modelTurns: attempts.filter((attempt) => attempt.status === "completed").length,
    ...(usage ? { usage } : {}),
  };
}

function persistedToolStatus(
  part: SessionMessagePartRecord,
): "running" | "completed" | "failed" {
  if (part.isError === true || part.status === "failed" || part.status === "interrupted") {
    return "failed";
  }
  return part.status === "completed" ? "completed" : "running";
}
