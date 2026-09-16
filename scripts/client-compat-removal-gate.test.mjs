import assert from "node:assert/strict";
import test from "node:test";

import { evaluateClientCompatRemovalGate } from "./client-compat-removal-gate.mjs";

const deprecatedRelease = {
  carrier: "@rzx/ohs",
  version: "1.2.0",
  date: "2026-09-20",
  channel: "stable",
  commit: "1111111111111111111111111111111111111111",
};

const retentionRelease = {
  carrier: "@rzx/ohs",
  version: "1.3.0",
  date: "2026-10-20",
  channel: "stable",
  releaseNoteUrl: "https://example.com/releases/v1.3.0",
};

function contract(entries) {
  return {
    carrier: { defaultCarrier: "@rzx/ohs" },
    entries: entries.map((entry, index) => ({
      name: `legacy${index}`,
      kind: "client-method",
      classification: "compatibility",
      removeIn: "stage-8-after-release-gate",
      replacement: `sessions.method${index}`,
      deprecatedCarrierRelease: deprecatedRelease,
      retentionCarrierRelease: retentionRelease,
      ...entry,
    })),
  };
}

test("passes only when every compatibility method has two ordered carrier releases", () => {
  const result = evaluateClientCompatRemovalGate(contract([{}, {}]));

  assert.equal(result.ready, true);
  assert.equal(result.compatibilityEntries, 2);
  assert.equal(result.blockedEntries, 0);
  assert.deepEqual(result.reasons, []);
});

test("blocks pending or missing release evidence", () => {
  const result = evaluateClientCompatRemovalGate(contract([
    { deprecatedCarrierRelease: "pending" },
    { retentionCarrierRelease: null },
  ]));

  assert.equal(result.ready, false);
  assert.equal(result.blockedEntries, 2);
  assert.match(result.reasons.join("\n"), /deprecatedCarrierRelease is pending/);
  assert.match(result.reasons.join("\n"), /retentionCarrierRelease is missing/);
});

test("blocks carrier mismatches and unordered release versions", () => {
  const result = evaluateClientCompatRemovalGate(contract([{
    deprecatedCarrierRelease: { ...deprecatedRelease, carrier: "desktop" },
    retentionCarrierRelease: { ...retentionRelease, version: "1.2.0" },
  }]));

  assert.equal(result.ready, false);
  assert.match(result.reasons.join("\n"), /must use carrier @rzx\/ohs/);
  assert.match(result.reasons.join("\n"), /must be newer than deprecated release/);
});

test("blocks incomplete evidence and backwards dates", () => {
  const result = evaluateClientCompatRemovalGate(contract([{
    deprecatedCarrierRelease: { ...deprecatedRelease, commit: undefined },
    retentionCarrierRelease: { ...retentionRelease, date: "2026-09-01" },
  }]));

  assert.equal(result.ready, false);
  assert.match(result.reasons.join("\n"), /releaseNoteUrl or commit/);
  assert.match(result.reasons.join("\n"), /date must be after deprecated release/);
});

test("blocks malformed release links and commit identifiers", () => {
  const result = evaluateClientCompatRemovalGate(contract([{
    deprecatedCarrierRelease: { ...deprecatedRelease, commit: "not-a-commit" },
    retentionCarrierRelease: { ...retentionRelease, releaseNoteUrl: "release-note" },
  }]));

  assert.equal(result.ready, false);
  assert.match(result.reasons.join("\n"), /commit must be a 7 to 40 character Git hash/);
  assert.match(result.reasons.join("\n"), /releaseNoteUrl must be an HTTP\(S\) URL/);
});

test("blocks inconsistent release evidence across compatibility methods", () => {
  const result = evaluateClientCompatRemovalGate(contract([
    {},
    { retentionCarrierRelease: { ...retentionRelease, version: "1.4.0" } },
  ]));

  assert.equal(result.ready, false);
  assert.equal(result.blockedEntries, 2);
  assert.match(result.reasons.join("\n"), /must describe one shared carrier release/);
});
