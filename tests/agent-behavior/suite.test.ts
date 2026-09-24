import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { behaviorCases } from "./cases.js";
import { behaviorSystemPrompt, runBehaviorCase, type BehaviorResult } from "./run.js";

const mode = process.env.VYKOR_EVAL_MODE ?? "scripted";
if (mode !== "scripted" && mode !== "live") throw new Error(`Unknown evaluation mode: ${mode}`);
if (mode === "live") {
  const path = process.env.VYKOR_EVAL_CONFIG;
  if (!path) throw new Error("Live evaluation requires VYKOR_EVAL_CONFIG with explicit provider, model, repeats and approved budget");
  const config = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  if (!config.provider || !config.model || !config.repeats || !config.approvedBudgetUsd || !config.adapterRetryLimit || !config.priceCeilingUsdPerRequest) {
    throw new Error("Live evaluation requires provider, model, repeats, approvedBudgetUsd, adapterRetryLimit and priceCeilingUsdPerRequest");
  }
  throw new Error("Live execution is pending explicit approved funding and a verified provider adapter; no external request was sent");
}
const out = resolve(process.env.VYKOR_EVAL_OUT ?? resolve(tmpdir(), "vykor-agent-baseline.json"));
const rel = relative(resolve(tmpdir()), out);
if (!isAbsolute(out) || rel.startsWith("..") || isAbsolute(rel)) throw new Error("VYKOR_EVAL_OUT must be under the system temporary directory");
const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const fixtureVersion = "agent-behavior-v2";
const records: BehaviorResult[] = [];

const caseMetadata = behaviorCases.map(({ id, prompt, manualChecks, setup }) => {
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
  writeFileSync(out, JSON.stringify({
    mode, revision, fixtureVersion,
    model: "scripted", parameters: { maxTurns: 20, maxRequests: 25, timeoutMs: 120_000 },
    permission: { sandbox: false, mcpServers: {}, pluginsEnabled: false, hostTools: "case fixture only" },
    cases: caseMetadata,
    results: records,
  }, null, 2));
}

describe("cross-task behavior baseline (scripted)", () => {
  for (const scenario of behaviorCases) {
    for (let repeat = 1; repeat <= 3; repeat++) {
      it(`${scenario.id} repeat ${repeat}`, async () => {
        const result = await runBehaviorCase(scenario, {
          client: scenario.scripted!(), model: "scripted", revision, repeat,
          maxRequests: 25, timeoutMs: 120_000,
        });
        records.push(result);
        save();
        expect(["passed", "pending_review"], `${scenario.id}: ${result.status}: ${result.reason}`).toContain(result.status);
      });
    }
  }
});
