import { describe, expect, it } from "vitest";

import { resolveModelLimit } from "./model-limit-resolution.js";

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
