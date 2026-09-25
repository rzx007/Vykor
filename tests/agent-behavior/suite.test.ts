import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { behaviorCases } from "./cases.js";
import { formatLiveFailure, loadLiveClient, parseLiveConfig, scrubLiveResult } from "./live.js";
import { behaviorSystemPrompt, reserveBehaviorReport, runBehaviorCase, type BehaviorResult } from "./run.js";

const mode = process.env.VYKOR_EVAL_MODE ?? "scripted";
if (mode !== "scripted" && mode !== "live") throw new Error(`Unknown evaluation mode: ${mode}`);
const liveConfigPath = mode === "live" ? process.env.VYKOR_EVAL_CONFIG : undefined;
if (mode === "live" && !liveConfigPath) throw new Error("Live evaluation requires VYKOR_EVAL_CONFIG");
const liveConfig = liveConfigPath ? parseLiveConfig(JSON.parse(readFileSync(liveConfigPath, "utf8")), behaviorCases) : undefined;
const live = liveConfig ? await loadLiveClient(liveConfig) : undefined;
const selectedCases = liveConfig ? behaviorCases.filter((scenario) => liveConfig.caseIds.includes(scenario.id)) : behaviorCases;
const report = reserveBehaviorReport(process.env.VYKOR_EVAL_OUT);
console.info(`Behavior evaluation report: ${report.path}`);
const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const fixtureVersion = "agent-behavior-v3";
const records: BehaviorResult[] = [];

const caseMetadata = selectedCases.map(({ id, prompt, manualChecks, setup }) => {
  const fixture = setup();
  const tools = [...fixture.tools, ...(fixture.toolOverrides ?? [])];
  const schemas = tools.map(({ name, description, inputSchema, safeToRetry, execution }) => ({
    name, description, inputSchema, safeToRetry, execution,
  }));
  return {
    id, promptSha256: createHash("sha256").update(`${behaviorSystemPrompt}\n\n${prompt}`).digest("hex"),
    allowedTools: tools.map((tool) => tool.name), deniedTools: fixture.deniedTools ?? [],
    toolSchemaSha256: createHash("sha256").update(JSON.stringify(schemas)).digest("hex"),
    manualChecks,
  };
});

function save(): void {
  report.save({
    runId: report.runId, mode, revision, fixtureVersion,
    model: liveConfig?.model ?? "scripted",
    ...(liveConfig && live ? { provider: live.report.provider, providerBilling: "unknown",
      adapterRetryLimit: live.report.adapterRetryLimit,
      sdkRetryLimit: live.report.sdkRetryLimit,
      maxHttpRequestsPerCase: live.report.maxHttpRequestsPerCase,
      maxHttpRequestsTotal: live.report.maxHttpRequestsPerCase * selectedCases.length * liveConfig.repeats,
      usage: "reported by provider when available; missing usage is unknown" } : {}),
    parameters: liveConfig ? { caseIds: liveConfig.caseIds, repeats: liveConfig.repeats,
      maxTurns: liveConfig.maxTurns, maxRequests: liveConfig.maxRequests,
      maxResponseTokens: liveConfig.maxResponseTokens, timeoutMs: liveConfig.timeoutMs } :
      { maxTurns: 20, maxRequests: 25, timeoutMs: 120_000 },
    permission: { sandbox: false, mcpServers: {}, pluginsEnabled: false, hostTools: "case fixture only" },
    cases: caseMetadata,
    results: live ? records.map((result) => scrubLiveResult(result, live.redactions)) : records,
  });
}

describe(`cross-task behavior baseline (${mode})`, () => {
  for (const scenario of selectedCases) {
    for (let repeat = 1; repeat <= (liveConfig?.repeats ?? 3); repeat++) {
      it(`${scenario.id} repeat ${repeat}`, async () => {
        const result = await runBehaviorCase(scenario, {
          client: live?.client ?? scenario.scripted!(), model: liveConfig?.model ?? "scripted", revision, repeat,
          maxRequests: liveConfig?.maxRequests ?? 25, timeoutMs: liveConfig?.timeoutMs ?? 120_000,
          ...(liveConfig ? { maxTurns: liveConfig.maxTurns, maxResponseTokens: liveConfig.maxResponseTokens } : {}),
        });
        records.push(result);
        save();
        const failure = live ? formatLiveFailure(result, live.redactions) : `${result.status}: ${result.reason}`;
        expect(["passed", "pending_review"], `${scenario.id}: ${failure}`).toContain(result.status);
      });
    }
  }
});
