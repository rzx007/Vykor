import { describe, expect, it, vi } from "vitest";

import type { Settings } from "@vykor/core";

import {
  assembleSessionContextUsage,
  resolveModelContextLimits,
  resolveSessionModelContextLimits,
} from "./assemble-session-context-usage.js";
import { ContextUsageCache } from "./context-usage-cache.js";
import type { ModelProviderInfo } from "./settings-api.js";

function baseSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    model: "fixture-model",
    apiFormat: "openai",
    provider: "openrouter",
    maxTokens: 1024,
    maxTurns: 10,
    permission: { mode: "default" },
    plugins: { enabled: true },
    memory: { enabled: false },
    sandbox: { enabled: false },
    ...overrides,
  } as Settings;
}

describe("resolveModelContextLimits", () => {
  it("prefers the session runtime provider when model ids overlap", async () => {
    const providers: ModelProviderInfo[] = [
      {
        name: "global-provider",
        displayName: "Global",
        models: [{
          id: "shared-model",
          label: "Global model",
          provider: "Global",
          providerName: "global-provider",
          contextWindow: 10_000,
          inputCapabilities: { image: "unknown" },
        }],
      },
      {
        name: "session-provider",
        displayName: "Session",
        models: [{
          id: "shared-model",
          label: "Session model",
          provider: "Session",
          providerName: "session-provider",
          contextWindow: 80_000,
          inputCapabilities: { image: "unknown" },
        }],
      },
    ];

    const limits = await resolveSessionModelContextLimits({
      session: {
        id: "session-provider-test",
        cwd: process.cwd(),
        title: "test",
        model: "shared-model",
        status: "idle",
        metadata: {
          runtime: { model: "shared-model", provider: "session-provider" },
        },
        createdAt: 1,
        updatedAt: 1,
      },
      settings: baseSettings({ provider: "global-provider" }),
      listProviders: async () => providers,
    });

    expect(limits.contextWindow).toBe(80_000);
  });

  it("resolves contextWindow and outputLimit from catalog fixture", async () => {
    const providers: ModelProviderInfo[] = [
      {
        name: "openrouter",
        displayName: "OpenRouter",
        models: [
          {
            id: "fixture-model",
            label: "Fixture",
            provider: "OpenRouter",
            providerName: "openrouter",
            contextWindow: 128_000,
            outputLimit: 8_192,
            inputCapabilities: { image: "unknown" },
          },
        ],
      },
    ];

    const limits = await resolveModelContextLimits({
      model: "fixture-model",
      listProviders: async () => providers,
    });

    expect(limits.contextWindow).toBe(128_000);
    expect(limits.outputLimit).toBe(8_192);
  });

  it("matches provider-prefixed model ids", async () => {
    const providers: ModelProviderInfo[] = [
      {
        name: "openrouter",
        displayName: "OpenRouter",
        models: [
          {
            id: "anthropic/claude-test",
            label: "Claude",
            provider: "OpenRouter",
            providerName: "openrouter",
            contextWindow: 200_000,
            inputCapabilities: { image: "unknown" },
          },
        ],
      },
    ];

    const limits = await resolveModelContextLimits({
      model: "openrouter/anthropic/claude-test",
      providerHint: "openrouter",
      listProviders: async () => providers,
    });

    expect(limits.contextWindow).toBe(200_000);
  });
});

describe("live assembly context window", () => {
  it("produces non-null percentFull when catalog provides contextWindow", async () => {
    const cache = new ContextUsageCache();
    const agent = {
      getHistory: () => [{ type: "user" as const, content: "hello" }],
      listModelVisibleTools: () => [],
    };
    const listProviders = vi.fn(async (): Promise<ModelProviderInfo[]> => [
      {
        name: "openrouter",
        displayName: "OpenRouter",
        models: [
          {
            id: "fixture-model",
            label: "Fixture",
            provider: "OpenRouter",
            providerName: "openrouter",
            contextWindow: 100_000,
            outputLimit: 4_096,
            inputCapabilities: { image: "unknown" },
          },
        ],
      },
    ]);

    const limits = await resolveModelContextLimits({
      model: "fixture-model",
      listProviders,
    });
    const snapshot = await assembleSessionContextUsage({
      sessionId: "s1",
      cwd: process.cwd(),
      model: "fixture-model",
      settings: baseSettings(),
      agent,
      cache,
      contextWindow: limits.contextWindow,
      outputLimit: limits.outputLimit,
    });

    expect(limits.contextWindow).toBe(100_000);
    expect(snapshot.contextWindow).toBe(100_000);
    expect(snapshot.outputLimit).toBe(4_096);
    expect(snapshot.percentFull).not.toBeNull();
    expect(snapshot.percentFull).toBeGreaterThan(0);
    expect(snapshot.tips.some((t) => t.code === "no_context_window")).toBe(false);
  });
});
