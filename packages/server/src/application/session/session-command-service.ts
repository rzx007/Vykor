import { randomUUID } from "node:crypto";
import type {
  CreateSessionInput,
  SessionMessagePartRecord,
  SessionMessageRecord,
  SessionMessageRole,
  SessionRecord,
  UpsertMessagePartInput,
} from "@openharness/protocol";
import { readSessionRuntimeConfig } from "@openharness/protocol";
import { isRecord, runtimeSessionMetadataChanged } from "../support.js";
import { SessionApplicationError } from "./session-application-error.js";

export type CreateSessionCommand = CreateSessionInput;

export interface ForkSessionCommand {
  beforeMessageId?: string;
  afterMessageId?: string;
}

export interface UpdateSessionCommand {
  title?: string;
  agent?: string | null;
  metadata?: Record<string, unknown>;
}

export interface SessionCommandStoreOperations {
  createSession(input: CreateSessionInput): SessionRecord;
  getSession(sessionId: string): SessionRecord | null | undefined;
  updateSession(sessionId: string, input: {
    title?: string;
    model?: string;
    agent?: string | null;
    metadata?: Record<string, unknown>;
  }): SessionRecord;
  archiveSession(sessionId: string): SessionRecord;
  beginArchive(sessionId: string): SessionRecord;
  listChildSessions(sessionId: string, options?: { includeArchived?: boolean }): SessionRecord[];
  deleteSessionTree(sessionId: string): string[];
  forkSessionWithHistory(input: {
    sourceSessionId: string;
    beforeMessageId?: string;
    afterMessageId?: string;
    session: CreateSessionInput;
  }): SessionRecord;
}

export interface SessionCommandTransactions {
  transaction<T>(work: () => T): T;
  createMessage(input: {
    sessionId: string;
    role: SessionMessageRole;
    metadata?: Record<string, unknown>;
  }): SessionMessageRecord;
  upsertMessagePart(input: UpsertMessagePartInput): SessionMessagePartRecord;
}

export interface SessionCommandRuntimeControl {
  closeAgent(sessionId: string): Promise<void>;
  hasActiveWorkForSession(sessionId: string): boolean;
  interruptSession(sessionId: string): { activeRunId?: string; queuedRunIds: string[] };
  waitForRuns(runIds: string[]): Promise<void>;
  hasRunWork(sessionId: string): boolean;
  interruptLiveChild(sessionId: string, reason: string): Promise<boolean>;
  hasLiveChild(sessionId: string): boolean;
  warmSession?(session: Pick<SessionRecord, "id" | "cwd">): void;
}

export interface SessionCommandOperationGate {
  tryEnterBarrier(
    target: { kind: "session"; sessionId: string; cwd: string },
    predicate: () => boolean,
    descriptor?: { operationId: string; operationName: string; startedAt: number },
  ): { release(): void } | null | undefined;
}

export interface SessionCommandEvents {
  checkpoint(): number;
  publishSince(checkpoint: number): void;
}

export interface SessionCommandServiceOptions {
  sessions: SessionCommandStoreOperations;
  transactions: SessionCommandTransactions;
  runtimeControl: SessionCommandRuntimeControl;
  operationGate: SessionCommandOperationGate;
  events: SessionCommandEvents;
  contextUsageCache?: { invalidate(sessionId: string): void };
  assertReady?: () => void;
}

function readRuntimeMetadata(
  metadata: Record<string, unknown>,
): { model?: unknown } {
  const runtime = metadata.runtime;
  return typeof runtime === "object" && runtime !== null ? runtime : {};
}

function patchSessionRuntimeMetadata(
  metadata: Record<string, unknown>,
  patch: { model?: string },
): Record<string, unknown> {
  const currentRuntime = readRuntimeMetadata(metadata);
  return {
    ...metadata,
    runtime: {
      ...currentRuntime,
      ...(patch.model ? { model: patch.model } : {}),
    },
  };
}

function mergeSessionMetadata(
  existing: Record<string, unknown> | undefined,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...(existing ?? {}), ...patch };
  if (patch.runtime !== undefined) {
    next.runtime = {
      ...readRuntimeMetadata(existing ?? {}),
      ...readRuntimeMetadata(patch),
    };
  }
  return next;
}

function forkSessionMetadata(
  existing: Record<string, unknown> | undefined,
  fork: {
    sourceSessionId: string;
    beforeMessageId?: string;
    afterMessageId?: string;
  },
): Record<string, unknown> {
  const next: Record<string, unknown> = {
    ...(existing ?? {}),
    fork: {
      ...fork,
      createdAt: Date.now(),
    },
  };
  if (isRecord(next.desktop)) {
    const desktop = { ...next.desktop };
    delete desktop.pinnedAt;
    next.desktop = desktop;
  }
  return next;
}

export class SessionCommandService {
  private readonly archivePromises = new Map<string, Promise<SessionRecord>>();

  constructor(private readonly options: SessionCommandServiceOptions) {}

  private assertReady(): void {
    this.options.assertReady?.();
  }

  createSession(input: CreateSessionCommand): SessionRecord {
    this.assertReady();
    const before = this.options.events.checkpoint();
    const runtime = readRuntimeMetadata(input.metadata ?? {});
    const model = typeof runtime.model === "string" ? runtime.model : input.model;
    const session = this.options.sessions.createSession({
      ...input,
      model,
      metadata: patchSessionRuntimeMetadata(input.metadata ?? {}, { model }),
    });
    this.options.runtimeControl.warmSession?.(session);
    this.options.events.publishSince(before);
    return session;
  }

  forkSession(sessionId: string, input: ForkSessionCommand = {}): SessionRecord {
    this.assertReady();
    const source = this.options.sessions.getSession(sessionId);
    if (!source) throw new SessionApplicationError(404, `Session not found: ${sessionId}`);

    const before = this.options.events.checkpoint();
    const metadata = forkSessionMetadata(source.metadata, {
      sourceSessionId: source.id,
      ...(input.beforeMessageId ? { beforeMessageId: input.beforeMessageId } : {}),
      ...(input.afterMessageId ? { afterMessageId: input.afterMessageId } : {}),
    });
    let fork: SessionRecord;
    try {
      fork = this.options.sessions.forkSessionWithHistory({
        sourceSessionId: source.id,
        ...(input.beforeMessageId ? { beforeMessageId: input.beforeMessageId } : {}),
        ...(input.afterMessageId ? { afterMessageId: input.afterMessageId } : {}),
        session: {
          parentId: source.id,
          ...(source.projectId ? { projectId: source.projectId } : {}),
          cwd: source.cwd,
          title: source.title ? `${source.title} fork` : "",
          model: source.model,
          ...(source.agent ? { agent: source.agent } : {}),
          metadata,
        },
      });
    } catch (error) {
      if (error instanceof Error && error.message === "Fork point not found") {
        throw new SessionApplicationError(404, error.message);
      }
      throw error;
    }
    this.options.runtimeControl.warmSession?.(fork);
    this.options.events.publishSince(before);
    return this.options.sessions.getSession(fork.id) ?? fork;
  }

  async updateSession(
    sessionId: string,
    input: UpdateSessionCommand,
  ): Promise<SessionRecord> {
    this.assertReady();
    const existing = this.options.sessions.getSession(sessionId);
    if (!existing) throw new SessionApplicationError(404, "Session not found");
    const metadata = input.metadata
      ? mergeSessionMetadata(existing.metadata, input.metadata)
      : undefined;
    const runtimeMetadataChanged =
      metadata && runtimeSessionMetadataChanged(existing.metadata, metadata);
    const runtimeConfigurationChanged = Boolean(
      runtimeMetadataChanged ||
      (input.agent !== undefined && (input.agent ?? undefined) !== existing.agent),
    );
    const lease = runtimeConfigurationChanged
      ? this.options.operationGate.tryEnterBarrier(
          { kind: "session", sessionId: existing.id, cwd: existing.cwd },
          () =>
            !this.options.runtimeControl.hasLiveChild(existing.id) &&
            !this.options.runtimeControl.hasRunWork(existing.id) &&
            !this.options.runtimeControl.hasActiveWorkForSession(existing.id),
          {
            operationId: randomUUID(),
            operationName: "修改运行时配置",
            startedAt: Date.now(),
          },
        )
      : undefined;

    if (runtimeConfigurationChanged && !lease) {
      throw new SessionApplicationError(
        409,
        "Cannot update runtime session settings while the session is active",
      );
    }

    try {
      const before = this.options.events.checkpoint();
      const nextModel = metadata
        ? readSessionRuntimeConfig({ ...existing, metadata }).model
        : undefined;
      const modelChanged = nextModel !== undefined && nextModel !== existing.model;
      const session = this.options.transactions.transaction(() => {
        const updated = this.options.sessions.updateSession(sessionId, {
          title: input.title,
          model: nextModel,
          agent: input.agent,
          metadata,
        });
        if (!modelChanged) return updated;
        const message = this.options.transactions.createMessage({
          sessionId,
          role: "system",
          metadata: {
            presentation: {
              kind: "model_switch",
              fromModel: existing.model,
              toModel: nextModel,
            },
          },
        });
        this.options.transactions.upsertMessagePart({
          sessionId,
          messageId: message.id,
          type: "text",
          status: "completed",
          text: `模型已切换 ${existing.model} → ${nextModel}`,
        });
        return updated;
      });
      if (runtimeConfigurationChanged) {
        await this.options.runtimeControl.closeAgent(sessionId);
      }
      if (modelChanged) {
        this.options.contextUsageCache?.invalidate(sessionId);
      }
      this.options.events.publishSince(before);
      return session;
    } finally {
      lease?.release();
    }
  }

  async closeRuntime(sessionId: string): Promise<void> {
    this.assertReady();
    if (await this.options.runtimeControl.interruptLiveChild(sessionId, "Session runtime closed")) {
      return;
    }
    await this.options.runtimeControl.closeAgent(sessionId);
  }

  async archiveSessionTree(sessionId: string): Promise<SessionRecord> {
    this.assertReady();
    const existing = this.archivePromises.get(sessionId);
    if (existing) return await existing;
    const archive = this.archiveSessionTreeWork(sessionId).finally(() => {
      if (this.archivePromises.get(sessionId) === archive) {
        this.archivePromises.delete(sessionId);
      }
    });
    this.archivePromises.set(sessionId, archive);
    return await archive;
  }

  async deleteSessionTree(sessionId: string): Promise<string[]> {
    this.assertReady();
    const current = this.options.sessions.getSession(sessionId);
    if (!current) throw new SessionApplicationError(404, `Session not found: ${sessionId}`);
    const lease = this.options.operationGate.tryEnterBarrier(
      { kind: "session", sessionId, cwd: current.cwd },
      () => true,
      {
        operationId: randomUUID(),
        operationName: "删除会话",
        startedAt: Date.now(),
      },
    );
    if (!lease) throw new SessionApplicationError(409, "Session is busy with another operation");
    try {
      if (current.status !== "archived" && current.status !== "closing") {
        this.options.sessions.beginArchive(sessionId);
      }
      const interrupted = this.options.runtimeControl.interruptSession(sessionId);
      const liveInterrupt = this.options.runtimeControl.interruptLiveChild(
        sessionId,
        "Session deleted",
      );
      const children = this.options.sessions.listChildSessions(sessionId, {
        includeArchived: true,
      });
      await liveInterrupt;
      const deletedChildIds: string[] = [];
      for (const child of children) {
        deletedChildIds.push(...(await this.deleteSessionTree(child.id)));
      }
      const interruptedRunIds = [interrupted.activeRunId, ...interrupted.queuedRunIds].filter(
        (runId): runId is string => !!runId,
      );
      await this.options.runtimeControl.waitForRuns(interruptedRunIds);
      await this.options.runtimeControl.closeAgent(sessionId);
      return [...deletedChildIds, ...this.options.sessions.deleteSessionTree(sessionId)];
    } finally {
      lease.release();
    }
  }

  private async archiveSessionTreeWork(sessionId: string): Promise<SessionRecord> {
    const beforeClosing = this.options.events.checkpoint();
    const current = this.options.sessions.getSession(sessionId);
    if (!current) throw new SessionApplicationError(404, `Session not found: ${sessionId}`);
    if (current.status === "archived") return current;
    const lease = this.options.operationGate.tryEnterBarrier(
      { kind: "session", sessionId, cwd: current.cwd },
      () => true,
      {
        operationId: randomUUID(),
        operationName: "归档会话",
        startedAt: Date.now(),
      },
    );
    if (!lease) throw new SessionApplicationError(409, "Session is busy with another operation");
    try {
      this.options.sessions.beginArchive(sessionId);
      this.options.events.publishSince(beforeClosing);
      const interrupted = this.options.runtimeControl.interruptSession(sessionId);
      const liveInterrupt = this.options.runtimeControl.interruptLiveChild(
        sessionId,
        "Session archived",
      );

      const children = this.options.sessions.listChildSessions(sessionId);
      await liveInterrupt;
      for (const child of children) await this.archiveSessionTree(child.id);
      const interruptedRunIds = [interrupted.activeRunId, ...interrupted.queuedRunIds].filter(
        (runId): runId is string => !!runId,
      );
      await this.options.runtimeControl.waitForRuns(interruptedRunIds);
      await this.options.runtimeControl.closeAgent(sessionId);
      const before = this.options.events.checkpoint();
      const session = this.options.sessions.archiveSession(sessionId);
      this.options.events.publishSince(before);
      return session;
    } finally {
      lease.release();
    }
  }
}
