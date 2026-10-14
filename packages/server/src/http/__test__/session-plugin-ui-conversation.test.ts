import { expect, it } from "vitest";
import { createSessionPluginUiConversationRoutes } from "../routes/session-plugin-ui-conversation.js";
import type { SessionPluginUiConversationService } from "../../application/session/session-plugin-ui-conversation-service.js";

const id = "11111111-1111-4111-8111-111111111111";
const requestId = "22222222-2222-4222-8222-222222222222";
const base = `/s/plugin-ui/${id}/conversation`;
it("rejects raw UTF-8 bodies exceeding 64 KiB including blank padding before JSON parsing", async () => {
  const app = createSessionPluginUiConversationRoutes({} as SessionPluginUiConversationService);
  for (const body of [" ".repeat(65537), JSON.stringify({ mode: "draft", expectedRevision: 1, text: "x", data: {} }) + " ".repeat(65536), "é".repeat(33000)]) {
    const response = await app.request(base + "/prepare", { method: "POST", body });
    expect(response.status).toBe(413); expect(await response.json()).toMatchObject({ code: "plugin_ui_payload_too_large" });
  }
});
it("counts UTF-8 BOM bytes in the raw 64 KiB body limit", async () => {
  const app = createSessionPluginUiConversationRoutes({} as SessionPluginUiConversationService);
  const json = JSON.stringify({ mode: "draft", expectedRevision: 1, text: "x", data: {} });
  const body = new TextEncoder().encode("\uFEFF" + json + " ".repeat(65536 - new TextEncoder().encode(json).byteLength));
  expect(body.byteLength).toBe(65539);
  const response = await app.request(base + "/prepare", { method: "POST", body });
  expect(response.status).toBe(413); expect(await response.json()).toMatchObject({ code: "plugin_ui_payload_too_large" });
});
it("rejects unknown query and input fields on every conversation boundary", async () => {
  const app = createSessionPluginUiConversationRoutes({} as SessionPluginUiConversationService);
  for (const path of ["/prepare", "/submissions", `/submissions/${requestId}`]) {
    const response = await app.request(base + path + "?unexpected=1", { method: path.includes(requestId) ? "GET" : "POST", body: path.includes(requestId) ? undefined : "{}" });
    expect(response.status).toBe(400);
  }
  const response = await app.request(base + "/submissions", { method: "POST", body: JSON.stringify({ requestId, expectedRevision: 1, text: "x", data: {}, runMetadata: {} }) });
  expect(response.status).toBe(400);
});
