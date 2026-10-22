import { expect, it, vi } from "vitest";
import { sessionCreateInput, sessionForkInput, sessionUpdateInput, sessionClearWorktreeInput } from "./session.js";
import { pluginAppToolInput, pluginAppConversationInput } from "./plugin-apps.js";
import { createSystemRoutes, type SystemRoutesContext } from "../routes/system.js";
import { createMaintenanceRoutes } from "../routes/maintenance.js";
import type { MaintenanceApplicationService } from "../../application/maintenance/maintenance-application-service.js";
import { createSessionPluginAppsRoutes } from "../routes/session-plugin-apps.js";
import type { assemblePluginApps } from "../../application/session/plugin-app-assembly.js";
import type { PluginAppConversationService } from "../../application/session/plugin-app-conversation-service.js";

it("publishes only execution observation DTO fields at every fixed level", async () => {
  const internal = { schemaVersion: 1, generatedAt: 1, internalPath: "/private", filters: { sessionId: "s", internalQuery: "secret" }, summary: {},
    records: [{ schemaVersion: 1, executionKind: "root_agent_run", executionId: "r", outcome: "completed", completeness: "complete", internalPrompt: "secret",
      usage: { inputTokens: 3, completeness: "complete", providerSecret: "secret" }, source: { kind: "session_run", id: "r", backingHandle: "secret" } }],
    warnings: [{ code: "partial_usage", sourceId: "r", internalError: "secret" }] };
  const app = createSystemRoutes({ control: { queryExecutionObservations: () => internal } } as unknown as SystemRoutesContext);
  const response = await app.request("/debug/executions");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ schemaVersion: 1, generatedAt: 1, filters: { sessionId: "s" }, summary: {}, records: [{ schemaVersion: 1,
    executionKind: "root_agent_run", executionId: "r", outcome: "completed", completeness: "complete", usage: { inputTokens: 3, completeness: "complete" }, source: { kind: "session_run", id: "r" } }],
    warnings: [{ code: "partial_usage", sourceId: "r" }] });
});

it("removes maintenance implementation details without changing public report fields", async () => {
  const preview = { id: "p", createdAt: 1, olderThan: 2, candidates: [{ id: "s", kind: "session", label: "Session", updatedAt: 1, bytes: 7, queryHandle: "secret" }],
    protected: [{ id: "s2", reason: "active", privateOwner: "secret" }], bytes: 7, scope: "all", internalPlan: "secret" };
  const app = createMaintenanceRoutes({ maintenance: { requireWriteReady() {}, previewCleanup: async () => preview } as unknown as MaintenanceApplicationService });
  const response = await app.request("/maintenance/cleanup/preview", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ id: "p", createdAt: 1, olderThan: 2, candidates: [{ id: "s", kind: "session", label: "Session", updatedAt: 1, bytes: 7 }],
    protected: [{ id: "s2", reason: "active" }], bytes: 7, scope: "all" });
});

it("rejects a body claiming another route source before invoking an app tool", async () => {
  const invoke = vi.fn();
  const app = createSessionPluginAppsRoutes({ actions: { invoke } } as unknown as ReturnType<typeof assemblePluginApps>, {} as PluginAppConversationService);
  const response = await app.request("/owner/plugin-apps/app/actions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    source: { sessionId: "other", appId: "app" }, lease: { token: "t", backendGeneration: "g" }, requestId: "r", expectedRevision: 0, toolName: "save", args: {} }) });
  expect(response.status).toBe(400);
  expect(invoke).not.toHaveBeenCalled();
});

it("selects application intent fields and constructs plugin identity from the checked route", () => {
  const create = { cwd: "/repo", model: "m", storage: "memory" as const, metadata: { custom: true }, futureTransportField: "discard" };
  expect(sessionCreateInput(create)).toEqual({ cwd: "/repo", model: "m", storage: "memory", metadata: { custom: true } });
  expect(sessionForkInput({ copyHistory: false, futureTransportField: "discard" } as Parameters<typeof sessionForkInput>[0])).toEqual({ copyHistory: false });
  expect(sessionUpdateInput({ agent: null, futureTransportField: "discard" } as Parameters<typeof sessionUpdateInput>[0])).toEqual({ agent: null });
  expect(sessionClearWorktreeInput({ id: "w", path: "/repo", branch: "work", futureTransportField: "discard" } as Parameters<typeof sessionClearWorktreeInput>[0])).toEqual({ id: "w", path: "/repo", branch: "work" });
  const source = { sessionId: "owner", appId: "route-app" };
  const request = { source: { sessionId: "claimed", appId: "claimed" }, lease: { token: "t", backendGeneration: "g", clientHint: "discard" },
    requestId: "r", expectedRevision: 2, toolName: "save", args: { value: "keep" }, futureTransportField: "discard" };
  expect(pluginAppToolInput(source, request)).toEqual({ source, lease: { token: "t", backendGeneration: "g" }, requestId: "r", expectedRevision: 2, toolName: "save", args: { value: "keep" } });
  expect(pluginAppConversationInput(source, { ...request, text: "hello", data: { value: "keep" } })).toEqual({ source, lease: { token: "t", backendGeneration: "g" }, requestId: "r", expectedRevision: 2, text: "hello", data: { value: "keep" } });
});

it("maps nested usage and backup summaries without exposing additional service fields", async () => {
  const price = { provider: "p", model: "m", currency: "USD", source: "manual", adoptedAt: 1, inputPerMillion: 1, outputPerMillion: 2,
    cacheReadPerMillion: 0, cacheCreationPerMillion: 0, subscription: false, providerKey: "secret" };
  const usage = { scannedAt: 1, requests: [{ id: "q", time: 1, project: "p", sessionId: "s", runId: "r", provider: "p", model: "m", status: "completed", completeness: "complete",
    inputTokens: 2, outputTokens: 3, cacheReadTokens: null, cacheCreationTokens: null, cost: { amount: 1, currency: "USD", kind: "estimate", source: "manual", adoptedAt: 1, price, invoice: "secret" }, rawPrompt: "secret" }],
    warnings: ["partial"], options: { projects: ["p"], providers: ["p"], models: ["m"], privateIndex: "secret" },
    totals: { requests: 1, unknown: 0, partial: 0, input: 2, output: 3, cacheRead: 0, cacheCreation: 0, costs: { USD: 1 }, trace: "secret" },
    settings: { version: 1, prices: [price], budget: { enabled: false, tokens: null, amount: null, currency: "USD", lock: "secret" }, secret: "secret" }, internal: "secret" };
  const storage = { scannedAt: 1, dataDirectory: "/data", totalBytes: 9, availableBytes: 100, writable: true,
    categories: [{ id: "db", name: "database", paths: ["/data/db"], bytes: 9, files: 1, errors: [], handle: "secret" }],
    backups: [{ path: "/backup", createdAt: 1, bytes: 9, manifest: { version: 3, backupId: "b", createdAt: 1, database: "database.sqlite",
      directories: { artifacts: true, memory: false, "execution-output": true, attachments: true, privateDir: "secret" },
      recovery: { reviveLiveProcesses: false, closeActiveRecordsOnStartup: true, rawState: "secret" }, privateManifest: "secret" }, handle: "secret" }], internal: "secret" };
  const app = createMaintenanceRoutes({ maintenance: { requireWriteReady() {}, readUsage: async () => usage, readStorage: async () => storage } as unknown as MaintenanceApplicationService });
  const usageResponse = await app.request("/maintenance/usage", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  expect(usageResponse.status).toBe(200);
  const usageBody = await usageResponse.json();
  expect(JSON.stringify(usageBody)).not.toContain("secret");
  expect(usageBody).toMatchObject({ scannedAt: 1, requests: [{ id: "q", inputTokens: 2, outputTokens: 3, cost: { amount: 1, price: { provider: "p", model: "m" } } }], totals: { costs: { USD: 1 } } });
  const storageResponse = await app.request("/maintenance/storage");
  expect(storageResponse.status).toBe(200);
  const storageBody = await storageResponse.json();
  expect(JSON.stringify(storageBody)).not.toContain("secret");
  expect(storageBody).toMatchObject({ totalBytes: 9, categories: [{ id: "db", paths: ["/data/db"] }], backups: [{ path: "/backup", manifest: { backupId: "b", directories: { attachments: true } } }] });
});
