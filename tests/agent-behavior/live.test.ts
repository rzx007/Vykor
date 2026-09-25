import { describe, expect, it } from "vitest";
import type { Settings, StreamingMessageClient } from "@vykor/core";
import { behaviorCases } from "./cases.js";
import { formatLiveFailure, loadLiveClient, parseLiveConfig, scrubLiveResult } from "./live.js";
import { runBehaviorCase } from "./run.js";

const valid = {
  provider: "opencode-go", model: "deepseek-v4.1-flash", caseIds: ["C3"], repeats: 1,
  maxRequests: 4, maxTurns: 3, maxResponseTokens: 1024, timeoutMs: 90_000,
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
    for (const patch of [
      { provider: "radeon" }, { model: "DeepSeek-V4.1-Flash" }, { caseIds: ["missing"] },
      { caseIds: [] }, { repeats: 0 }, { maxRequests: 0 }, { maxTurns: Infinity },
      { maxResponseTokens: 0 }, { timeoutMs: NaN }, { timeoutMs: 2_147_483_648 },
      { maxRequests: Number.MAX_SAFE_INTEGER }, { apiKey: "unexpected" },
    ]) {
      expect(() => parseLiveConfig({ ...valid, ...patch }, behaviorCases)).toThrow();
    }
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
    const client: StreamingMessageClient = { async *streamMessage() { throw new Error("must not request"); } };
    const result = await loadLiveClient(config, {
      settings: { ...settings, apiKey: "wrong-default-key" },
      storage: { loadApiKey: async (provider) => provider === "opencode-go" ? "fixture-secret" : undefined },
      resolve: async (_settings, configuration) => { resolved = configuration; return client; },
    });
    expect(result.client).toBe(client);
    expect(resolved).toMatchObject({ provider: "opencode-go", model: "deepseek-v4.1-flash", apiKey: "fixture-secret" });
    expect(result.report).toEqual({ provider: "opencode-go", model: "deepseek-v4.1-flash",
      sdkRetryLimit: 3, maxHttpRequestsPerCase: 16, providerBilling: "unknown" });
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
