import { describe, expect, it } from "vitest";

import { resolveModelLimit, createModelMetadataResolvers } from "../model-limit-resolution.js";

const catalog = {
  anthropic: {
    models: {
      "claude-sonnet-4-5": {
        id: "claude-sonnet-4-5",
        limit: { context: 200_000, output: 64_000 },
      },
    },
  },
  "office-gateway": {
    models: {
      "team-model": {
        id: "team-model",
        limit: { context: 128_000, output: 8_192 },
      },
    },
  },
} as never;

function customProvider(
  models: Array<{
    id: string;
    contextWindow?: number;
    maxOutputTokens?: number;
  }>,
) {
  return [
    {
      id: "my-gateway",
      displayName: "My Gateway",
      baseUrl: "https://gateway.example/v1",
      apiFormat: "openai" as const,
      models: models.map((model) => ({ displayName: model.id, ...model })),
    },
  ];
}

describe("model metadata snapshots", () => {
  it("keeps an agent's model limits after the saved provider is edited", async () => {
    const provider = {
      id: "gateway", displayName: "Gateway", apiFormat: "openai" as const,
      baseUrl: "https://gateway.example/v1",
      models: [{ id: "chat", displayName: "Chat", contextWindow: 100_000, maxOutputTokens: 8_000 }],
    };
    const settings = { customProviders: [provider] };
    const running = createModelMetadataResolvers(settings as never, {});
    provider.models[0]!.contextWindow = 200_000;
    provider.models[0]!.maxOutputTokens = 16_000;
    const next = createModelMetadataResolvers(settings as never, {});
    await expect(running.resolveModelContextWindow!({ provider: "gateway", model: "chat" })).resolves.toBe(100_000);
    await expect(running.resolveModelOutputLimit!({ provider: "gateway", model: "chat" })).resolves.toBe(8_000);
    await expect(next.resolveModelOutputLimit!({ provider: "gateway", model: "chat" })).resolves.toBe(16_000);
  });

  it("keeps catalog limits and reasoning options until the agent is rebuilt", async () => {
    const oldCatalog = { gateway: { models: { chat: {
      limit: { context: 100_000, output: 8_000 },
      reasoning_options: [{ type: "effort", values: ["low"] }],
    } } } };
    const running = createModelMetadataResolvers({} as never, oldCatalog);
    const refreshed = { gateway: { models: { chat: {
      limit: { context: 200_000, output: 16_000 },
      reasoning_options: [{ type: "effort", values: ["low", "high"] }],
    } } } };
    const next = createModelMetadataResolvers({} as never, refreshed);
    await expect(running.resolveModelOutputLimit!({ provider: "gateway", model: "chat" })).resolves.toBe(8_000);
    await expect(running.resolveReasoningEfforts!({ provider: "gateway", model: "chat" })).resolves.toEqual(["low"]);
    await expect(next.resolveReasoningEfforts!({ provider: "gateway", model: "chat" })).resolves.toEqual(["low", "high"]);
  });
});

describe("resolveModelLimit", () => {
  it("prefers the value the user typed in the custom provider", () => {
    const customProviders = customProvider([
      { id: "claude-sonnet-4-5", contextWindow: 300_000, maxOutputTokens: 99 },
    ]);

    expect(
      resolveModelLimit("context", {
        catalog,
        customProviders,
        provider: "my-gateway",
        model: "claude-sonnet-4-5",
      }),
    ).toBe(300_000);
    expect(
      resolveModelLimit("output", {
        catalog,
        customProviders,
        provider: "my-gateway",
        model: "claude-sonnet-4-5",
      }),
    ).toBe(99);
  });

  it("matches the catalog by provider before falling back to model id", () => {
    expect(
      resolveModelLimit("context", {
        catalog,
        customProviders: customProvider([{ id: "team-model" }]),
        provider: "office-gateway",
        model: "team-model",
      }),
    ).toBe(128_000);
  });

  it("borrows limits from a same-named catalog model for custom providers", () => {
    const customProviders = customProvider([{ id: "CLAUDE-SONNET-4-5" }]);

    expect(
      resolveModelLimit("context", {
        catalog,
        customProviders,
        provider: "my-gateway",
        model: "CLAUDE-SONNET-4-5",
      }),
    ).toBe(200_000);
    expect(
      resolveModelLimit("output", {
        catalog,
        customProviders,
        provider: "my-gateway",
        model: "CLAUDE-SONNET-4-5",
      }),
    ).toBe(64_000);
  });

  it("applies user values independently when only one limit is declared", () => {
    const customProviders = customProvider([
      { id: "claude-sonnet-4-5", contextWindow: 300_000 },
    ]);

    expect(
      resolveModelLimit("context", {
        catalog,
        customProviders,
        provider: "my-gateway",
        model: "claude-sonnet-4-5",
      }),
    ).toBe(300_000);
    expect(
      resolveModelLimit("output", {
        catalog,
        customProviders,
        provider: "my-gateway",
        model: "claude-sonnet-4-5",
      }),
    ).toBe(64_000);
  });

  it("does not apply model-id matching to built-in providers", () => {
    expect(
      resolveModelLimit("context", {
        catalog,
        provider: "unknown-builtin",
        model: "claude-sonnet-4-5",
      }),
    ).toBeUndefined();
  });

  it("returns undefined when nothing matches so callers keep their default", () => {
    expect(
      resolveModelLimit("context", {
        catalog,
        customProviders: customProvider([{ id: "made-up-model" }]),
        provider: "my-gateway",
        model: "made-up-model",
      }),
    ).toBeUndefined();
    expect(
      resolveModelLimit("context", { catalog, provider: "my-gateway", model: "" }),
    ).toBeUndefined();
    expect(resolveModelLimit("context", { catalog, model: "team-model" })).toBeUndefined();
  });

  it("ignores declared values that are not positive safe integers", () => {
    const customProviders = customProvider([
      { id: "made-up-model", contextWindow: 0, maxOutputTokens: 1.5 },
    ]);

    expect(
      resolveModelLimit("context", {
        catalog,
        customProviders,
        provider: "my-gateway",
        model: "made-up-model",
      }),
    ).toBeUndefined();
    expect(
      resolveModelLimit("output", {
        catalog,
        customProviders,
        provider: "my-gateway",
        model: "made-up-model",
      }),
    ).toBeUndefined();
  });
});
