import { randomUUID } from "node:crypto";
import type {
  CreateSessionInput,
  SessionMessagePartRecord,
  SessionMessageRecord,
  SessionMessageRole,
  SessionRecord,
  UpsertMessagePartInput,
} from "@vykor/protocol";
import {
  changedSessionRuntimeKeys,
  readSessionRuntimeConfig,
  readSessionRuntimeRevision,
} from "@vykor/protocol";
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
  validateRequestSelection?: (input: {
    session: SessionRecord;
    next: ReturnType<typeof readSessionRuntimeConfig>;
    explicitEffort: boolean;
  }) => Promise<{ effort?: string }>;
  assertReady?: () => void;
}

const LIVE_REQUEST_CONFIGURATION_KEYS = new Set([
  "model",
  "provider",
  "baseUrl",
  "apiFormat",
  "effort",
  "maxTurns",
  "systemPrompt",
]);
const MODEL_REQUEST_CONFIGURATION_KEYS = new Set([
  "model", "provider", "baseUrl", "apiFormat", "effort",
]);

function isLiveRequestConfigurationChange(
  session: SessionRecord,
  metadata: Record<string, unknown> | undefined,
): boolean {
  if (!metadata) return false;
  const before = readSessionRuntimeConfig(session);
  const after = readSessionRuntimeConfig({ ...session, metadata });
  const changed = changedSessionRuntimeKeys(before, after);
  return changed.length > 0 && changed.every((key) => LIVE_REQUEST_CONFIGURATION_KEYS.has(key));
}

function readRuntimeMetadata(
  metadata: Record<string, unknown>,
): {
  model?: unknown;
  provider?: unknown;
  baseUrl?: unknown;
  effort?: unknown;
  maxTurns?: unknown;
  systemPrompt?: unknown;
} {
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
  const {
    runtimeRevision: _revision,
    appliedRequestModel: _appliedModel,
    runtimeDefaultFields: _defaultFields,
    ...safePatch
  } = patch;
  const next = { ...(existing ?? {}), ...safePatch };
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
  private readonly updateQueues = new Map<string, Promise<void>>();

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
    const previous = this.updateQueues.get(sessionId) ?? Promise.resolve();
    const update = previous.then(
      () => this.updateSessionWork(sessionId, input),
      () => this.updateSessionWork(sessionId, input),
    );
    const settled = update.then(() => undefined, () => undefined);
    this.updateQueues.set(sessionId, settled);
    void settled.then(() => {
      if (this.updateQueues.get(sessionId) === settled) {
        this.updateQueues.delete(sessionId);
      }
    });
    return await update;
  }

  private async updateSessionWork(
    sessionId: string,
    input: UpdateSessionCommand,
  ): Promise<SessionRecord> {
    this.assertReady();
    const existing = this.options.sessions.getSession(sessionId);
    if (!existing) throw new SessionApplicationError(404, "Session not found");
    if (existing.status === "closing" || existing.status === "archived") {
      throw new SessionApplicationError(409, "Session is not accepting updates");
    }
    let mergedMetadata = input.metadata
      ? mergeSessionMetadata(existing.metadata, input.metadata)
      : undefined;
    if (mergedMetadata) {
      const incomingRuntime = readRuntimeMetadata(input.metadata ?? {});
      if (Object.prototype.hasOwnProperty.call(incomingRuntime, "effort")) {
        const defaults = existing.metadata.runtimeDefaultFields;
        if (Array.isArray(defaults)) {
          mergedMetadata = {
            ...mergedMetadata,
            runtimeDefaultFields: defaults.filter((field) => field !== "effort"),
          };
        }
      }
      if (Object.prototype.hasOwnProperty.call(incomingRuntime, "maxTurns")) {
        if (typeof incomingRuntime.maxTurns !== "number"
          || !Number.isSafeInteger(incomingRuntime.maxTurns)
          || incomingRuntime.maxTurns <= 0) {
          throw new SessionApplicationError(400, "maxTurns must be a positive safe integer");
        }
        const defaults = existing.metadata.runtimeDefaultFields;
        if (Array.isArray(defaults)) {
          mergedMetadata = {
            ...mergedMetadata,
            runtimeDefaultFields: defaults.filter((field) => field !== "maxTurns"),
          };
        }
      }
      if (Object.prototype.hasOwnProperty.call(incomingRuntime, "systemPrompt")) {
        const defaults = existing.metadata.runtimeDefaultFields;
        if (Array.isArray(defaults)) {
          mergedMetadata = {
            ...mergedMetadata,
            runtimeDefaultFields: defaults.filter((field) => field !== "systemPrompt"),
          };
        }
      }
      const provider = incomingRuntime.provider;
      const previousProvider = readSessionRuntimeConfig(existing).provider;
      if (typeof provider === "string" && provider !== previousProvider
        && !Object.prototype.hasOwnProperty.call(incomingRuntime, "baseUrl")) {
        mergedMetadata = {
          ...mergedMetadata,
          runtime: { ...readRuntimeMetadata(mergedMetadata), baseUrl: "" },
        };
      }
    }
    if (mergedMetadata && this.options.validateRequestSelection) {
      const changed = changedSessionRuntimeKeys(
        readSessionRuntimeConfig(existing),
        readSessionRuntimeConfig({ ...existing, metadata: mergedMetadata }),
      );
      if (changed.some((key) => MODEL_REQUEST_CONFIGURATION_KEYS.has(key))) {
        const normalized = await this.options.validateRequestSelection({
          session: existing,
          next: readSessionRuntimeConfig({ ...existing, metadata: mergedMetadata }),
          explicitEffort: Object.prototype.hasOwnProperty.call(
            readRuntimeMetadata(input.metadata ?? {}), "effort",
          ),
        });
        if (normalized.effort !== undefined) {
          mergedMetadata = {
            ...mergedMetadata,
            runtime: {
              ...readRuntimeMetadata(mergedMetadata),
              effort: normalized.effort,
            },
          };
        }
      }
    }
    const runtimeMetadataChanged =
      mergedMetadata && runtimeSessionMetadataChanged(existing.metadata, mergedMetadata);
    const metadata = runtimeMetadataChanged
      ? {
          ...mergedMetadata!,
          runtimeRevision: readSessionRuntimeRevision(existing.metadata) + 1,
        }
      : mergedMetadata;
    const runtimeConfigurationChanged = Boolean(
      runtimeMetadataChanged ||
      (input.agent !== undefined && (input.agent ?? undefined) !== existing.agent),
    );
    const liveRequestConfigurationChange = input.agent === undefined
      && isLiveRequestConfigurationChange(existing, metadata);
    const lease = runtimeConfigurationChanged && !liveRequestConfigurationChange
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

    if (runtimeConfigurationChanged && !liveRequestConfigurationChange && !lease) {
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
      const showModelSwitch = modelChanged
        && !this.options.runtimeControl.hasRunWork(sessionId)
        && !this.options.runtimeControl.hasActiveWorkForSession(sessionId)
        && !this.options.runtimeControl.hasLiveChild(sessionId);
      const session = this.options.transactions.transaction(() => {
        const updated = this.options.sessions.updateSession(sessionId, {
          title: input.title,
          model: nextModel,
          agent: input.agent,
          metadata,
        });
        if (showModelSwitch && nextModel) {
          const message = this.options.transactions.createMessage({
            sessionId,
            role: "system",
            metadata: { presentation: {
              kind: "model_switch",
              fromModel: existing.model,
              toModel: nextModel,
            } },
          });
          this.options.transactions.upsertMessagePart({
            sessionId,
            messageId: message.id,
            type: "text",
            status: "completed",
            text: `模型已切换 ${existing.model} → ${nextModel}`,
          });
        }
        return updated;
      });
      if (runtimeConfigurationChanged && !liveRequestConfigurationChange) {
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
    const leases: Array<{ release(): void }> = [];
    try {
      const sessionIds = this.acquireSessionTreeDeletionBarriers(sessionId, leases);
      const interruptedRuns = new Map<string, string[]>();
      for (const id of sessionIds) {
        const interrupted = this.options.runtimeControl.interruptSession(id);
        await this.options.runtimeControl.interruptLiveChild(id, "Session deleted");
        interruptedRuns.set(
          id,
          [interrupted.activeRunId, ...interrupted.queuedRunIds].filter(
            (runId): runId is string => !!runId,
          ),
        );
      }
      for (const id of [...sessionIds].reverse()) {
        await this.options.runtimeControl.waitForRuns(interruptedRuns.get(id) ?? []);
        await this.options.runtimeControl.closeAgent(id);
      }
      const checkpoint = this.options.events.checkpoint();
      const deleted = this.options.sessions.deleteSessionTree(sessionId);
      this.options.events.publishSince(checkpoint);
      return deleted;
    } finally {
      for (const lease of leases.reverse()) lease.release();
    }
  }

  private acquireSessionTreeDeletionBarriers(
    sessionId: string,
    leases: Array<{ release(): void }>,
  ): string[] {
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
    leases.push(lease);
    const children = this.options.sessions.listChildSessions(sessionId, {
      includeArchived: true,
    });
    return [
      sessionId,
      ...children.flatMap((child) =>
        this.acquireSessionTreeDeletionBarriers(child.id, leases),
      ),
    ];
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
