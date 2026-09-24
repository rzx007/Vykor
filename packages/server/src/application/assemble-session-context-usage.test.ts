import { describe, expect, it, vi } from "vitest";

import {
  assembleContextUsageSnapshot,
  estimateTokens,
  type Settings,
} from "@vykor/core";

import { assembleSessionContextUsage } from "./assemble-session-context-usage.js";
import { ContextUsageCache } from "./context-usage-cache.js";
import { createDefaultContextService } from "./default-services/context-service.js";
import type { DaemonSettingsRef } from "./default-services/shared.js";

function settingsRef(overrides: Partial<Settings> = {}): DaemonSettingsRef {
  return {
    current: {
      model: "test/model",
      apiFormat: "openai",
      provider: "openrouter",
      maxTokens: 1024,
      maxTurns: 10,
      permission: { mode: "default" },
      plugins: { enabled: true },
      memory: { enabled: false },
      sandbox: { enabled: false },
      ...overrides,
    } as Settings,
  };
}

function serializeTool(tool: {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}): string {
  return JSON.stringify({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  });
}

describe("assembleSessionContextUsage", () => {
  it("uses the session agent runtime prompt instead of rebuilding global settings", async () => {
    const cache = new ContextUsageCache();
    const agent = {
      getHistory: () => [],
      listModelVisibleTools: () => [],
      getContextUsagePromptSource: () => ({
        systemPrompt: "COORDINATOR RUNTIME PROMPT\n\nSESSION INSTRUCTIONS",
      }),
    };

    const snapshot = await assembleSessionContextUsage({
      sessionId: "s-runtime-prompt",
      cwd: process.cwd(),
      model: "test/model",
      settings: settingsRef({ systemPrompt: "GLOBAL SETTINGS PROMPT" }).current!,
      agent,
      cache,
      contextWindow: 100_000,
    });

    expect(snapshot.buckets.find((b) => b.id === "system")!.tokens).toBe(
      estimateTokens("COORDINATOR RUNTIME PROMPT\n\nSESSION INSTRUCTIONS"),
    );
    expect(snapshot.estimatedInputTokens).not.toBe(
      estimateTokens("GLOBAL SETTINGS PROMPT"),
    );
  });

  it("includes the latest live turn memory reminder in the cached snapshot", async () => {
    const cache = new ContextUsageCache();
    const reminder = "<system-reminder>\nRELEVANT TURN MEMORY\n</system-reminder>";
    const agent = {
      getHistory: () => [],
      listModelVisibleTools: () => [],
      getContextUsagePromptSource: () => ({
        systemPrompt: "SESSION PROMPT",
        memoryReminderText: reminder,
      }),
    };

    const snapshot = await assembleSessionContextUsage({
      sessionId: "s-memory",
      cwd: process.cwd(),
      model: "test/model",
      settings: settingsRef().current!,
      agent,
      cache,
      contextWindow: 100_000,
    });

    expect(snapshot.buckets.find((b) => b.id === "conversation")!.tokens).toBe(
      estimateTokens(reminder),
    );
    expect(cache.get("s-memory")?.buckets.find((b) => b.id === "conversation")!.tokens).toBe(
      estimateTokens(reminder),
    );
  });

  it("writes usage cache from the same tools list used for the run", async () => {
    const cache = new ContextUsageCache();
    const builtin = {
      name: "Read",
      description: "Read a file",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
      source: { kind: "builtin" as const },
    };
    const mcpTool = {
      name: "mcp__demo__search",
      description: "Search",
      inputSchema: { type: "object", properties: { q: { type: "string" } } },
      source: { kind: "mcp" as const, id: "demo" },
    };
    const agent = {
      getHistory: () => [
        { type: "user" as const, content: "hello from session" },
      ],
      listModelVisibleTools: () => [builtin, mcpTool],
    };

    const snapshot = await assembleSessionContextUsage({
      sessionId: "s1",
      cwd: process.cwd(),
      model: "test/model",
      settings: settingsRef().current!,
      agent,
      cache,
      contextWindow: 100_000,
    });

    expect(snapshot.source).toBe("live_assembly");
    expect(cache.get("s1")?.source).toBe("live_assembly");

    const toolsTokens = estimateTokens(serializeTool(builtin));
    const mcpTokens = estimateTokens(serializeTool(mcpTool));
    expect(snapshot.buckets.find((b) => b.id === "tools")!.tokens).toBe(toolsTokens);
    expect(snapshot.buckets.find((b) => b.id === "mcp")!.tokens).toBe(mcpTokens);
    expect(snapshot.buckets.find((b) => b.id === "conversation")!.tokens).toBeGreaterThan(0);
  });

  it("counts skills bucket tokens when skillsList is provided", async () => {
    const cache = new ContextUsageCache();
    const agent = {
      getHistory: () => [],
      listModelVisibleTools: () => [],
    };

    const snapshot = await assembleSessionContextUsage({
      sessionId: "s-skills",
      cwd: process.cwd(),
      model: "test/model",
      settings: settingsRef().current!,
      agent,
      cache,
      contextWindow: 100_000,
      skillsList: [
        {
          name: "archify",
          description: "Draw architecture diagrams with validated SVG output",
        },
      ],
    });

    expect(snapshot.buckets.find((b) => b.id === "skills")!.tokens).toBeGreaterThan(0);
  });

});

describe("ContextService.usage live assembly", () => {
  it("reassembles live on refresh when assembleLive is available", async () => {
    const cache = new ContextUsageCache();
    const liveSnap = assembleContextUsageSnapshot({
      segments: [
        { bucket: "tools", text: '{"name":"Read"}' },
        { bucket: "conversation", text: "dialog" },
      ],
      model: "live-model",
      contextWindow: 80_000,
      source: "live_assembly",
    });
    const assembleLive = vi.fn(async () => liveSnap);
    const contextService = createDefaultContextService(
      settingsRef(),
      cache,
      { assembleLive },
    );

    const result = await contextService.usage({
      cwd: process.cwd(),
      sessionId: "s1",
      refresh: true,
    });

    expect(assembleLive).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "s1", cwd: process.cwd() }),
    );
    expect(result.snapshot.source).toBe("live_assembly");
    expect(result.snapshot.buckets.find((b) => b.id === "tools")!.tokens).toBeGreaterThan(0);
  });

  it("falls back to static_only with tip when assembleLive returns null", async () => {
    const cache = new ContextUsageCache();
    const contextService = createDefaultContextService(
      settingsRef(),
      cache,
      { assembleLive: async () => null },
    );

    const result = await contextService.usage({
      cwd: process.cwd(),
      sessionId: "missing",
      refresh: true,
    });

    expect(result.snapshot.source).toBe("static_only");
    expect(result.snapshot.tips.some((t) => t.code === "conversation_omitted")).toBe(true);
  });
});
