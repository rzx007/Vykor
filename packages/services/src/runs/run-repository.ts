import type {
  SessionExecutionRecord,
  SessionRunAttemptRecord,
  SessionRunRecord,
} from "@openharness/protocol";

import type { StorageContext } from "../database/storage-context.js";
import { assertSession, clone } from "../session-runtime/store-state.js";

export class RunRepository {
  constructor(private readonly storage: StorageContext) {}

  getRun(runId: string): SessionRunRecord | undefined {
    const run = this.storage.state.runs[runId];
    return run ? clone(run) : undefined;
  }

  findRunByInput(inputId: string): SessionRunRecord | undefined {
    const direct = this.findOwningRunByInput(inputId);
    if (direct) return clone(direct);
    const promoted = Object.values(this.storage.state.messages).find(
      (message) => message.inputId === inputId && message.runId,
    );
    const run = promoted?.runId ? this.storage.state.runs[promoted.runId] : undefined;
    return run ? clone(run) : undefined;
  }

  listRunsByInput(inputId: string): SessionRunRecord[] {
    return clone(
      Object.values(this.storage.state.runs)
        .filter((candidate) => candidate.inputId === inputId)
        .sort(
          (left, right) =>
            left.createdAt - right.createdAt || left.id.localeCompare(right.id),
        ),
    );
  }

  findOwningRunByInput(inputId: string): SessionRunRecord | undefined {
    return this.listRunsByInput(inputId)[0];
  }

  listRuns(sessionId: string): SessionRunRecord[] {
    assertSession(this.storage.state, sessionId);
    return clone(
      Object.values(this.storage.state.runs)
        .filter((run) => run.sessionId === sessionId)
        .sort((a, b) => a.createdAt - b.createdAt),
    );
  }

  getRunAttempt(attemptId: string): SessionRunAttemptRecord | undefined {
    const attempt = this.storage.state.attempts[attemptId];
    return attempt ? clone(attempt) : undefined;
  }

  listRunAttempts(runId: string): SessionRunAttemptRecord[] {
    if (!this.storage.state.runs[runId])
      throw new Error(`Session run not found: ${runId}`);
    return clone(
      Object.values(this.storage.state.attempts)
        .filter((attempt) => attempt.runId === runId)
        .sort((left, right) => left.sequence - right.sequence),
    );
  }

  getSessionTask(taskId: string): SessionExecutionRecord | undefined {
    const task = this.storage.state.tasks[taskId];
    return task ? clone(task) : undefined;
  }

  listSessionTasks(sessionId: string): SessionExecutionRecord[] {
    assertSession(this.storage.state, sessionId);
    return clone(
      Object.values(this.storage.state.tasks)
        .filter((task) => task.sessionId === sessionId)
        .sort((a, b) => a.createdAt - b.createdAt),
    );
  }

  findSessionExecutionByRuntimeId(
    sessionId: string,
    runtimeExecutionId: string,
  ): SessionExecutionRecord | undefined {
    assertSession(this.storage.state, sessionId);
    const task = Object.values(this.storage.state.tasks).find(
      (candidate) =>
        candidate.sessionId === sessionId &&
        (candidate.metadata.runtimeExecutionId === runtimeExecutionId ||
          candidate.metadata.taskManagerId === runtimeExecutionId),
    );
    return task ? clone(task) : undefined;
  }
}
