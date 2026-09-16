import assert from "node:assert/strict";
import test from "node:test";

import { computeBaselineSha256, evaluateClientCompatIntegrity } from "./client-compat-integrity.mjs";

const methods = [
  { name: "legacy0", replacement: "sessions.method0" },
  { name: "legacy1", replacement: "sessions.method1" },
];

const baselineSha256 = "1b90357e8dc1c334b55e1feab5f06615fddac1679a87479f1774cf9462863019";

function ledger(overrides = {}) {
  return {
    version: 1,
    repository: "rzx007/openharness-ts",
    baseline: {
      stage7Commit: "3860bf771194845818660075caf2f5048a0f3821",
      methodCount: 2,
      methodsSha256: baselineSha256,
      methods,
    },
    carrier: { package: "@rzx/ohs", channel: "stable" },
    releases: { deprecation: "pending", retention: "pending" },
    authorization: { status: "pending", targetVersion: null },
    removal: { status: "not-started", commit: null },
    ...overrides,
  };
}

function contractEntries(classifications = ["compatibility", "compatibility"]) {
  return methods.map((method, index) => ({
    ...method,
    kind: "client-method",
    classification: classifications[index],
    removeIn: "stage-8-after-release-gate",
  }));
}

test("pending lifecycle requires the complete immutable compatibility baseline", () => {
  const ok = evaluateClientCompatIntegrity({
    ledger: ledger(),
    contractEntries: contractEntries(),
    sourceMethodNames: new Set(["legacy0", "legacy1"]),
  });
  assert.deepEqual(ok.errors, []);

  const reclassified = evaluateClientCompatIntegrity({
    ledger: ledger(),
    contractEntries: contractEntries(["compatibility", "advanced"]),
    sourceMethodNames: new Set(["legacy0", "legacy1"]),
  });
  assert.match(reclassified.errors.join("\n"), /contract compatibility methods differ from ledger baseline/);
});

test("rejects compatibility contract entries that bypass the release gate metadata", () => {
  const entries = contractEntries();
  entries[1].removeIn = "stage-8";
  const result = evaluateClientCompatIntegrity({
    ledger: ledger(),
    contractEntries: entries,
    sourceMethodNames: new Set(["legacy0", "legacy1"]),
  });
  assert.match(result.errors.join("\n"), /legacy1 removeIn must be stage-8-after-release-gate/);
});

test("requires the fixed stable CLI carrier", () => {
  const invalid = ledger({ carrier: { package: "", channel: "preview" } });
  const result = evaluateClientCompatIntegrity({
    ledger: invalid,
    contractEntries: contractEntries(),
    sourceMethodNames: new Set(["legacy0", "legacy1"]),
  });
  assert.match(result.errors.join("\n"), /ledger carrier must be @rzx\/ohs stable/);
});

test("requires release evidence to remain bound to this repository", () => {
  const invalid = ledger({ repository: "attacker/fork" });
  const result = evaluateClientCompatIntegrity({
    ledger: invalid,
    contractEntries: contractEntries(),
    sourceMethodNames: new Set(["legacy0", "legacy1"]),
  });
  assert.match(result.errors.join("\n"), /ledger repository must be rzx007\/openharness-ts/);
});

test("consumed lifecycle permits contract removal but keeps every old name tombstoned", () => {
  const removed = evaluateClientCompatIntegrity({
    ledger: ledger({
      authorization: { status: "consumed", targetVersion: "2.0.0" },
      removal: { status: "removed", commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    }),
    contractEntries: [],
    sourceMethodNames: new Set(),
  });
  assert.deepEqual(removed.errors, []);

  const resurrected = evaluateClientCompatIntegrity({
    ledger: ledger({
      authorization: { status: "consumed", targetVersion: "2.0.0" },
      removal: { status: "removed", commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    }),
    contractEntries: [],
    sourceMethodNames: new Set(["legacy0"]),
  });
  assert.match(resurrected.errors.join("\n"), /removed facade methods reappeared: legacy0/);
});

test("rejects a changed baseline even when count and lifecycle still look valid", () => {
  const changed = ledger();
  changed.baseline.methods = [
    { name: "legacy0", replacement: "sessions.changed" },
    methods[1],
  ];

  const result = evaluateClientCompatIntegrity({
    ledger: changed,
    contractEntries: contractEntries(),
    sourceMethodNames: new Set(["legacy0", "legacy1"]),
  });
  assert.match(result.errors.join("\n"), /baseline methodsSha256 does not match methods/);
});

test("anchors the ledger baseline to the immutable Stage 7 Git snapshot", () => {
  const changed = ledger();
  changed.baseline.methods = [
    { name: "legacy0", replacement: "sessions.changed" },
    methods[1],
  ];
  changed.baseline.methodsSha256 = computeBaselineSha256(changed.baseline.methods);

  const result = evaluateClientCompatIntegrity({
    ledger: changed,
    contractEntries: changed.baseline.methods.map((method) => ({
      ...method,
      kind: "client-method",
      classification: "compatibility",
    })),
    sourceMethodNames: new Set(["legacy0", "legacy1"]),
    stage7Methods: methods,
  });
  assert.match(result.errors.join("\n"), /ledger baseline differs from Stage 7 Git snapshot/);
});
