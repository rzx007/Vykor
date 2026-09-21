import { describe, expect, it, vi } from "vitest";
import {
  OPENHARNESS_USER_AGENT,
  OpenAICompatibleClient,
  RequestHeaderTemplateError,
} from "@openharness/api";
import type { Settings } from "@openharness/core";

import { resolveApiClient } from "./default-runtime-provider.js";

const BASE_SETTINGS: Settings = {
  model: "kimi-k3",
  apiFormat: "openai",
  maxTurns: 50,
  permission: { mode: "default" },
};

function readDefaultHeaders(client: Awaited<ReturnType<typeof resolveApiClient>>) {
  return (
    (client as OpenAICompatibleClient).client as {
      _options: { defaultHeaders?: Record<string, string> };
    }
  )._options.defaultHeaders;
}

function customProviderSettings(
  provider: string,
  headers: Record<string, string>,
  source?: "models.dev",
): Settings {
  return {
    ...BASE_SETTINGS,
    apiKey: "key",
    provider,
    customProviders: [
      {
        id: provider,
        displayName: provider,
        baseUrl: "https://gateway.example/v1",
        apiFormat: "openai",
        models: [{ id: "chat", displayName: "Chat" }],
        headers,
        ...(source ? { source } : {}),
      },
    ],
  };
}

describe("resolveApiClient request header templates", () => {
  it("does not carry the old provider URL into a new provider", async () => {
    const client = await resolveApiClient(
      {
        ...BASE_SETTINGS,
        apiKey: "test-key",
        provider: "openai",
        baseUrl: "https://old-gateway.example/v1",
      },
      { provider: "deepseek", model: "deepseek-chat" },
    );
    const baseURL = (client as OpenAICompatibleClient).client._options.baseURL;
    expect(baseURL).not.toBe("https://old-gateway.example/v1");
  });

  it.each([
    [undefined, "office-gateway"],
    ["models.dev", "catalog-gateway"],
  ])("expands request headers for source=%s", async (source, provider) => {
    const client = await resolveApiClient(
      customProviderSettings(
        provider,
        {
          "User-Agent": "{{userAgent}}",
          "X-Session": "{{sessionId}}",
        },
        source as "models.dev" | undefined,
      ),
      { provider },
      undefined,
      "session-42",
    );

    expect(readDefaultHeaders(client)).toEqual({
      "User-Agent": OPENHARNESS_USER_AGENT,
      "X-Session": "session-42",
    });
  });

  it("builds different expanded headers for different sessions", async () => {
    const settings = customProviderSettings("office-gateway", {
      "X-Session": "{{sessionId}}",
    });

    const first = await resolveApiClient(
      settings,
      { provider: "office-gateway" },
      undefined,
      "session-a",
    );
    const second = await resolveApiClient(
      settings,
      { provider: "office-gateway" },
      undefined,
      "session-b",
    );

    expect(readDefaultHeaders(first)).toEqual({ "X-Session": "session-a" });
    expect(readDefaultHeaders(second)).toEqual({ "X-Session": "session-b" });
  });

  it("reuses the same expanded headers across requests on one client", async () => {
    const captured: Array<Headers | Record<string, string> | undefined> = [];
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      captured.push(init?.headers as Headers | Record<string, string> | undefined);
      return new Response(
        [
          'data: {"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n',
          "data: [DONE]\n\n",
        ].join(""),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    });

    const client = await resolveApiClient(
      customProviderSettings("office-gateway", {
        "User-Agent": "{{userAgent}}",
        "X-Session": "{{sessionId}}",
      }),
      { provider: "office-gateway" },
      undefined,
      "session-stable",
    );

    expect(client).toBeInstanceOf(OpenAICompatibleClient);
    const openai = (client as OpenAICompatibleClient).client;
    openai.fetch = fetchMock;

    for (let i = 0; i < 2; i++) {
      for await (const _ of (client as OpenAICompatibleClient).streamMessage({
        model: "chat",
        messages: [{ type: "user", content: `ping-${i}` }],
      })) {
        /* drain */
      }
    }

    expect(captured).toHaveLength(2);
    const headerValues = captured.map((headers) => {
      if (headers instanceof Headers) {
        return {
          "User-Agent": headers.get("User-Agent"),
          "X-Session": headers.get("X-Session"),
        };
      }
      const record = headers as Record<string, string>;
      const lookup = (name: string) =>
        record[name] ??
        record[name.toLowerCase()] ??
        Object.entries(record).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
      return {
        "User-Agent": lookup("User-Agent"),
        "X-Session": lookup("X-Session"),
      };
    });

    expect(headerValues[0]).toEqual({
      "User-Agent": OPENHARNESS_USER_AGENT,
      "X-Session": "session-stable",
    });
    expect(headerValues[1]).toEqual(headerValues[0]);
  });
  it("keeps static headers when sessionId is missing", async () => {
    const client = await resolveApiClient(
      customProviderSettings("office-gateway", {
        "X-Tenant": "desktop",
      }),
      { provider: "office-gateway" },
    );

    expect(readDefaultHeaders(client)).toEqual({ "X-Tenant": "desktop" });
  });

  it("throws when headers reference sessionId without a session", async () => {
    await expect(
      resolveApiClient(
        customProviderSettings("office-gateway", {
          "X-Session": "{{sessionId}}",
        }),
        { provider: "office-gateway" },
      ),
    ).rejects.toBeInstanceOf(RequestHeaderTemplateError);
  });

  it("does not attach template headers for registry built-in providers", async () => {
    const client = await resolveApiClient(
      {
        ...BASE_SETTINGS,
        apiKey: "sk-openai",
        provider: "openai",
        apiFormat: "openai",
        model: "gpt-4o",
      },
      { provider: "openai" },
      undefined,
      "session-ignored",
    );

    expect(client).toBeInstanceOf(OpenAICompatibleClient);
    expect(readDefaultHeaders(client)).toBeUndefined();
  });
});
