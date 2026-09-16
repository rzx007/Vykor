import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultLedgerPath = resolve(scriptDir, "client-compat-removal-ledger.json");
const phases = new Set([
  "regular",
  "client-deprecation",
  "client-retention",
  "client-breaking-removal",
]);
const stableVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const fullCommitPattern = /^[0-9a-f]{40}$/i;
const sha256Pattern = /^[0-9a-f]{64}$/i;

export class ClientCompatReleaseError extends Error {
  constructor(message) {
    super(message);
    this.name = "ClientCompatReleaseError";
  }
}

function parseVersion(version) {
  const match = stableVersionPattern.exec(version ?? "");
  if (!match) throw new ClientCompatReleaseError(`version must be stable X.Y.Z: ${String(version)}`);
  return match.slice(1).map(BigInt);
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] < b[index]) return -1;
    if (a[index] > b[index]) return 1;
  }
  return 0;
}

function isEvidence(value) {
  return value && typeof value === "object" && typeof value.version === "string";
}

export function validateReleasePhase({ phase, version, ledger }) {
  if (!phases.has(phase)) {
    throw new ClientCompatReleaseError(`unsupported release phase: ${String(phase)}`);
  }
  parseVersion(version);
  const methodCount = ledger?.baseline?.methodCount;
  if (!Number.isInteger(methodCount) || methodCount <= 0) {
    throw new ClientCompatReleaseError("ledger baseline methodCount is invalid");
  }

  if (phase === "client-deprecation") {
    if (ledger.releases?.deprecation !== "pending") {
      throw new ClientCompatReleaseError("deprecation release must still be pending");
    }
    if (ledger.releases?.retention !== "pending" || ledger.authorization?.status !== "pending") {
      throw new ClientCompatReleaseError("deprecation release requires untouched retention and authorization state");
    }
  }

  if (phase === "client-retention") {
    if (!isEvidence(ledger.releases?.deprecation)) {
      throw new ClientCompatReleaseError("retention release requires recorded deprecation evidence");
    }
    if (ledger.releases?.retention !== "pending") {
      throw new ClientCompatReleaseError("retention release must still be pending");
    }
    if (compareVersions(version, ledger.releases.deprecation.version) <= 0) {
      throw new ClientCompatReleaseError("retention version must be newer than deprecation release");
    }
  }

  if (phase === "client-breaking-removal") {
    if (ledger.authorization?.status !== "consumed") {
      throw new ClientCompatReleaseError("breaking removal requires consumed authorization");
    }
    if (version !== ledger.authorization.targetVersion) {
      throw new ClientCompatReleaseError("breaking removal version must equal authorized targetVersion");
    }
    if (ledger.removal?.status !== "removed" || !fullCommitPattern.test(ledger.removal?.commit ?? "")) {
      throw new ClientCompatReleaseError("consumed authorization requires a recorded removal commit");
    }
  }

  return { phase, version, methodCount };
}

function commonNotes(version) {
  return [
    "## Desktop",
    `- Windows: \`OpenHarness-${version}-setup.exe\``,
    `- Linux AppImage: \`OpenHarness-${version}.AppImage\``,
    `- Linux deb: \`OpenHarness-${version}.deb\``,
    "",
    "## CLI",
    "```bash",
    `npm install -g @rzx/ohs@${version}`,
    "```",
  ];
}

export function renderReleaseNotes({ phase, version, ledger }) {
  validateReleasePhase({ phase, version, ledger });
  const count = ledger.baseline.methodCount;
  const lines = [`# OpenHarness ${version}`, "", ...commonNotes(version), ""];

  if (phase === "regular") {
    lines.push("## Compatibility", "This regular release does not change the client compatibility-removal lifecycle.");
  } else if (phase === "client-deprecation") {
    lines.push(
      "## Client API deprecation window (A)",
      `All ${count} compatibility methods are deprecated. They remain callable in this release.`,
      "Migrate to the domain APIs using `docs/client-public-api-migration.md`.",
      "The earliest removal is the next major release, and only after a separate retention release.",
    );
  } else if (phase === "client-retention") {
    lines.push(
      "## Client API retention window (B)",
      `This release still retains all ${count} compatibility methods.`,
      "This is the final guaranteed retention release; an authorized next major may remove them.",
      "Migrate now using `docs/client-public-api-migration.md`.",
    );
  } else {
    lines.push(
      "## Breaking change: legacy client facade removal (C)",
      `This major release removes all ${count} deprecated compatibility methods.`,
      "Upgrade calls to the domain APIs before installing this major version.",
      "",
      "| Removed method | Replacement |",
      "|---|---|",
      ...ledger.baseline.methods.map(({ name, replacement }) => `| \`${name}\` | \`${replacement}\` |`),
    );
  }
  return `${lines.join("\n")}\n`;
}

function assertUrl(value, pattern, label) {
  if (!pattern.test(value ?? "")) throw new ClientCompatReleaseError(`${label} is invalid`);
}

export function buildReleaseEvidence(input) {
  if (!phases.has(input.phase)) throw new ClientCompatReleaseError("release phase is invalid");
  parseVersion(input.version);
  if (input.tag !== `v${input.version}`) throw new ClientCompatReleaseError("tag must match version");
  if (!fullCommitPattern.test(input.commit ?? "")) throw new ClientCompatReleaseError("commit must be a full Git SHA");
  if (Number.isNaN(Date.parse(input.publishedAt)) || !input.publishedAt.includes("T")) {
    throw new ClientCompatReleaseError("publishedAt must be an ISO timestamp");
  }
  assertUrl(input.workflowRunUrl, /^https:\/\/github\.com\/rzx007\/openharness-ts\/actions\/runs\/\d+$/, "workflowRunUrl");
  assertUrl(input.releaseNoteUrl, new RegExp(`^https://github\\.com/rzx007/openharness-ts/releases/tag/v${input.version.replaceAll(".", "\\.")}$`), "releaseNoteUrl");
  if (input.npm?.package !== "@rzx/ohs") throw new ClientCompatReleaseError("npm package must be @rzx/ohs");
  if (input.npm.version !== input.version || input.npmVerified !== true) {
    throw new ClientCompatReleaseError("npm version must match and be verified");
  }
  if (!sha256Pattern.test(input.releaseNotesSha256 ?? "")) {
    throw new ClientCompatReleaseError("releaseNotesSha256 must be a SHA-256 digest");
  }
  return {
    phase: input.phase,
    channel: "stable",
    version: input.version,
    tag: input.tag,
    commit: input.commit.toLowerCase(),
    publishedAt: new Date(input.publishedAt).toISOString(),
    workflowRunUrl: input.workflowRunUrl,
    releaseNoteUrl: input.releaseNoteUrl,
    npm: { package: "@rzx/ohs", version: input.version, verified: true },
    checks: {
      npm: "verified",
      releaseNotes: "verified",
      releaseNotesSha256: input.releaseNotesSha256.toLowerCase(),
    },
  };
}

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new ClientCompatReleaseError(`invalid argument near ${String(flag)}`);
    }
    options[flag.slice(2)] = value;
  }
  return { command, options };
}

function readLedger(path = defaultLedgerPath) {
  return JSON.parse(readFileSync(resolve(path), "utf8"));
}

function requireOption(options, name) {
  const value = options[name];
  if (!value) throw new ClientCompatReleaseError(`--${name} is required`);
  return value;
}

function writeResult(output, content) {
  if (output) writeFileSync(resolve(output), content, "utf8");
  else process.stdout.write(content);
}

function main() {
  try {
    const { command, options } = parseArgs(process.argv.slice(2));
    const ledger = readLedger(options.ledger);
    const phase = requireOption(options, "phase");
    const version = requireOption(options, "version");
    if (command === "validate-phase") {
      const result = validateReleasePhase({ phase, version, ledger });
      console.log(`Release phase valid: ${result.phase} ${result.version} (${result.methodCount} methods)`);
      return;
    }
    if (command === "notes") {
      writeResult(options.output, renderReleaseNotes({ phase, version, ledger }));
      return;
    }
    if (command === "evidence") {
      const result = buildReleaseEvidence({
        phase,
        version,
        tag: requireOption(options, "tag"),
        commit: requireOption(options, "commit"),
        publishedAt: requireOption(options, "published-at"),
        workflowRunUrl: requireOption(options, "workflow-run-url"),
        releaseNoteUrl: requireOption(options, "release-note-url"),
        npm: { package: requireOption(options, "npm-package"), version: requireOption(options, "npm-version") },
        npmVerified: options["npm-verified"] === "true",
        releaseNotesSha256: requireOption(options, "release-notes-sha256"),
      });
      writeResult(options.output, `${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    throw new ClientCompatReleaseError("command must be validate-phase, notes, or evidence");
  } catch (error) {
    if (error instanceof ClientCompatReleaseError || error instanceof SyntaxError) {
      console.error(`Client compatibility release error: ${error.message}`);
      process.exitCode = 2;
      return;
    }
    throw error;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
