import type { SessionRecord } from "@openharness/protocol";

import {
  DaemonOperationUnavailableError,
  type DaemonOperationGate,
} from "../control/daemon-operation-gate.js";
import { SessionApplicationError } from "./session-application-error.js";
import type { SessionEventPublisher } from "./session-event-publisher.js";

export interface SessionOperationRunnerContext {
  sessions: {
    get(sessionId: string): SessionRecord | undefined;
  };
  operationGate: Pick<DaemonOperationGate, "enter">;
  events: Pick<SessionEventPublisher, "checkpoint" | "publishSince">;
  assertReady?(): void;
}

/** Serializes application mutations per session and owns their shared reliability boundary. */
export class SessionOperationRunner {
  private readonly lanes = new Map<string, Promise<void>>();

  constructor(private readonly context: SessionOperationRunnerContext) {}

  async run<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.lanes.get(sessionId) ?? Promise.resolve();
    let releaseLane!: () => void;
    const current = new Promise<void>((resolve) => {
      releaseLane = resolve;
    });
    this.lanes.set(sessionId, current);

    await previous.catch(() => {});
    try {
      this.context.assertReady?.();
      const session = this.context.sessions.get(sessionId);
      if (!session) {
        throw new SessionApplicationError(404, `Session not found: ${sessionId}`);
      }
      let lease;
      try {
        lease = this.context.operationGate.enter({
          sessionId: session.id,
          cwd: session.cwd,
        });
      } catch (error) {
        if (error instanceof DaemonOperationUnavailableError) {
          throw new SessionApplicationError(409, error.message);
        }
        throw error;
      }

      const checkpoint = this.context.events.checkpoint();
      try {
        const result = await work();
        this.context.events.publishSince(checkpoint);
        return result;
      } finally {
        lease.release();
      }
    } finally {
      releaseLane();
      if (this.lanes.get(sessionId) === current) {
        this.lanes.delete(sessionId);
      }
    }
  }
}
