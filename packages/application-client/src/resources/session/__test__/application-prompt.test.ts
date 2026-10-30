import { expect, it } from "vitest";
import { CURRENT_PROTOCOL_VERSION } from "@vykor/protocol";
import { VykorClient, type AdmitClientPromptInput } from "../../../index.js";

it("preserves product plugin context when the SDK admits a prompt", async () => {
  const requests: Request[] = [];
  const input: AdmitClientPromptInput = {
    id: "prompt-1",
    items: [{ type: "text", text: "Use this selection" }],
    pluginAppContexts: [{
      source: { sessionId: "session/one", appId: "app-1" },
      lease: { token: "opaque", backendGeneration: "generation-1" },
      requestId: "request-1",
      expectedRevision: 2,
      text: "Selected row",
      data: { row: 3 },
    }],
  };
  const client = new VykorClient({
    baseUrl: "http://daemon.test",
    fetch: async (url, init) => {
      if (String(url).endsWith("/capabilities")) {
        return Response.json({ serverVersion: "test", protocol: { version: CURRENT_PROTOCOL_VERSION }, features: {} });
      }
      requests.push(new Request(url, init));
      return Response.json({ input: { id: "prompt-1" } });
    },
  });

  await client.sessions.admitPrompt("session/one", input);

  expect(requests).toHaveLength(1);
  expect(requests[0]!.method).toBe("POST");
  expect(new URL(requests[0]!.url).pathname).toBe("/sessions/session%2Fone/prompts");
  expect(await requests[0]!.json()).toEqual({
    id: "prompt-1",
    items: [{ type: "text", text: "Use this selection" }],
    pluginAppContexts: [{
      source: { sessionId: "session/one", appId: "app-1" },
      lease: { token: "opaque", backendGeneration: "generation-1" },
      requestId: "request-1",
      expectedRevision: 2,
      text: "Selected row",
      data: { row: 3 },
    }],
  });
});
