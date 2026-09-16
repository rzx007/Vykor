import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  evaluateClientCompatIntegrity,
  readOpenHarnessClientMethodNames,
  readStage7CompatibilityMethods,
} from "./client-compat-integrity.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const defaults = {
  ledgerPath: resolve(scriptDir, "client-compat-removal-ledger.json"),
  contractPath: resolve(scriptDir, "client-public-api-contract.json"),
  sourcePath: resolve(repoRoot, "packages/client/src/transport/http-client.ts"),
  repoPath: repoRoot,
};
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const fullCommitPattern = /^[0-9a-f]{40}$/i;

function parseSemver(version) {
  const match = semverPattern.exec(version ?? "");
  return match ? match.slice(1).map((part) => BigInt(part)) : null;
}

function compareSemver(left, right) {
  const leftParts = parseSemver(left);
  const rightParts = parseSemver(right);
  if (!leftParts || !rightParts) return null;
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] < rightParts[index]) return -1;
    if (leftParts[index] > rightParts[index]) return 1;
  }
  return 0;
}

function parseTimestamp(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  ) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function computeReleaseEvidenceSha256(deprecation, retention) {
  const normalize = (evidence) => ({
    carrier: evidence.carrier,
    version: evidence.version,
    tag: evidence.tag,
    commit: evidence.commit,
    publishedAt: evidence.publishedAt,
    channel: evidence.channel,
    releaseNoteUrl: evidence.releaseNoteUrl,
    workflowRunUrl: evidence.workflowRunUrl,
    npm: {
      package: evidence.npm?.package,
      version: evidence.npm?.version,
      verified: evidence.npm?.verified,
    },
  });
  return createHash("sha256")
    .update(JSON.stringify({
      deprecation: normalize(deprecation),
      retention: normalize(retention),
    }))
    .digest("hex");
}

function validateReleaseEvidence(label, evidence, ledger, git, errors) {
  if (evidence === "pending") {
    errors.push(`${label} release is pending`);
    return null;
  }
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    errors.push(`${label} release must be an evidence object`);
    return null;
  }

  const carrier = ledger?.carrier?.package;
  if (evidence.carrier !== carrier) errors.push(`${label} carrier must be ${carrier}`);
  if (evidence.channel !== "stable" || ledger?.carrier?.channel !== "stable") {
    errors.push(`${label} channel must be stable`);
  }
  const version = parseSemver(evidence.version);
  if (!version) errors.push(`${label} version must use x.y.z`);
  if (evidence.tag !== `v${evidence.version}`) {
    errors.push(`${label} tag must equal v${evidence.version}`);
  }
  if (!fullCommitPattern.test(evidence.commit ?? "")) {
    errors.push(`${label} commit must be a full 40 character Git commit`);
  }
  const publishedAt = parseTimestamp(evidence.publishedAt);
  if (publishedAt === null) errors.push(`${label} publishedAt must be an ISO timestamp`);

  const expectedReleaseUrl = `https://github.com/${ledger.repository}/releases/tag/${evidence.tag}`;
  if (evidence.releaseNoteUrl !== expectedReleaseUrl) {
    errors.push(`${label} releaseNoteUrl must equal ${expectedReleaseUrl}`);
  }
  const workflowPattern = new RegExp(
    `^https://github\\.com/${escapeRegExp(ledger.repository)}/actions/runs/[1-9]\\d*$`,
  );
  if (!workflowPattern.test(evidence.workflowRunUrl ?? "")) {
    errors.push(`${label} workflowRunUrl must identify this repository workflow run`);
  }
  if (
    evidence.npm?.package !== carrier ||
    evidence.npm?.version !== evidence.version ||
    evidence.npm?.verified !== true
  ) {
    errors.push(`${label} npm evidence must verify ${carrier}@${evidence.version}`);
  }

  if (fullCommitPattern.test(evidence.commit ?? "")) {
    if (!git.commitExists(evidence.commit)) {
      errors.push(`${label} commit does not exist: ${evidence.commit}`);
    }
    if (git.tagCommit(evidence.tag) !== evidence.commit) {
      errors.push(`${label} tag ${evidence.tag} does not resolve to its commit`);
    }
    if (!git.isAncestor(ledger.baseline.stage7Commit, evidence.commit)) {
      errors.push(`${label} commit does not contain the Stage 7 baseline`);
    }
  }
  return { evidence, version, publishedAt };
}

export function evaluateClientCompatRemovalGate({
  ledger,
  contractEntries,
  sourceMethodNames,
  stage7Methods,
  git,
}) {
  const integrity = evaluateClientCompatIntegrity({
    ledger,
    contractEntries,
    sourceMethodNames,
    stage7Methods,
  });
  const evidenceErrors = [];
  const deprecation = validateReleaseEvidence(
    "deprecation",
    ledger?.releases?.deprecation,
    ledger,
    git,
    evidenceErrors,
  );
  const retention = validateReleaseEvidence(
    "retention",
    ledger?.releases?.retention,
    ledger,
    git,
    evidenceErrors,
  );

  if (deprecation && retention) {
    if (compareSemver(retention.evidence.version, deprecation.evidence.version) <= 0) {
      evidenceErrors.push("retention release must be newer than deprecation release");
    }
    if (retention.publishedAt <= deprecation.publishedAt) {
      evidenceErrors.push("retention publishedAt must be after deprecation publishedAt");
    }
    if (retention.evidence.tag === deprecation.evidence.tag) {
      evidenceErrors.push("retention release must use a different tag");
    }
    if (retention.evidence.commit === deprecation.evidence.commit) {
      evidenceErrors.push("retention release must use a different commit");
    }
  }

  const authorizationErrors = [];
  const authorization = ledger?.authorization;
  if (authorization?.status === "pending") {
    authorizationErrors.push("removal authorization is pending");
  } else if (authorization?.status === "ready" || authorization?.status === "consumed") {
    const target = parseSemver(authorization.targetVersion);
    const retentionVersion = retention?.version;
    if (
      !target ||
      !retentionVersion ||
      target[0] <= retentionVersion[0] ||
      target[1] !== 0n ||
      target[2] !== 0n
    ) {
      authorizationErrors.push("targetVersion must be a higher major x.0.0 than retention release");
    }
    if (authorization.baselineSha256 !== ledger?.baseline?.methodsSha256) {
      authorizationErrors.push("authorization baselineSha256 does not match ledger baseline");
    }
    const expectedEvidenceSha256 = deprecation && retention
      ? computeReleaseEvidenceSha256(deprecation.evidence, retention.evidence)
      : null;
    if (authorization.evidenceSha256 !== expectedEvidenceSha256) {
      authorizationErrors.push("authorization evidenceSha256 does not match release evidence");
    }
    const authorizedAt = parseTimestamp(authorization.authorizedAt);
    if (authorizedAt === null || (retention && authorizedAt < retention.publishedAt)) {
      authorizationErrors.push("authorization authorizedAt must not precede retention release");
    }
  } else {
    authorizationErrors.push(`unsupported removal authorization status: ${String(authorization?.status)}`);
  }

  const reasons = [...integrity.errors, ...evidenceErrors, ...authorizationErrors];
  return {
    ready: reasons.length === 0,
    releaseEvidenceReady: evidenceErrors.length === 0,
    integrityReady: integrity.ok,
    lifecycle: integrity.lifecycle,
    compatibilityEntries: ledger?.baseline?.methodCount ?? 0,
    blockedEntries: reasons.length === 0 ? 0 : ledger?.baseline?.methodCount ?? 0,
    integrityErrors: integrity.errors,
    evidenceErrors,
    authorizationErrors,
    reasons,
  };
}

export function createGitVerifier(cwd) {
  function run(args) {
    return spawnSync("git", args, { cwd, encoding: "utf8", shell: false });
  }
  return {
    commitExists(commit) {
      return run(["cat-file", "-e", `${commit}^{commit}`]).status === 0;
    },
    tagCommit(tag) {
      const result = run(["rev-list", "-n", "1", tag]);
      return result.status === 0 ? result.stdout.trim() : null;
    },
    isAncestor(ancestor, commit) {
      return run(["merge-base", "--is-ancestor", ancestor, commit]).status === 0;
    },
  };
}

export function parseClientCompatRemovalGateArgs(argv) {
  const options = { ...defaults, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    const key = {
      "--ledger": "ledgerPath",
      "--contract": "contractPath",
      "--source": "sourcePath",
      "--repo": "repoPath",
    }[arg];
    if (!key) throw new Error(`Unknown argument: ${arg}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a path`);
    options[key] = resolve(value);
  }
  return options;
}

function printHuman(result) {
  console.log(`Client compatibility removal gate: ${result.ready ? "READY" : "BLOCKED"}`);
  console.log(`Compatibility methods: ${result.compatibilityEntries}`);
  console.log(`Blocked methods: ${result.blockedEntries}`);
  console.log(`Release evidence: ${result.releaseEvidenceReady ? "READY" : "BLOCKED"}`);
  console.log(`Integrity: ${result.integrityReady ? "PASS" : "FAIL"}`);
  for (const reason of result.reasons) console.log(`- ${reason}`);
}

async function main() {
  try {
    const options = parseClientCompatRemovalGateArgs(process.argv.slice(2));
    const ledger = JSON.parse(readFileSync(options.ledgerPath, "utf8"));
    const contract = JSON.parse(readFileSync(options.contractPath, "utf8"));
    const names = new Set(ledger.baseline.methods.map((method) => method.name));
    const sourceMethodNames = await readOpenHarnessClientMethodNames(options.sourcePath, names);
    const stage7Methods = readStage7CompatibilityMethods(
      options.repoPath,
      ledger.baseline.stage7Commit,
    );
    const result = evaluateClientCompatRemovalGate({
      ledger,
      contractEntries: contract.entries,
      sourceMethodNames,
      stage7Methods,
      git: createGitVerifier(options.repoPath),
    });
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else printHuman(result);
    if (!result.ready) process.exitCode = 1;
  } catch (error) {
    console.error(`Client compatibility removal gate error: ${error.message}`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
