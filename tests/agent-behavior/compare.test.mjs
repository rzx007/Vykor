import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./compare.mjs", import.meta.url));
const baseline = {
  mode: "scripted", model: "scripted", revision: "base", fixtureVersion: "test-v1", fixtureSha256: "a".repeat(64),
  parameters: { repeats: 1, maxRequests: 4 }, permission: { sandbox: false },
  cases: [{ id: "A" }, { id: "B" }, { id: "C" }],
  results: [
    { caseId: "A", repeat: 1, status: "passed", evidence: { finalText: "fixture" } },
    { caseId: "B", repeat: 1, status: "pending_review" },
    { caseId: "C", repeat: 1, status: "failed" },
  ],
};

function runCompare(candidate, snapshot = false) {
  const directory = mkdtempSync(join(tmpdir(), "vykor-eval-compare-"));
  try {
    const base = join(directory, "baseline.json");
    const result = join(directory, "candidate.json");
    writeFileSync(base, JSON.stringify(baseline));
    writeFileSync(result, JSON.stringify(candidate));
    return spawnSync(process.execPath, [script, ...(snapshot ? ["--snapshot", result] : [base, result])], { encoding: "utf8" });
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

test("compares matched samples and keeps pending review and known failures separate", () => {
  const result = runCompare({ ...baseline, revision: "candidate", results: [...baseline.results].reverse() });
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.deepEqual(summary.candidate, { passed: 1, pending_review: 1, failed: 1 });
  assert.deepEqual(summary.knownFailures, ["C#1"]);
});

test("fails the gate on a newly failing sample", () => {
  const result = runCompare({ ...baseline, results: baseline.results.map(sample => sample.caseId === "A" ? { ...sample, status: "failed" } : sample) });
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout).regressions, ["A#1: passed -> failed"]);
});

test("rejects mismatched conditions and incomplete or duplicate samples", () => {
  for (const [candidate, error] of [
    [{ ...baseline, parameters: { ...baseline.parameters, maxRequests: 5 } }, /parameters/],
    [{ ...baseline, fixtureSha256: "b".repeat(64) }, /fixtureSha256/],
    [{ ...baseline, results: baseline.results.slice(1) }, /[Mm]issing.*A#1/],
    [{ ...baseline, results: [{ ...baseline.results[0], status: "not_run" }, ...baseline.results.slice(1)] }, /Incomplete.*A#1/],
    [{ ...baseline, results: [...baseline.results, baseline.results[0]] }, /[Dd]uplicate.*A#1/],
  ]) {
    const result = runCompare(candidate);
    assert.equal(result.status, 1);
    assert.match(result.stderr, error);
  }
});

test("refuses to create a baseline from a report missing the fixture hash", () => {
  const result = runCompare({ ...baseline, fixtureSha256: undefined }, true);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /[Mm]issing.*fixtureSha256/);
});

test("snapshots reproducible conditions and outcomes without storing raw evidence", () => {
  const exported = runCompare(baseline, true);
  assert.equal(exported.status, 0, exported.stderr);
  const snapshot = JSON.parse(exported.stdout);
  assert.deepEqual(snapshot.cases, baseline.cases);
  assert.deepEqual(snapshot.results[0], { caseId: "A", repeat: 1, status: "passed" });
});
