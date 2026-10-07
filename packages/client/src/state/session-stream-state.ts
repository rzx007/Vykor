import { applyEvent, applySessionSnapshot } from "./reducer.js";
import type { SessionEventRecord, SessionStateSnapshot, VykorClientState } from "../types/index.js";

/** A session SSE stream is ordered, so its cursor replaces a retained event log. */
export function applySessionStreamEvent(
  state: VykorClientState,
  event: SessionEventRecord,
): VykorClientState {
  if (event.seq <= state.lastSeq) return state;
  const next = applyEvent({ ...state, eventsBySeq: {} }, event);
  return { ...next, eventsBySeq: {} };
}

export function applySessionStreamSnapshot(
  state: VykorClientState,
  snapshot: SessionStateSnapshot,
): VykorClientState {
  if (snapshot.cursor < state.lastSeq) return state;
  return { ...applySessionSnapshot(state, snapshot), eventsBySeq: {} };
}
