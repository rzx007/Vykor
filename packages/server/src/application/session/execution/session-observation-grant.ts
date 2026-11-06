import { DomainValidationError } from "@vykor/domain-contracts/inputs";
import { getSessionStorage, type SessionRecord, type SessionRunRecord } from "@vykor/domain-contracts/sessions";
import type { SessionStore } from "@vykor/services";
import { isRecord } from "../../support.js";
import { SessionApplicationError } from "../session-application-error.js";

export interface SessionObservationGrant {
  targetSessionId: string;
  targetRunId: string | null;
  afterSeq: number;
}

function firstTextLine(item: unknown): string | undefined {
  if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") return undefined;
  return item.text.split(/\r?\n/u, 1)[0];
}

export function parseSessionObservationTarget(firstItem: unknown, normalizedFirstItem: unknown = firstItem): string | undefined {
  const line = firstTextLine(firstItem);
  if (line === undefined || !/^observe-session(?:\s|$)/u.test(line.trimStart())) return undefined;
  const target = /^observe-session ([^\s\p{Cc}]+)$/u.exec(line)?.[1];
  if (!target || firstTextLine(normalizedFirstItem) !== line) {
    throw new DomainValidationError("Use observe-session <session ID> on the first line", "items[0].text");
  }
  return target;
}

export function isObservableSession(session: SessionRecord | undefined): session is SessionRecord {
  return session !== undefined && session.parentId === undefined && getSessionStorage(session) === "sqlite" &&
    session.status !== "closing" && session.status !== "archived";
}

export function readSessionObservationGrant(run: Pick<SessionRunRecord, "metadata">): SessionObservationGrant | undefined {
  const { sessionObservationGrant: grant, recovery, recoveredAdmission } = run.metadata;
  if (recoveredAdmission === true || (isRecord(recovery) && recovery.kind === "prompt_replay")) return undefined;
  if (!isRecord(grant) || Object.keys(grant).length !== 3) return undefined;
  const { targetSessionId, targetRunId, afterSeq } = grant;
  if (!validId(targetSessionId) || (targetRunId !== null && (typeof targetRunId !== "string" || !targetRunId.length)) ||
      typeof afterSeq !== "number" || !Number.isSafeInteger(afterSeq) || afterSeq < 0) return undefined;
  return { targetSessionId, targetRunId, afterSeq };
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[^\s\p{Cc}]+$/u.test(value);
}

export function createSessionObservationGrant(
  store: Pick<SessionStore, "sessions" | "runs" | "channels">,
  sourceSessionId: string,
  targetSessionId: string,
  afterSeq: number,
  activeRunId?: string,
): SessionObservationGrant {
  if (sourceSessionId === targetSessionId) throw new SessionApplicationError(400, "observe-session requires a different session");
  const source = store.sessions.get(sourceSessionId);
  const target = store.sessions.get(targetSessionId);
  if (source?.id !== sourceSessionId || target?.id !== targetSessionId) {
    throw new SessionApplicationError(404, "The observe-session source or target was not found");
  }
  if (!isObservableSession(source) || !isObservableSession(target) ||
      store.channels.hasConversationSession(sourceSessionId) || store.channels.hasConversationSession(targetSessionId)) {
    throw new SessionApplicationError(409, "observe-session requires available, durable root sessions without channel bindings");
  }
  const runs = store.runs.listRuns(targetSessionId);
  const selected = runs.find(run => run.id === activeRunId && (run.status === "pending" || run.status === "running")) ??
    runs.find(run => run.status === "running") ?? runs.find(run => run.status === "pending") ?? runs.at(-1);
  return { targetSessionId, targetRunId: selected?.id ?? null, afterSeq };
}
