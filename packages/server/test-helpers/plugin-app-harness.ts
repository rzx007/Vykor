import {hostedAgentFactory} from "./hosted-agent.js";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import * as runtime from "@vykor/agent-runtime";
import {
  CURRENT_PROTOCOL_VERSION,
  type ApprovalReviewInput,
  type ClosePluginAppInput,
  type McpCallResultData,
  type OpenPluginAppInput,
  type PluginAppActionResponse,
  type PluginAppCatalogResponse,
  type PluginAppConversationRequest,
  type PluginAppRecord,
  type PluginAppResponse,
  type PluginAppRuntimeLease,
  type PluginAppSource,
  type PluginAppSubmissionReceipt,
  type PluginAppToolRequest,
} from "@vykor/protocol";
import { updateSettings } from "@vykor/host-config";
import { SessionStore } from "@vykor/services";
import { HttpTransport, VykorClient, type HttpTransportOptions } from "../../client/src/index.js";
import { VykorHttpServer } from "../src/http/server.js";
import { installAppFixture, appFixtureSettings } from "../../agent-runtime/test-helpers/plugin-app-fixture.js";
import { createDefaultPluginService } from "../src/application/default-services/extensions/plugin-service.js";
import { createDefaultSettingsService } from "../src/application/default-services/configuration/settings-service.js";

function pluginAppHttp(transport: HttpTransport) {
  const path = (sessionId: string) => `/sessions/${encodeURIComponent(sessionId)}/plugin-apps`;
  const app = (source: PluginAppSource) => `${path(source.sessionId)}/${encodeURIComponent(source.appId)}`;
  const action = (source: PluginAppSource, requestId: string) => `${app(source)}/actions/${encodeURIComponent(requestId)}`;
  const post = <Result>(route: string, body?: unknown) => transport.request<Result>(route, { method: "POST", body });
  return {
    catalog: (sessionId: string) => transport.request<PluginAppCatalogResponse>(`${path(sessionId)}/catalog`),
    open: (sessionId: string, input: OpenPluginAppInput) => post<PluginAppResponse & { openedByRequest: boolean }>(`${path(sessionId)}/open`, input),
    prepare: (source: PluginAppSource) => post<PluginAppResponse>(`${app(source)}/prepare`),
    openToolResult: (sessionId: string, sourcePartId: string) => post<PluginAppResponse>(`${path(sessionId)}/open-tool-result`, { sourcePartId }),
    initialResult: (source: PluginAppSource, lease: PluginAppRuntimeLease, sourcePartId: string) =>
      post<{ result: McpCallResultData }>(`${app(source)}/initial-result`, { lease, sourcePartId }),
    close: (source: PluginAppSource, input: ClosePluginAppInput) => post<{ app: PluginAppRecord }>(`${app(source)}/close`, input),
    invoke: (input: PluginAppToolRequest) => post<PluginAppActionResponse>(`${app(input.source)}/actions`, input),
    getAction: (source: PluginAppSource, requestId: string) => transport.request<PluginAppActionResponse>(action(source, requestId)),
    cancelAction: (source: PluginAppSource, requestId: string) => post<PluginAppActionResponse>(`${action(source, requestId)}/cancel`),
    readResource: (source: PluginAppSource, lease: PluginAppRuntimeLease | undefined, uri: string) =>
      post<{ contents: unknown[] }>(`${app(source)}/resources/read`, { lease, uri }),
    listResources: (source: PluginAppSource, lease: PluginAppRuntimeLease | undefined, cursor?: string) =>
      post<{ resources: unknown[] }>(`${app(source)}/resources/list`, { lease, cursor }),
    listResourceTemplates: (source: PluginAppSource, lease: PluginAppRuntimeLease | undefined, cursor?: string) =>
      post<{ resourceTemplates: unknown[] }>(`${app(source)}/resource-templates/list`, { lease, cursor }),
    submitConversation: async (input: PluginAppConversationRequest) => {
      const { receipt } = await post<{ receipt: PluginAppSubmissionReceipt }>(`${app(input.source)}/conversation/submissions`, input);
      return receipt;
    },
  };
}

export async function pluginAppHarness(kind: "native-tools" | "mcp-server", modelTool = false, autosave = false, extension?: runtime.VykorAgentExtension) {
  const root = mkdtempSync(join(tmpdir(), "app-http-"));
  vi.stubEnv("VYKOR_CONFIG_DIR", join(root, "config"));
  const fixture = await installAppFixture(root, kind, undefined, modelTool, autosave);
  const reviews: ApprovalReviewInput[] = [];
  let beforeReview: (() => Promise<void>) | undefined;
  vi.spyOn(runtime, "createConfiguredApprovalReviewer").mockResolvedValue({
    review: async (input: ApprovalReviewInput) => {
      reviews.push(input); await beforeReview?.();
      return { decision: "approve", risk: "low", authorization: "task_implied", reason: "Confirmed exact app action" };
    },
  });
  let store = new SessionStore({ path: join(root, "session.db") }), modelCalls = 0;
  const settingsRef = { current: { ...structuredClone(appFixtureSettings), provider: "fixture", customProviders: [{
    id: "fixture", displayName: "Fixture", apiFormat: "openai" as const, baseUrl: "http://127.0.0.1:1/v1",
    models: [{ id: "never", displayName: "Injected test model" }],
  }] } };
  // Settings PATCH reloads durable configuration; keep the fixture provider available after reload.
  await updateSettings(() => settingsRef.current, { includeEnvironment: false });
  const boot = () => new VykorHttpServer({ store, settings: settingsRef.current, token: "app-token",
    logger: () => {}, getSettings: () => settingsRef.current,
    services: { plugin: createDefaultPluginService(settingsRef), settings: createDefaultSettingsService(settingsRef) },
    createAgent: hostedAgentFactory(async ({ options }) => runtime.createDefaultNodeAgent({ ...options, ...(modelTool ? { approvalMode: "full_access" as const } : {}),
      ...(extension ? { extensions: [...(options.extensions ?? []), extension] } : {}),
      capabilityOverrides: { ...options.capabilityOverrides, terminal: false, memory: false },
      client: { async *streamMessage() { modelCalls++;
        if (modelTool && modelCalls === 1) { yield { type: "tool_use_start", toolUse: { type: "tool_use", id: "native-model-result", name: "SaveDocument", input: { value: "model" } } }; yield { type: "complete", stopReason: "tool_use" }; }
        else { yield { type: "text_delta", delta: "Done" }; yield { type: "complete", stopReason: "end_turn" }; }
      } },
    })),
  });
  let server = boot(); await server.application.ready();
  const session = store.sessions.create({ id: "app-session", cwd: root, model: "never", metadata: { runtime: { provider: "fixture", model: "never", approvalMode: modelTool ? "full_access" : "auto_review" } } });
  const clientOptions: HttpTransportOptions = { baseUrl: "http://localhost", token: "app-token", fetch: (url, init) => server.app.fetch(new Request(url, init)) };
  const client = () => new VykorClient(clientOptions);
  const transport = () => new HttpTransport(clientOptions);
  const pluginApps = pluginAppHttp(transport());
  const opened = await pluginApps.open(session.id, { pluginId: fixture.pluginId, surfaceId: "editor" });
  const request: PluginAppToolRequest = { source: opened.source, lease: opened.lease!, requestId: "request",
    expectedRevision: opened.app.controlRevision, toolName: fixture.toolName, args: { value: "approved" } };
  return { root, ...fixture, session, opened, request, reviews, client, transport, pluginApps, store: () => store, server: () => server,
    modelCalls: () => modelCalls,
    effects: () => existsSync(fixture.effectFile) ? Number(readFileSync(fixture.effectFile, "utf8")) : 0,
    beforeReview: (fn: () => Promise<void>) => { beforeReview = fn; },
    wait: async (runId: string) => server.application.runControl.waitForRuns([runId]),
    raw: (path: string, body?: unknown) => server.app.request(path, { method: body === undefined ? "GET" : "POST",
      headers: { authorization: "Bearer app-token", "x-vykor-protocol-version": String(CURRENT_PROTOCOL_VERSION), "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    restart: async (beforeBoot?: (store: SessionStore) => void) => { await server.close(); store.close(); store = new SessionStore({ path: join(root, "session.db") }); beforeBoot?.(store); server = boot(); await server.application.ready(); },
    close: async () => { await server.close(); store.close(); rmSync(root, { recursive: true, force: true }); },
  };
}
