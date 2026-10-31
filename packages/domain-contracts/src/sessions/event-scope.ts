import type { SessionEventRecord } from "./records.js";

/** Global events belong to every session stream; session events stay within their session. */
export function matchesSessionEventScope(
  event: Pick<SessionEventRecord, "sessionId">,
  sessionId?: string,
): boolean {
  return !sessionId || event.sessionId === undefined || event.sessionId === sessionId;
}
