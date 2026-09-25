import { describe, expect, it } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import type { Settings, StreamingMessageClient } from "@vykor/core";
import { behaviorCases, type BehaviorCase } from "./cases.js";
import { assertLiveSampleComplete, formatLiveFailure, liveRunOptions, loadLiveClient, parseLiveConfig, scrubLiveResult } from "./live.js";
import { reserveBehaviorReport, runBehaviorCase } from "./run.js";

const valid = {
  provider: "opencode-go", model: "deepseek-v4.1-flash", caseIds: ["C3"], repeats: 1,
  maxRequests: 4, maxTotalRequests: 4, maxTurns: 3, maxResponseTokens: 1024, timeoutMs: 90_000,
};
const settings: Settings = {
  provider: "radeon", model: "some-default", apiFormat: "openai", maxTurns: 50,
  permission: { mode: "default" },
  customProviders: [{ id: "opencode-go", displayName: "OpenCode Go", baseUrl: "https://example.test/v1",
    apiFormat: "openai", models: [{ id: "deepseek-v4.1-flash", displayName: "DeepSeek Flash 4.1" }] }],
};

describe("live evaluation preflight", () => {
  it("accepts only explicit bounded OpenCode Go configuration", () => {
    expect(parseLiveConfig(valid, behaviorCases).caseIds).toEqual(["C3"]);
    expect(parseLiveConfig({ ...valid, maxRequests: 25, maxTurns: 20,
      maxResponseTokens: 8192, timeoutMs: 120_000 }, behaviorCases).maxRequests).toBe(25);
    for (const patch of [
      { provider: "radeon" }, { model: "DeepSeek-V4.1-Flash" }, { caseIds: ["missing"] },
      { caseIds: [] }, { repeats: 0 }, { maxRequests: 0 }, { maxTurns: Infinity },
      { maxResponseTokens: 0 }, { timeoutMs: NaN }, { timeoutMs: 2_147_483_648 },
      { maxRequests: 26 }, { maxTurns: 21 }, { maxResponseTokens: 8193 }, { timeoutMs: 120_001 },
      { maxRequests: Number.MAX_SAFE_INTEGER }, { apiKey: "unexpected" },
      { repeats: 100_000 }, { repeats: 4 }, { maxTotalRequests: 0 }, { maxTotalRequests: 501 },
      { maxTotalRequests: undefined },
    ]) {
      expect(() => parseLiveConfig({ ...valid, ...patch }, behaviorCases)).toThrow();
    }
  });

  it("allows the 36-sample matrix to stop at a smaller shared budget", () => {
    const allCases = behaviorCases.map((item) => item.id);
    expect(allCases).toHaveLength(12);
    expect(parseLiveConfig({ ...valid, caseIds: allCases, repeats: 3,
      maxRequests: 25, maxTotalRequests: 500 }, behaviorCases).maxTotalRequests).toBe(500);
  });

  it("rejects missing provider, model or stored credential before client resolution", async () => {
    const config = parseLiveConfig(valid, behaviorCases);
    let resolutions = 0;
    const resolve = async (): Promise<StreamingMessageClient> => { resolutions++; throw new Error("network path"); };
    const storage = { loadApiKey: async () => "fixture-secret" };
    await expect(loadLiveClient(config, { settings: { ...settings, customProviders: [] }, storage, resolve })).rejects.toThrow(/provider/i);
    await expect(loadLiveClient(config, { settings: { ...settings, customProviders: [{ ...settings.customProviders![0]!, models: [] }] }, storage, resolve })).rejects.toThrow(/model/i);
    await expect(loadLiveClient(config, { settings, storage: { loadApiKey: async () => undefined }, resolve })).rejects.toThrow(/credential/i);
    await expect(loadLiveClient(config, { settings: { ...settings, provider: "codex", apiKey: "codex-default-secret" },
      storage: { loadApiKey: async () => undefined }, resolve })).rejects.toThrow(/credential/i);
    expect(resolutions).toBe(0);
  });

  it("passes only the selected provider credential to the existing resolver", async () => {
    const config = parseLiveConfig(valid, behaviorCases);
    let resolved: { provider?: string; model?: string; apiKey?: string } | undefined;
    let sessionId: string | undefined;
    const client: StreamingMessageClient = { async *streamMessage() { throw new Error("must not request"); } };
    const result = await loadLiveClient(config, {
      settings: { ...settings, apiKey: "wrong-default-key" },
      storage: { loadApiKey: async (provider) => provider === "opencode-go" ? "fixture-secret" : undefined },
      resolve: async (_settings, configuration, _storage, id) => {
        resolved = configuration; sessionId = id; return client;
      },
    });
    expect(result.client).toBe(client);
    expect(resolved).toMatchObject({ provider: "opencode-go", model: "deepseek-v4.1-flash", apiKey: "fixture-secret" });
    expect(sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(result.report).toEqual({ provider: "opencode-go", model: "deepseek-v4.1-flash",
      adapterRetryLimit: 3, sdkRetryLimit: 2, maxHttpRequestsPerCase: 48,
      maxLogicalRequestsTotal: 4, maxHttpRequestsTotal: 48, providerBilling: "unknown" });
    expect(JSON.stringify(result.report)).not.toContain("fixture-secret");
  });

  it("removes credentials and configured header values from saved result text", () => {
    const scrubbed = scrubLiveResult({ reason: "bad fixture-secret header-secret", evidence: {
      outputText: "header-secret", events: [{ type: "output.text.delta", text: "fixture-secret",
        headers: { Authorization: "unlisted-secret" } }],
    } }, ["fixture-secret", "header-secret"]);
    expect(JSON.stringify(scrubbed)).not.toContain("fixture-secret");
    expect(JSON.stringify(scrubbed)).not.toContain("header-secret");
    expect(JSON.stringify(scrubbed)).not.toContain("unlisted-secret");
    expect(scrubbed).toMatchObject({ reason: "bad [REDACTED] [REDACTED]" });
  });

  it("keeps a fake live sample within its configured request budget", async () => {
    const config = parseLiveConfig({ ...valid, maxRequests: 1 }, behaviorCases);
    const item = behaviorCases.find((scenario) => scenario.id === "C3")!;
    let calls = 0;
    const client: StreamingMessageClient = { async *streamMessage() {
      calls++;
      yield { type: "tool_use_start" as const, toolUse: { type: "tool_use" as const,
        id: `fake-${calls}`, name: "RunRelevantTest", input: {} } };
      yield { type: "complete" as const, stopReason: "tool_use" };
    } };
    const result = await runBehaviorCase(item, { ...config, client, revision: "fixture", repeat: 1 });
    expect(result).toMatchObject({ status: "budget_cancelled", requestCount: 1 });
    expect(calls).toBe(1);
  });

  it("records later samples as not_run after the shared budget is consumed", async () => {
    const config = parseLiveConfig({ ...valid, repeats: 2, maxRequests: 2,
      maxTotalRequests: 1 }, behaviorCases);
    const item: BehaviorCase = { id: "fixture", domain: "files", prompt: "Finish",
      setup: () => ({ tools: [], verify: () => ({ passed: true, reason: "done" }) }) };
    const sharedBudget = { remainingRequests: config.maxTotalRequests };
    let calls = 0;
    const client: StreamingMessageClient = { async *streamMessage() {
      calls++;
      yield { type: "text_delta" as const, delta: "done" };
      yield { type: "complete" as const, stopReason: "end_turn" };
    } };
    const first = await runBehaviorCase(item, liveRunOptions(config, client, "fixture", 1, sharedBudget));
    const second = await runBehaviorCase(item, liveRunOptions(config, client, "fixture", 2, sharedBudget));
    const report = reserveBehaviorReport();
    try {
      report.save({ results: [first, second] });
      const saved = JSON.parse(readFileSync(report.path, "utf8"));
      expect(saved.results.map((result: { status: string; requestCount: number }) =>
        [result.status, result.requestCount])).toEqual([["passed", 1], ["not_run", 0]]);
      expect(calls).toBe(1);
      expect(() => assertLiveSampleComplete(first, [])).not.toThrow();
      expect(() => assertLiveSampleComplete(second, [])).toThrow(/not_run|incomplete/i);
    } finally { rmSync(report.path); }
  });

  it("scrubs a fake provider error before producing report and failure output", async () => {
    const item = behaviorCases.find((scenario) => scenario.id === "C3")!;
    const client: StreamingMessageClient = { async *streamMessage() {
      throw new Error("provider failed with fixture-secret and header-secret");
    } };
    const result = await runBehaviorCase(item, { client, model: valid.model, revision: "fixture", repeat: 1,
      maxRequests: 1, maxTurns: 1, maxResponseTokens: 1024, timeoutMs: 1_000 });
    const secrets = ["fixture-secret", "header-secret"];
    expect(result.status).toBe("failed");
    expect(JSON.stringify(scrubLiveResult(result, secrets))).not.toMatch(/fixture-secret|header-secret/);
    expect(formatLiveFailure(result, secrets)).not.toMatch(/fixture-secret|header-secret/);
  });
});
