import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  computeReleaseEvidenceSha256,
  evaluateClientCompatRemovalGate,
  parseClientCompatRemovalGateArgs,
} from "./client-compat-removal-gate.mjs";

const scriptPath = fileURLToPath(new URL("./client-compat-removal-gate.mjs", import.meta.url));
const stage7Commit = "3333333333333333333333333333333333333333";
const deprecationCommit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const retentionCommit = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const baselineSha256 = "1b90357e8dc1c334b55e1feab5f06615fddac1679a87479f1774cf9462863019";
const methods = [
  { name: "legacy0", replacement: "sessions.method0" },
  { name: "legacy1", replacement: "sessions.method1" },
];

const deprecationRelease = {
  carrier: "@rzx/ohs",
  version: "1.2.0",
  tag: "v1.2.0",
  commit: deprecationCommit,
  publishedAt: "2026-09-20T10:00:00.000Z",
  channel: "stable",
  releaseNoteUrl: "https://github.com/rzx007/openharness-ts/releases/tag/v1.2.0",
  workflowRunUrl: "https://github.com/rzx007/openharness-ts/actions/runs/120",
  npm: { package: "@rzx/ohs", version: "1.2.0", verified: true },
};

const retentionRelease = {
  carrier: "@rzx/ohs",
  version: "1.3.0",
  tag: "v1.3.0",
  commit: retentionCommit,
  publishedAt: "2026-09-20T11:00:00.000Z",
  channel: "stable",
  releaseNoteUrl: "https://github.com/rzx007/openharness-ts/releases/tag/v1.3.0",
  workflowRunUrl: "https://github.com/rzx007/openharness-ts/actions/runs/130",
  npm: { package: "@rzx/ohs", version: "1.3.0", verified: true },
};

function evidenceSha256(deprecation, retention) {
  return computeReleaseEvidenceSha256(deprecation, retention);
}

function ledger(overrides = {}) {
  const releases = overrides.releases ?? {
    deprecation: deprecationRelease,
    retention: retentionRelease,
  };
  return {
    version: 1,
    repository: "rzx007/openharness-ts",
    baseline: {
      stage7Commit,
      methodCount: 2,
      methodsSha256: baselineSha256,
      methods,
    },
    carrier: { package: "@rzx/ohs", channel: "stable" },
    releases,
    authorization: {
      status: "ready",
      targetVersion: "2.0.0",
      authorizedAt: "2026-09-20T12:00:00.000Z",
      baselineSha256,
      evidenceSha256: evidenceSha256(releases.deprecation, releases.retention),
    },
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

function gitVerifier(overrides = {}) {
  return {
    commitExists: (commit) => [stage7Commit, deprecationCommit, retentionCommit].includes(commit),
    tagCommit: (tag) => ({ "v1.2.0": deprecationCommit, "v1.3.0": retentionCommit }[tag] ?? null),
    isAncestor: (ancestor, commit) => ancestor === stage7Commit && commit !== stage7Commit,
    ...overrides,
  };
}

function evaluate(customLedger = ledger(), overrides = {}) {
  return evaluateClientCompatRemovalGate({
    ledger: customLedger,
    contractEntries: contractEntries(),
    sourceMethodNames: new Set(["legacy0", "legacy1"]),
    stage7Methods: methods,
    git: gitVerifier(),
    ...overrides,
  });
}

function runGit(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test("authorizes only two real stable releases and a major target", () => {
  const result = evaluate();
  assert.equal(result.ready, true);
  assert.equal(result.releaseEvidenceReady, true);
  assert.deepEqual(result.reasons, []);
});

test("release evidence digest is independent of JSON property order", () => {
  const reordered = {
    npm: deprecationRelease.npm,
    workflowRunUrl: deprecationRelease.workflowRunUrl,
    releaseNoteUrl: deprecationRelease.releaseNoteUrl,
    channel: deprecationRelease.channel,
    publishedAt: deprecationRelease.publishedAt,
    commit: deprecationRelease.commit,
    tag: deprecationRelease.tag,
    version: deprecationRelease.version,
    carrier: deprecationRelease.carrier,
  };
  assert.equal(
    computeReleaseEvidenceSha256(reordered, retentionRelease),
    computeReleaseEvidenceSha256(deprecationRelease, retentionRelease),
  );
});

test("classification changes cannot shrink the immutable baseline", () => {
  const result = evaluate(ledger(), { contractEntries: contractEntries(["compatibility", "advanced"]) });
  assert.equal(result.ready, false);
  assert.ok(result.integrityErrors.length > 0);
  assert.match(result.reasons.join("\n"), /contract compatibility methods differ from ledger baseline/);
});

test("pending evidence remains a normal blocked state", () => {
  const releases = { deprecation: "pending", retention: "pending" };
  const result = evaluate(ledger({
    releases,
    authorization: {
      status: "pending",
      targetVersion: null,
      authorizedAt: null,
      baselineSha256: null,
      evidenceSha256: null,
    },
  }));
  assert.equal(result.ready, false);
  assert.equal(result.releaseEvidenceReady, false);
  assert.match(result.reasons.join("\n"), /deprecation release is pending/);
  assert.match(result.reasons.join("\n"), /retention release is pending/);
});

test("rejects nightly evidence, nonexistent commits, tag mismatch and missing ancestry", () => {
  const nightly = { ...deprecationRelease, channel: "nightly" };
  const releases = { deprecation: nightly, retention: retentionRelease };
  const result = evaluate(ledger({
    releases,
    authorization: {
      ...ledger().authorization,
      evidenceSha256: evidenceSha256(nightly, retentionRelease),
    },
  }), {
    git: gitVerifier({
      commitExists: (commit) => commit !== deprecationCommit,
      tagCommit: () => stage7Commit,
      isAncestor: () => false,
    }),
  });
  const reasons = result.reasons.join("\n");
  assert.ok(result.evidenceErrors.length > 0);
  assert.match(reasons, /channel must be stable/);
  assert.match(reasons, /commit does not exist/);
  assert.match(reasons, /tag v1\.2\.0 does not resolve to its commit/);
  assert.match(reasons, /does not contain the Stage 7 baseline/);
});

test("rejects preview, reused releases and backwards publication time", () => {
  const reused = {
    ...retentionRelease,
    version: deprecationRelease.version,
    tag: deprecationRelease.tag,
    commit: deprecationRelease.commit,
    publishedAt: "2026-09-20T09:00:00.000Z",
    channel: "preview",
    releaseNoteUrl: deprecationRelease.releaseNoteUrl,
    npm: { ...retentionRelease.npm, version: deprecationRelease.version },
  };
  const releases = { deprecation: deprecationRelease, retention: reused };
  const result = evaluate(ledger({
    releases,
    authorization: {
      ...ledger().authorization,
      evidenceSha256: evidenceSha256(deprecationRelease, reused),
    },
  }), {
    git: gitVerifier({ tagCommit: () => deprecationCommit }),
  });
  const reasons = result.reasons.join("\n");
  assert.match(reasons, /channel must be stable/);
  assert.match(reasons, /must be newer than deprecation release/);
  assert.match(reasons, /publishedAt must be after deprecation publishedAt/);
  assert.match(reasons, /must use a different tag/);
  assert.match(reasons, /must use a different commit/);
});

test("requires a major x.0.0 removal target and matching authorization digests", () => {
  const invalid = ledger({
    authorization: {
      ...ledger().authorization,
      targetVersion: "1.4.0",
      baselineSha256: "0".repeat(64),
      evidenceSha256: "f".repeat(64),
    },
  });
  const result = evaluate(invalid);
  const reasons = result.reasons.join("\n");
  assert.ok(result.authorizationErrors.length > 0);
  assert.match(reasons, /targetVersion must be a higher major x\.0\.0/);
  assert.match(reasons, /authorization baselineSha256 does not match/);
  assert.match(reasons, /authorization evidenceSha256 does not match/);
});

test("compares arbitrarily large SemVer majors without Number precision loss", () => {
  const first = {
    ...deprecationRelease,
    version: "9007199254740992.0.0",
    tag: "v9007199254740992.0.0",
    npm: { ...deprecationRelease.npm, version: "9007199254740992.0.0" },
    releaseNoteUrl: "https://github.com/rzx007/openharness-ts/releases/tag/v9007199254740992.0.0",
  };
  const second = {
    ...retentionRelease,
    version: "9007199254740993.0.0",
    tag: "v9007199254740993.0.0",
    npm: { ...retentionRelease.npm, version: "9007199254740993.0.0" },
    releaseNoteUrl: "https://github.com/rzx007/openharness-ts/releases/tag/v9007199254740993.0.0",
  };
  const releases = { deprecation: first, retention: second };
  const customLedger = ledger({
    releases,
    authorization: {
      ...ledger().authorization,
      targetVersion: "9007199254740994.0.0",
      evidenceSha256: evidenceSha256(first, second),
    },
  });
  const result = evaluate(customLedger, {
    git: gitVerifier({
      tagCommit: (tag) => tag === first.tag ? first.commit : second.commit,
    }),
  });
  assert.equal(result.ready, true);
});

test("accepts the consumed deletion state with zero compatibility contract entries", () => {
  const consumed = ledger({
    authorization: { ...ledger().authorization, status: "consumed" },
    removal: {
      status: "removed",
      commit: "cccccccccccccccccccccccccccccccccccccccc",
    },
  });
  const result = evaluate(consumed, {
    contractEntries: [],
    sourceMethodNames: new Set(),
  });
  assert.equal(result.ready, true);
  assert.equal(result.compatibilityEntries, 2);
  assert.equal(result.blockedEntries, 0);
});

test("rejects malformed timestamps, release URLs, workflow URLs and npm evidence", () => {
  const malformed = {
    ...deprecationRelease,
    version: "01.2.0",
    tag: "release-1.2.0",
    publishedAt: "2026-09-20",
    releaseNoteUrl: "https://example.com/v1.2.0",
    workflowRunUrl: "https://github.com/other/repo/actions/runs/1",
    npm: { package: "@rzx/other", version: "1.2.0", verified: false },
  };
  const releases = { deprecation: malformed, retention: retentionRelease };
  const result = evaluate(ledger({
    releases,
    authorization: {
      ...ledger().authorization,
      evidenceSha256: evidenceSha256(malformed, retentionRelease),
    },
  }));
  const reasons = result.reasons.join("\n");
  assert.match(reasons, /version must use x\.y\.z/);
  assert.match(reasons, /tag must equal/);
  assert.match(reasons, /publishedAt must be an ISO timestamp/);
  assert.match(reasons, /releaseNoteUrl must equal/);
  assert.match(reasons, /workflowRunUrl must identify this repository workflow run/);
  assert.match(reasons, /npm evidence must verify/);
});

test("CLI reports pending ledger as BLOCKED JSON with exit code 1", () => {
  const cwd = mkdtempSync(join(tmpdir(), "client-removal-cli-"));
  try {
    const pendingLedger = ledger({
      releases: { deprecation: "pending", retention: "pending" },
      authorization: {
        status: "pending",
        targetVersion: null,
        authorizedAt: null,
        baselineSha256: null,
        evidenceSha256: null,
      },
    });
    pendingLedger.baseline.stage7Commit = "3860bf771194845818660075caf2f5048a0f3821";
    const ledgerPath = join(cwd, "ledger.json");
    const contractPath = join(cwd, "contract.json");
    const sourcePath = join(cwd, "http-client.ts");
    writeFileSync(ledgerPath, JSON.stringify(pendingLedger));
    writeFileSync(contractPath, JSON.stringify({ entries: contractEntries() }));
    writeFileSync(sourcePath, "export class OpenHarnessClient { legacy0() {} legacy1() {} }");

    const result = spawnSync(process.execPath, [
      scriptPath,
      "--ledger", ledgerPath,
      "--contract", contractPath,
      "--source", sourcePath,
      "--repo", process.cwd(),
      "--json",
    ], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.equal(result.stderr, "");
    assert.equal(JSON.parse(result.stdout).ready, false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("CLI reports READY only for a Git-verifiable two-release ledger", () => {
  const cwd = mkdtempSync(join(tmpdir(), "client-removal-ready-cli-"));
  try {
    mkdirSync(join(cwd, "scripts"), { recursive: true });
    const entries = contractEntries();
    const contractPath = join(cwd, "scripts", "client-public-api-contract.json");
    writeFileSync(contractPath, JSON.stringify({ entries }));
    runGit(cwd, ["init"]);
    runGit(cwd, ["config", "user.email", "test@example.com"]);
    runGit(cwd, ["config", "user.name", "Test"]);
    runGit(cwd, ["add", "scripts/client-public-api-contract.json"]);
    runGit(cwd, ["commit", "-m", "stage 7"]);
    const stage7 = runGit(cwd, ["rev-parse", "HEAD"]);
    runGit(cwd, ["commit", "--allow-empty", "-m", "deprecation release"]);
    const firstCommit = runGit(cwd, ["rev-parse", "HEAD"]);
    runGit(cwd, ["tag", "v1.2.0"]);
    runGit(cwd, ["commit", "--allow-empty", "-m", "retention release"]);
    const secondCommit = runGit(cwd, ["rev-parse", "HEAD"]);
    runGit(cwd, ["tag", "v1.3.0"]);

    const first = { ...deprecationRelease, commit: firstCommit };
    const second = { ...retentionRelease, commit: secondCommit };
    const readyLedger = ledger({
      baseline: { ...ledger().baseline, stage7Commit: stage7 },
      releases: { deprecation: first, retention: second },
      authorization: {
        ...ledger().authorization,
        evidenceSha256: evidenceSha256(first, second),
      },
    });
    const ledgerPath = join(cwd, "ledger.json");
    const sourcePath = join(cwd, "http-client.ts");
    writeFileSync(ledgerPath, JSON.stringify(readyLedger));
    writeFileSync(sourcePath, "export class OpenHarnessClient { legacy0() {} legacy1() {} }");

    const result = spawnSync(process.execPath, [
      scriptPath,
      "--ledger", ledgerPath,
      "--contract", contractPath,
      "--source", sourcePath,
      "--repo", cwd,
      "--json",
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(JSON.parse(result.stdout).ready, true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("CLI parser rejects missing path values and unknown arguments", () => {
  assert.throws(() => parseClientCompatRemovalGateArgs(["--ledger", "--json"]), /--ledger requires a path/);
  assert.throws(() => parseClientCompatRemovalGateArgs(["--wat"]), /Unknown argument: --wat/);
});

test("CLI returns exit code 2 with a concise error for invalid JSON", () => {
  const cwd = mkdtempSync(join(tmpdir(), "client-removal-invalid-json-"));
  try {
    const ledgerPath = join(cwd, "ledger.json");
    writeFileSync(ledgerPath, "{");
    const result = spawnSync(process.execPath, [scriptPath, "--ledger", ledgerPath], {
      encoding: "utf8",
    });
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^Client compatibility removal gate error:/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
