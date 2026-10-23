import { describe, expect, it } from "vitest";

import { listDirectApiKeyCatalogProviders } from "../direct-api-key-providers";

describe("direct API key provider catalog", () => {
  it("keeps only concrete OpenAI-compatible providers with one credential", () => {
    const providers = listDirectApiKeyCatalogProviders({
      direct: {
        name: "Direct AI",
        env: ["DIRECT_API_KEY"],
        api: "https://api.direct.example/v1/",
        npm: "@ai-sdk/openai-compatible",
        models: { chat: { name: "Chat" }, old: { status: "deprecated" } },
      },
      oauth: {
        env: ["CLIENT_ID", "CLIENT_SECRET"],
        api: "https://oauth.example/v1",
        npm: "@ai-sdk/openai-compatible",
        models: { chat: {} },
      },
      templated: {
        env: ["TEMPLATED_API_KEY"],
        api: "https://${ACCOUNT}.example/v1",
        npm: "@ai-sdk/openai-compatible",
        models: { chat: {} },
      },
      native: {
        env: ["NATIVE_API_KEY"],
        api: "https://native.example/v1",
        npm: "@ai-sdk/anthropic",
        models: { chat: {} },
      },
    });

    expect(providers).toEqual([
      {
        catalogId: "direct",
        id: "direct",
        displayName: "Direct AI",
        baseUrl: "https://api.direct.example/v1",
        envKey: "DIRECT_API_KEY",
        models: [{ id: "chat", displayName: "Chat" }],
      },
    ]);
  });
});
