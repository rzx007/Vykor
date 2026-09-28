import { randomUUID } from "node:crypto";
import type { McpRuntimeSyncResult } from "@vykor/core";
import {
  McpOAuthApplicationError,
  type McpOAuthApplicationService,
} from "./mcp-oauth-application-service.js";

export type OAuthOperationState = "pending" | "completed" | "failed" | "cancelled";
export type OAuthCallbackMode = "local" | "manual";

export const MCP_OAUTH_LOGIN_UPDATED_EVENT = "mcp.oauth.login.updated";
export const MCP_OAUTH_LOGIN_COMPLETED_EVENT = "mcp.oauth.login.completed";

/** Secret-free operation view. `authorizationUrl` is only added to authenticated GET responses. */
export interface OAuthOperationView {
  loginId: string;
  name: string;
  state: OAuthOperationState;
  credentialCommitted: boolean;
  authorizationReady: boolean;
  errorCode?: string;
  runtimeSync?: McpRuntimeSyncResult;
}

export interface OAuthOperationEventData {
  loginId: string;
  name: string;
  state: OAuthOperationState;
  credentialCommitted: boolean;
  authorizationReady: boolean;
  errorCode?: string;
  runtimeSync?: McpRuntimeSyncResult;
}

export interface OAuthOperationEvent {
  event: typeof MCP_OAUTH_LOGIN_UPDATED_EVENT | typeof MCP_OAUTH_LOGIN_COMPLETED_EVENT;
  data: OAuthOperationEventData;
}

export type McpOAuthOperationErrorCode =
  | "oauth-instance-conflict"
  | "oauth-request-conflict"
  | "oauth-operation-busy"
  | "oauth-operation-limit"
  | "oauth-operation-not-found"
  | "oauth-operation-not-pending"
  | "oauth-callback-not-manual"
  | "oauth-callback-not-ready"
  | "oauth-callback-invalid"
  | "oauth-operation-closing";

export class McpOAuthOperationError extends Error {
  constructor(readonly code: McpOAuthOperationErrorCode, message: string) {
    super(message);
    this.name = "McpOAuthOperationError";
  }
}

export interface McpOAuthBeginInput {
  oauthInstanceId: string;
  requestId: string;
  name: string;
  scopes?: string[];
  callbackMode: OAuthCallbackMode;
}

export interface McpOAuthBeginResult {
  view: OAuthOperationView;
  replayed: boolean;
}

export interface McpOAuthOperationServiceOptions {
  application: Pick<McpOAuthApplicationService, "beginLogin">;
  clock?: () => number;
  idFactory?: () => string;
  instanceId?: string;
  maxPending?: number;
  maxTotal?: number;
  pendingTimeoutMs?: number;
  terminalRetentionMs?: number;
  warn?(message: string): void;
}

interface ManualInput {
  promise: Promise<string>;
  resolve(value: string): void;
  reject(error: unknown): void;
}

interface OperationRecord {
  loginId: string;
  name: string;
  requestId: string;
  fingerprint: string;
  callbackMode: OAuthCallbackMode;
  state: OAuthOperationState;
  credentialCommitted: boolean;
  authorizationUrl?: string;
  errorCode?: string;
  runtimeSync?: McpRuntimeSyncResult;
  controller: AbortController;
  manual?: ManualInput;
  submission?: { resolve(): void; reject(error: unknown): void };
  subscribers: Set<(event: OAuthOperationEvent) => void>;
  createdAt: number;
  settledAt?: number;
  timer?: NodeJS.Timeout;
  settle: () => void;
  settled: Promise<void>;
  finished: boolean;
}

const DEFAULTS = {
  maxPending: 20,
  maxTotal: 100,
  pendingTimeoutMs: 5 * 60_000,
  terminalRetentionMs: 10 * 60_000,
};

/**
 * Bounded, in-memory OAuth login operations for one daemon instance.
 *
 * Operations never persist an authorization URL, PKCE verifier or event log.
 * Each operation owns its AbortController, its manual-callback input and its
 * subscriber set; every public view is produced by one safe mapper.
 */
export class McpOAuthOperationService {
  readonly oauthInstanceId: string;
  private readonly operations = new Map<string, OperationRecord>();
  private readonly clock: () => number;
  private readonly idFactory: () => string;
  private readonly limits: typeof DEFAULTS;
  private closing = false;

  constructor(private readonly options: McpOAuthOperationServiceOptions) {
    this.clock = options.clock ?? (() => Date.now());
    this.idFactory = options.idFactory ?? (() => randomUUID());
    this.oauthInstanceId = options.instanceId ?? randomUUID();
    this.limits = {
      maxPending: options.maxPending ?? DEFAULTS.maxPending,
      maxTotal: options.maxTotal ?? DEFAULTS.maxTotal,
      pendingTimeoutMs: options.pendingTimeoutMs ?? DEFAULTS.pendingTimeoutMs,
      terminalRetentionMs: options.terminalRetentionMs ?? DEFAULTS.terminalRetentionMs,
    };
  }

  begin(input: McpOAuthBeginInput): McpOAuthBeginResult {
    if (this.closing) throw new McpOAuthOperationError("oauth-operation-closing", "MCP OAuth operations are closing");
    if (input.oauthInstanceId !== this.oauthInstanceId) {
      throw new McpOAuthOperationError("oauth-instance-conflict", "MCP OAuth instance changed; start the authorization again");
    }
    this.purgeExpired();

    const fingerprint = fingerprintInput(input);
    const existing = this.findByRequestId(input.requestId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new McpOAuthOperationError("oauth-request-conflict", "The same requestId was used with different input");
      }
      return { view: this.toView(existing), replayed: true };
    }

    if ([...this.operations.values()].some((record) => record.name === input.name && record.state === "pending")) {
      throw new McpOAuthOperationError("oauth-operation-busy", `An MCP OAuth login is already pending for ${input.name}`);
    }
    if (this.pendingCount() >= this.limits.maxPending) {
      throw new McpOAuthOperationError("oauth-operation-busy", "Too many pending MCP OAuth operations");
    }
    if (this.operations.size >= this.limits.maxTotal) {
      throw new McpOAuthOperationError("oauth-operation-limit", "MCP OAuth operation cache is full");
    }

    const record = this.createRecord(input, fingerprint);
    this.operations.set(record.loginId, record);
    void this.run(record, input);
    return { view: this.toView(record), replayed: false };
  }

  get(loginId: string): OAuthOperationView | undefined {
    this.purgeExpired();
    const record = this.operations.get(loginId);
    return record ? this.toView(record) : undefined;
  }

  /** Only for the authenticated GET response; never sent over SSE. */
  authorizationUrl(loginId: string): string | undefined {
    this.purgeExpired();
    return this.operations.get(loginId)?.authorizationUrl;
  }

  subscribe(loginId: string, listener: (event: OAuthOperationEvent) => void): () => void {
    this.purgeExpired();
    const record = this.operations.get(loginId);
    if (!record) throw new McpOAuthOperationError("oauth-operation-not-found", "MCP OAuth operation was not found");
    // Register before reading the state so no terminal transition is missed.
    record.subscribers.add(listener);
    if (record.state === "pending") {
      listener(updatedEvent(record));
    } else {
      listener(completedEvent(record));
      record.subscribers.delete(listener);
    }
    return () => record.subscribers.delete(listener);
  }

  async submitCallback(loginId: string, callbackUrl: string): Promise<OAuthOperationView> {
    this.purgeExpired();
    const record = this.operations.get(loginId);
    if (!record) throw new McpOAuthOperationError("oauth-operation-not-found", "MCP OAuth operation was not found");
    if (record.state !== "pending") {
      throw new McpOAuthOperationError("oauth-operation-not-pending", "MCP OAuth operation already finished");
    }
    if (record.callbackMode !== "manual") {
      throw new McpOAuthOperationError("oauth-callback-not-manual", "This operation does not accept a submitted callback");
    }
    if (!record.manual || record.submission) {
      throw new McpOAuthOperationError("oauth-callback-not-ready", "This operation is not waiting for a callback");
    }
    const accepted = new Promise<void>((resolve, reject) => { record.submission = { resolve, reject }; });
    const manual = record.manual;
    record.manual = undefined;
    manual.resolve(callbackUrl);
    await accepted;
    return this.toView(record);
  }

  async cancel(loginId: string): Promise<OAuthOperationView | undefined> {
    this.purgeExpired();
    const record = this.operations.get(loginId);
    if (!record) return undefined;
    if (record.state === "pending") {
      record.controller.abort(new McpOAuthOperationError("oauth-operation-not-pending", "MCP OAuth login was cancelled"));
    }
    await record.settled;
    return this.toView(record);
  }

  /** Stop accepting, abort uncommitted work and wait for commit regions to settle. */
  async close(): Promise<void> {
    this.closing = true;
    for (const record of this.operations.values()) {
      if (record.state === "pending") {
        record.controller.abort(new McpOAuthOperationError("oauth-operation-closing", "MCP OAuth operations are closing"));
      }
    }
    await Promise.all([...this.operations.values()].map((record) => record.settled));
    for (const record of this.operations.values()) if (record.timer) clearTimeout(record.timer);
  }

  private createRecord(input: McpOAuthBeginInput, fingerprint: string): OperationRecord {
    const controller = new AbortController();
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => { settle = resolve; });
    const record: OperationRecord = {
      loginId: this.idFactory(),
      name: input.name,
      requestId: input.requestId,
      fingerprint,
      callbackMode: input.callbackMode,
      state: "pending",
      credentialCommitted: false,
      controller,
      subscribers: new Set(),
      createdAt: this.clock(),
      settle,
      settled,
      finished: false,
    };
    return record;
  }

  private async run(record: OperationRecord, input: McpOAuthBeginInput): Promise<void> {
    record.timer = setTimeout(() => {
      record.controller.abort(new McpOAuthOperationError("oauth-operation-not-pending", "MCP OAuth login timed out"));
    }, this.limits.pendingTimeoutMs);
    record.timer.unref?.();
    try {
      const outcome = await this.options.application.beginLogin({
        name: record.name,
        scopes: input.scopes ?? [],
        openBrowser: async () => undefined,
        noBrowser: record.callbackMode === "manual",
        onAuthorizationUrl: (url) => {
          if (record.state !== "pending") return;
          record.authorizationUrl = url;
          this.emit(record, updatedEvent(record));
        },
        ...(record.callbackMode === "manual" ? {
          readCallbackUrl: () => {
            record.manual = createManualInput();
            return record.manual.promise;
          },
          onCallbackAccepted: () => {
            record.submission?.resolve();
            record.submission = undefined;
          },
          onCallbackRejected: () => {
            record.submission?.reject(new McpOAuthOperationError("oauth-callback-invalid", "OAuth callback is invalid; submit the correct callback URL"));
            record.submission = undefined;
          },
        } : {}),
        signal: record.controller.signal,
      });
      if (record.state === "pending") {
        record.state = "completed";
        record.credentialCommitted = outcome.credentialCommitted;
        record.runtimeSync = outcome.runtimeSync;
      }
    } catch (error) {
      if (record.state === "pending") {
        if (record.controller.signal.aborted || isCancellation(error)) {
          record.state = "cancelled";
        } else {
          record.state = "failed";
          record.errorCode = stableErrorCode(error);
        }
      }
    } finally {
      this.finish(record);
    }
  }

  private finish(record: OperationRecord): void {
    if (record.finished) return;
    record.finished = true;
    record.settledAt = this.clock();
    if (record.timer) clearTimeout(record.timer);
    record.authorizationUrl = undefined;
    record.timer = setTimeout(() => this.operations.delete(record.loginId), this.limits.terminalRetentionMs);
    record.timer.unref?.();
    record.manual?.reject(new McpOAuthOperationError("oauth-operation-not-pending", "MCP OAuth operation finished"));
    record.manual = undefined;
    record.submission?.reject(new McpOAuthOperationError("oauth-operation-not-pending", "MCP OAuth operation finished"));
    record.submission = undefined;
    this.emit(record, completedEvent(record));
    record.subscribers.clear();
    record.settle();
  }

  private emit(record: OperationRecord, event: OAuthOperationEvent): void {
    for (const listener of [...record.subscribers]) {
      try {
        listener(event);
      } catch {
        this.options.warn?.("MCP OAuth subscriber failed");
      }
    }
  }

  private toView(record: OperationRecord): OAuthOperationView {
    return {
      loginId: record.loginId,
      name: record.name,
      state: record.state,
      credentialCommitted: record.credentialCommitted,
      authorizationReady: record.authorizationUrl !== undefined,
      ...(record.errorCode ? { errorCode: record.errorCode } : {}),
      ...(record.runtimeSync ? { runtimeSync: record.runtimeSync } : {}),
    };
  }

  private findByRequestId(requestId: string): OperationRecord | undefined {
    for (const record of this.operations.values()) {
      if (record.requestId === requestId) return record;
    }
    return undefined;
  }

  private pendingCount(): number {
    let count = 0;
    for (const record of this.operations.values()) if (record.state === "pending") count += 1;
    return count;
  }

  private purgeExpired(): void {
    const now = this.clock();
    for (const [loginId, record] of this.operations) {
      if (record.state === "pending") continue;
      if (record.settledAt !== undefined && now - record.settledAt >= this.limits.terminalRetentionMs) {
        if (record.timer) clearTimeout(record.timer);
        this.operations.delete(loginId);
      }
    }
  }
}

function updatedEvent(record: OperationRecord): OAuthOperationEvent {
  return { event: MCP_OAUTH_LOGIN_UPDATED_EVENT, data: eventData(record, false) };
}

function completedEvent(record: OperationRecord): OAuthOperationEvent {
  return { event: MCP_OAUTH_LOGIN_COMPLETED_EVENT, data: eventData(record, true) };
}

function eventData(record: OperationRecord, includeRuntime: boolean): OAuthOperationEventData {
  return {
    loginId: record.loginId,
    name: record.name,
    state: record.state,
    credentialCommitted: record.credentialCommitted,
    authorizationReady: record.authorizationUrl !== undefined,
    ...(record.errorCode ? { errorCode: record.errorCode } : {}),
    ...(includeRuntime && record.runtimeSync ? { runtimeSync: record.runtimeSync } : {}),
  };
}

function fingerprintInput(input: McpOAuthBeginInput): string {
  return JSON.stringify({
    name: input.name,
    callbackMode: input.callbackMode,
    scopes: [...new Set(input.scopes ?? [])].sort(),
  });
}

function stableErrorCode(error: unknown): string {
  if (error instanceof McpOAuthApplicationError) return error.code;
  return "oauth-login-failed";
}

function isCancellation(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function createManualInput(): ManualInput {
  let resolve!: (value: string) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}
