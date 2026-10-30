import type { SessionRunRecord } from "../types/index.js";
import { selectVisibleSessionMessagesWithParts, type SessionMessageWithParts } from "./selectors.js";
import { syncEvents, type SyncEventsClient } from "./sync.js";

export interface WaitForRunOptions {
  sessionId: string;
  runId: string;
  signal?: AbortSignal;
}

export interface RunResult {
  run: SessionRunRecord;
  messages: SessionMessageWithParts[];
}

/** Wait for this Run's durable terminal state using the shared snapshot/recovery algorithm. */
export async function waitForRun(client: SyncEventsClient, options: WaitForRunOptions): Promise<RunResult> {
  options.signal?.throwIfAborted();
  for await (const update of syncEvents(client, { sessionId: options.sessionId, signal: options.signal })) {
    options.signal?.throwIfAborted();
    const bucket = update.state.buckets[options.sessionId];
    const run = bucket?.runs[options.runId];
    if (!run || run.status === "pending" || run.status === "running") continue;
    return {
      run,
      messages: selectVisibleSessionMessagesWithParts(bucket).filter(item => item.message.runId === options.runId),
    };
  }
  options.signal?.throwIfAborted();
  throw new Error(`Run ${options.runId} observation ended before a terminal state was available`);
}
