import {hostedAgentFactory} from "../../packages/server/test-helpers/hosted-agent.js";
import { expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultNodeAgent } from "@vykor/agent-runtime";
import { SessionStore } from "@vykor/services";
import { VykorClient } from "@rzx/client";
import { CURRENT_PROTOCOL_VERSION } from "@vykor/protocol";
import { installNotesAppFixture } from "../../packages/agent-runtime/test-helpers/notes-app-fixture.js";
import { VykorHttpServer } from "../../packages/server/src/http/server.js";
import { createDefaultPluginService } from "../../packages/server/src/application/default-services/extensions/plugin-service.js";
import { createDefaultSettingsService } from "../../packages/server/src/application/default-services/configuration/settings-service.js";
import { createDefaultModelService } from "../../packages/server/src/application/default-services/models/model-service.js";

it("real model origin, app-only policy, raw result privacy, shared invalidations and lease isolation", async () => {
  const root = mkdtempSync(join(tmpdir(), "notes-http-")); vi.stubEnv("VYKOR_CONFIG_DIR", join(root, "config"));
  const fixture = await installNotesAppFixture(root, true, undefined, "notes-session"), store = new SessionStore({ path: join(root, "sessions.db") });
  const settings = { apiFormat: "openai" as const, provider: "fixture", model: "never", maxTurns: 4,
    customProviders: [{ id: "fixture", displayName: "Fixture", apiFormat: "openai" as const, baseUrl: "http://127.0.0.1:1/v1", models: [{ id: "never", displayName: "Fixture" }] }],
    permission: { mode: "full_access" as const }, sandbox: { enabled: false }, memory: { enabled: false } };
  let calls = 0;
  const server = new VykorHttpServer({ store, settings, token: "secret", logger: () => {},
    services: { plugin: createDefaultPluginService({ current: settings }), settings: createDefaultSettingsService({ current: settings }), model: createDefaultModelService({ current: settings }) },
    createAgent: hostedAgentFactory(async ({ options }) => createDefaultNodeAgent({ ...options, approvalMode: "full_access",
      capabilityOverrides: { ...options.capabilityOverrides, terminal: false, memory: false },
      client: { async *streamMessage() {
        if (calls++ === 0) { yield { type: "tool_use_start", toolUse: { type: "tool_use", id: "model-read", name: "mcp__notes__read_note", input: {} } }; yield { type: "complete", stopReason: "tool_use" }; }
        else { yield { type: "text_delta", delta: "done" }; yield { type: "complete", stopReason: "end_turn" }; }
      } },
    })),
  });
  const abort = new AbortController();
  try {
    await server.application.ready();
    const session = store.sessions.create({ id: "notes-session", cwd: root, model: "never", metadata: { runtime: { provider: "fixture", model: "never", approvalMode: "full_access" } } });
    const address = await server.listen({ port: 0 });
    const client = new VykorClient({ baseUrl: address.url, token: "secret" });
    const opened = await client.pluginApps.open(session.id, { pluginId: fixture.pluginId, surfaceId: "notes" });
    expect(opened.tools!.map(tool => tool.name)).toContain("save_note_draft");
    expect(opened.tools!.map(tool => tool.name)).not.toContain("read_note");
    const submit = await server.application.interactions.admitPrompt(session.id, { items: [{ type: "text", text: "read note" }, { type: "capability", kind: "plugin", pluginId: fixture.pluginId, displayName: "Notes" }] });
    await server.application.runControl.waitForRuns([submit.run!.id]);
    const part = store.conversations.listMessageParts(session.id).find(part => part.toolUseId === "model-read")!;
    expect(part?.metadata.pluginAppSource).toMatchObject({ pluginId: fixture.pluginId, toolName: "mcp__notes__read_note" });
    const viaResult = await client.pluginApps.openToolResult(session.id, part.id); expect(viaResult.app.id).toBe(opened.app.id);
    const raw = await client.pluginApps.initialResult(viaResult.source, viaResult.lease!, part.id); expect(raw.result._meta).toEqual({ editor: "notes-app" });
    const transcript = await client.sessions.getState(session.id);
    expect(transcript.parts.some(item => item.id === part.id)).toBe(true);
    expect(JSON.stringify(transcript)).not.toContain('"editor":"notes-app"');
    const unauthorized = await fetch(address.url + "/sessions/plugin-app-notifications/stream", { method: "POST", headers: { "content-type": "application/json", "x-vykor-protocol-version": String(CURRENT_PROTOCOL_VERSION) }, body: JSON.stringify({ watches: [] }) });
    expect(unauthorized.status).toBe(401);
    const watches = [{ source: viaResult.source, lease: viaResult.lease!, leaseGeneration: 7, uris: ["ui://notes/editor", "notes://welcome"] }];
    const stream = client.pluginApps.notifications(watches, abort.signal)[Symbol.asyncIterator]();
    expect((await stream.next()).value).toMatchObject({ kind: "resync" });
    const pending = stream.next();
    const action = await client.pluginApps.invoke({ source: viaResult.source, lease: viaResult.lease!, requestId: "save", expectedRevision: viaResult.app.controlRevision,
      toolName: "save_note_draft", args: { operationId: "manual", expectedRevision: 0, text: "saved manually" } });
    await server.application.runControl.waitForRuns([action.receipt.runId]);
    expect((await pending).value).toMatchObject({ kind: "resource-updated", appId: opened.app.id, uri: "notes://welcome", leaseGeneration: 7 });
    const result = await client.pluginApps.getAction(viaResult.source, "save"); expect(result.result?.structuredContent).toMatchObject({ revision: 1, text: "saved manually" });
    expect(existsSync(fixture.effectFile)).toBe(true);
    const secondSession = store.sessions.create({ id: "notes-second-session", cwd: root, model: "never", metadata: { runtime: { provider: "fixture", model: "never", approvalMode: "full_access" } } });
    const second = await client.pluginApps.open(secondSession.id, { pluginId: fixture.pluginId, surfaceId: "notes" });
    const secondData = await client.pluginApps.readResource(second.source, second.lease, "notes://welcome");
    expect(secondData.contents[0]).toMatchObject({ text: expect.stringContaining('"revision":0') });
    expect(store.conversations.listEvents({ sessionId: session.id }).some(event => String(event.type).includes("resource-updated"))).toBe(false);
    const foreign = { ...viaResult.source, sessionId: "other" };
    await expect(client.pluginApps.initialResult(foreign, viaResult.lease!, part.id)).rejects.toThrow();
    await expect(client.pluginApps.initialResult(viaResult.source, { ...viaResult.lease!, token: "forged" }, part.id)).rejects.toThrow();
    const forged = store.conversations.upsertMessagePart({ id: "forged", sessionId: session.id, messageId: part.messageId, type: "tool", toolName: part.toolName,
      toolUseId: "forged", status: "completed", output: part.output, metadata: { ui: {}, pluginAppSource: part.metadata.pluginAppSource } });
    await expect(client.pluginApps.openToolResult(session.id, forged.id)).rejects.toThrow();
    abort.abort(); await stream.return?.();
  } finally { abort.abort(); await server.close(); store.close(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); }
}, 45_000);
