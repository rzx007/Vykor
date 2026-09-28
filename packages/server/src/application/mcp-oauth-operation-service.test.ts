import { describe, expect, it, vi } from "vitest";
import type { McpOAuthCommitOutcome } from "./mcp-oauth-application-service.js";
import {
  McpOAuthOperationService,
  MCP_OAUTH_LOGIN_COMPLETED_EVENT,
  MCP_OAUTH_LOGIN_UPDATED_EVENT,
  type OAuthOperationEvent,
} from "./mcp-oauth-operation-service.js";

const OUTCOME: McpOAuthCommitOutcome = {
  credentialCommitted: true,
  runtimeSync: { status: "unavailable", affectedRuntimes: 0, failures: [] },
};

interface PendingCall {
  input: { name: string; onAuthorizationUrl?: (url: string) => void; readCallbackUrl?: (prompt: string) => Promise<string>; onCallbackAccepted?: () => void; onCallbackRejected?: (error: unknown) => void; signal?: AbortSignal };
  resolve(outcome: McpOAuthCommitOutcome): void;
  reject(error: unknown): void;
}

function createApplication() {
  const calls: PendingCall[] = [];
  const beginLogin = vi.fn((input: PendingCall["input"]) => new Promise<McpOAuthCommitOutcome>((resolve, reject) => {
    input.signal?.addEventListener("abort", () => reject(input.signal?.reason), { once: true });
    calls.push({ input, resolve, reject });
  }));
  return { beginLogin, calls };
}

function createService(options: {
  application: ReturnType<typeof createApplication>;
  clock?: () => number;
  instanceId?: string;
  maxPending?: number;
  maxTotal?: number;
  pendingTimeoutMs?: number;
  terminalRetentionMs?: number;
}): McpOAuthOperationService {
  return new McpOAuthOperationService({
    application: options.application as never,
    clock: options.clock,
    instanceId: options.instanceId,
    maxPending: options.maxPending,
    maxTotal: options.maxTotal,
    ...(options.pendingTimeoutMs !== undefined ? { pendingTimeoutMs: options.pendingTimeoutMs } : {}),
    ...(options.terminalRetentionMs !== undefined ? { terminalRetentionMs: options.terminalRetentionMs } : {}),
  });
}

describe("McpOAuthOperationService", () => {
  it("returns a pending view, keeps GET pure, and flips authorizationReady on the URL event", () => {
    const application = createApplication();
    const service = createService({ application });
    const begin = service.begin({ oauthInstanceId: service.oauthInstanceId, requestId: "r1", name: "linear", callbackMode: "local" });

    expect(begin.replayed).toBe(false);
    expect(begin.view).toMatchObject({ state: "pending", authorizationReady: false, credentialCommitted: false });

    expect(service.get(begin.view.loginId)).toEqual(service.get(begin.view.loginId));

    const events: OAuthOperationEvent[] = [];
    service.subscribe(begin.view.loginId, (event) => events.push(event));
    application.calls[0]!.input.onAuthorizationUrl?.("https://auth.example/authorize?x=1");
    expect(events.at(-1)?.event).toBe(MCP_OAUTH_LOGIN_UPDATED_EVENT);
    expect(events.at(-1)?.data.authorizationReady).toBe(true);
    expect(service.authorizationUrl(begin.view.loginId)).toBe("https://auth.example/authorize?x=1");
  });

  it("is idempotent for the same requestId and input, but rejects a changed input", () => {
    const application = createApplication();
    const service = createService({ application });
    const first = service.begin({ oauthInstanceId: service.oauthInstanceId, requestId: "r1", name: "linear", scopes: ["read"], callbackMode: "local" });
    const replay = service.begin({ oauthInstanceId: service.oauthInstanceId, requestId: "r1", name: "linear", scopes: ["read"], callbackMode: "local" });

    expect(replay.replayed).toBe(true);
    expect(replay.view.loginId).toBe(first.view.loginId);
    expect(application.beginLogin).toHaveBeenCalledTimes(1);

    expect(() => service.begin({ oauthInstanceId: service.oauthInstanceId, requestId: "r1", name: "linear", scopes: ["write"], callbackMode: "local" }))
      .toThrowError(expect.objectContaining({ code: "oauth-request-conflict" }));
  });

  it("rejects a second pending login for the same service and an unknown instance", () => {
    const application = createApplication();
    const service = createService({ application });
    service.begin({ oauthInstanceId: service.oauthInstanceId, requestId: "r1", name: "linear", callbackMode: "local" });

    expect(() => service.begin({ oauthInstanceId: service.oauthInstanceId, requestId: "r2", name: "linear", callbackMode: "local" }))
      .toThrowError(expect.objectContaining({ code: "oauth-operation-busy" }));
    expect(() => service.begin({ oauthInstanceId: "other", requestId: "r3", name: "github", callbackMode: "local" }))
      .toThrowError(expect.objectContaining({ code: "oauth-instance-conflict" }));
    expect(application.beginLogin).toHaveBeenCalledTimes(1);
  });

  it("enforces the pending and total operation limits without evicting idempotent results", async () => {
    const application = createApplication();
    const service = createService({ application, maxPending: 2, maxTotal: 3 });
    const a = service.begin({ oauthInstanceId: service.oauthInstanceId, requestId: "a", name: "a", callbackMode: "local" });
    const b = service.begin({ oauthInstanceId: service.oauthInstanceId, requestId: "b", name: "b", callbackMode: "local" });

    expect(() => service.begin({ oauthInstanceId: service.oauthInstanceId, requestId: "c", name: "c", callbackMode: "local" }))
      .toThrowError(expect.objectContaining({ code: "oauth-operation-busy" }));

    application.calls[0]!.resolve(OUTCOME);
    application.calls[1]!.resolve(OUTCOME);
    await vi.waitFor(() => expect(service.get(a.view.loginId)?.state).toBe("completed"));
    await vi.waitFor(() => expect(service.get(b.view.loginId)?.state).toBe("completed"));

    const third = service.begin({ oauthInstanceId: service.oauthInstanceId, requestId: "c", name: "c", callbackMode: "local" });
    expect(third.view.state).toBe("pending");
    expect(() => service.begin({ oauthInstanceId: service.oauthInstanceId, requestId: "d", name: "d", callbackMode: "local" }))
      .toThrowError(expect.objectContaining({ code: "oauth-operation-limit" }));
  });

  it("delivers the terminal state to subscribers that arrive after completion", async () => {
    const application = createApplication();
    const service = createService({ application });
    const begin = service.begin({ oauthInstanceId: service.oauthInstanceId, requestId: "r1", name: "linear", callbackMode: "local" });
    application.calls[0]!.resolve(OUTCOME);
    await vi.waitFor(() => expect(service.get(begin.view.loginId)?.state).toBe("completed"));

    const events: OAuthOperationEvent[] = [];
    const unsubscribe = service.subscribe(begin.view.loginId, (event) => events.push(event));
    unsubscribe();
    expect(events).toHaveLength(1);
    expect(events[0]!.event).toBe(MCP_OAUTH_LOGIN_COMPLETED_EVENT);
    expect(events[0]!.data).toMatchObject({ state: "completed", credentialCommitted: true });
    expect(events[0]!.data).not.toHaveProperty("authorizationUrl");
  });

  it("submits a manual callback into the login and completes", async () => {
    const application = createApplication();
    const service = createService({ application });
    const begin = service.begin({ oauthInstanceId: service.oauthInstanceId, requestId: "r1", name: "linear", callbackMode: "manual" });
    const manualPromise = application.calls[0]!.input.readCallbackUrl!("Paste: ");

    const submitted = service.submitCallback(begin.view.loginId, "https://app.example/callback?code=c&state=s");
    await expect(manualPromise).resolves.toBe("https://app.example/callback?code=c&state=s");
    application.calls[0]!.input.onCallbackAccepted?.();
    await submitted;

    application.calls[0]!.resolve(OUTCOME);
    await vi.waitFor(() => expect(service.get(begin.view.loginId)?.state).toBe("completed"));

    await expect(service.submitCallback(begin.view.loginId, "https://app.example/callback?code=c"))
      .rejects.toMatchObject({ code: "oauth-operation-not-pending" });
  });

  it("rejects an invalid manual input without consuming the next callback attempt", async () => {
    const application = createApplication();
    const service = createService({ application });
    const { view } = service.begin({ oauthInstanceId: service.oauthInstanceId, requestId: "r", name: "linear", callbackMode: "manual" });
    const input = application.calls[0]!.input;
    const firstRead = input.readCallbackUrl!("");
    const firstSubmit = service.submitCallback(view.loginId, "bad-callback");
    await expect(firstRead).resolves.toBe("bad-callback");
    input.onCallbackRejected?.(new Error("untrusted code=secret"));
    await expect(firstSubmit).rejects.toMatchObject({ code: "oauth-callback-invalid" });
    expect(service.get(view.loginId)?.state).toBe("pending");
    const secondRead = input.readCallbackUrl!("");
    const secondSubmit = service.submitCallback(view.loginId, "https://app.example/callback?code=valid");
    await expect(secondRead).resolves.toBe("https://app.example/callback?code=valid");
    input.onCallbackAccepted?.();
    await expect(secondSubmit).resolves.toMatchObject({ state: "pending" });
    await service.close();
  });

  it("cancels a pending operation, aborts its signal and never marks it committed", async () => {
    const application = createApplication();
    const service = createService({ application });
    const begin = service.begin({ oauthInstanceId: service.oauthInstanceId, requestId: "r1", name: "linear", callbackMode: "local" });

    const cancelled = await service.cancel(begin.view.loginId);
    expect(cancelled).toMatchObject({ state: "cancelled", credentialCommitted: false });
    expect(application.calls[0]!.input.signal?.aborted).toBe(true);
  });

  it("times out a pending operation", async () => {
    const application = createApplication();
    const service = createService({ application, pendingTimeoutMs: 5 });
    const begin = service.begin({ oauthInstanceId: service.oauthInstanceId, requestId: "r1", name: "linear", callbackMode: "local" });

    await vi.waitFor(() => expect(service.get(begin.view.loginId)?.state).toBe("cancelled"));
  });

  it("retains terminal operations for the retention window, then purges them", async () => {
    const application = createApplication();
    let now = 0;
    const service = createService({ application, clock: () => now, terminalRetentionMs: 100 });
    const begin = service.begin({ oauthInstanceId: service.oauthInstanceId, requestId: "r1", name: "linear", callbackMode: "local" });
    application.calls[0]!.resolve(OUTCOME);
    await vi.waitFor(() => expect(service.get(begin.view.loginId)?.state).toBe("completed"));

    now = 50;
    expect(service.get(begin.view.loginId)?.loginId).toBe(begin.view.loginId);
    now = 101;
    expect(service.get(begin.view.loginId)).toBeUndefined();
  });

  it("keeps runtime warnings in the query result and clears the finished authorization URL", async () => {
    const application = createApplication();
    const service = createService({ application });
    const { view } = service.begin({ oauthInstanceId: service.oauthInstanceId, requestId: "r", name: "linear", callbackMode: "local" });
    application.calls[0]!.input.onAuthorizationUrl?.("https://auth.example/?state=secret");
    application.calls[0]!.resolve({ credentialCommitted: true, runtimeSync: {
      status: "error", affectedRuntimes: 1, failures: [{ runtimeId: "runtime-1", message: "MCP runtime synchronization failed" }],
    } });
    await vi.waitFor(() => expect(service.get(view.loginId)?.state).toBe("completed"));
    expect(service.get(view.loginId)).toMatchObject({ runtimeSync: { status: "error", affectedRuntimes: 1 } });
    expect(service.authorizationUrl(view.loginId)).toBeUndefined();
  });

  it("does not publish arbitrary exception codes", async () => {
    const application = createApplication();
    const service = createService({ application });
    const { view } = service.begin({ oauthInstanceId: service.oauthInstanceId, requestId: "r", name: "linear", callbackMode: "local" });
    application.calls[0]!.reject({ code: "Bearer secret-token" });
    await vi.waitFor(() => expect(service.get(view.loginId)?.state).toBe("failed"));
    expect(service.get(view.loginId)?.errorCode).toBe("oauth-login-failed");
  });

  it("closes by aborting uncommitted operations", async () => {
    const application = createApplication();
    const service = createService({ application });
    const begin = service.begin({ oauthInstanceId: service.oauthInstanceId, requestId: "r1", name: "linear", callbackMode: "local" });

    await service.close();
    expect(service.get(begin.view.loginId)?.state).toBe("cancelled");
    expect(() => service.begin({ oauthInstanceId: service.oauthInstanceId, requestId: "r2", name: "github", callbackMode: "local" }))
      .toThrowError(expect.objectContaining({ code: "oauth-operation-closing" }));
  });
});
