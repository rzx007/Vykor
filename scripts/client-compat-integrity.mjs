import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultLedgerPath = resolve(scriptDir, "client-compat-removal-ledger.json");
const defaultContractPath = resolve(scriptDir, "client-public-api-contract.json");
const defaultSourcePath = resolve(scriptDir, "../packages/client/src/transport/http-client.ts");
const defaultRepoPath = resolve(scriptDir, "..");
const fullCommitPattern = /^[0-9a-f]{40}$/i;

export function canonicalizeBaselineMethods(methods) {
  return [...methods]
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
    .map((method) => `${method.name}\0${method.replacement}\n`)
    .join("");
}

export function computeBaselineSha256(methods) {
  return createHash("sha256").update(canonicalizeBaselineMethods(methods)).digest("hex");
}

function mapMethods(methods) {
  return new Map(methods.map((method) => [method.name, method.replacement]));
}

function sameMethodMap(left, right) {
  if (left.size !== right.size) return false;
  for (const [name, replacement] of left) {
    if (right.get(name) !== replacement) return false;
  }
  return true;
}

function compatibilityMethods(contractEntries) {
  return mapMethods(contractEntries.filter(
    (entry) => entry.kind === "client-method" && entry.classification === "compatibility",
  ));
}

export function evaluateClientCompatIntegrity({ ledger, contractEntries, sourceMethodNames, stage7Methods }) {
  const errors = [];
  const methods = ledger?.baseline?.methods;
  if (!Array.isArray(methods) || methods.length === 0) {
    return { ok: false, errors: ["ledger baseline.methods must be a non-empty array"] };
  }

  const baseline = mapMethods(methods);
  if (baseline.size !== methods.length) errors.push("ledger baseline contains duplicate method names");
  if (ledger.baseline.methodCount !== methods.length) {
    errors.push(`baseline methodCount must be ${methods.length}`);
  }
  if (ledger.baseline.methodsSha256 !== computeBaselineSha256(methods)) {
    errors.push("baseline methodsSha256 does not match methods");
  }
  if (stage7Methods && !sameMethodMap(mapMethods(methods), mapMethods(stage7Methods))) {
    errors.push("ledger baseline differs from Stage 7 Git snapshot");
  }
  if (!fullCommitPattern.test(ledger.baseline.stage7Commit ?? "")) {
    errors.push("baseline stage7Commit must be a full 40 character Git commit");
  }
  if (ledger?.carrier?.package !== "@rzx/ohs" || ledger?.carrier?.channel !== "stable") {
    errors.push("ledger carrier must be @rzx/ohs stable");
  }
  if (ledger?.repository !== "rzx007/openharness-ts") {
    errors.push("ledger repository must be rzx007/openharness-ts");
  }

  const authorizationStatus = ledger?.authorization?.status;
  const removalStatus = ledger?.removal?.status;
  const contractCompatibility = compatibilityMethods(contractEntries ?? []);
  const contractBaselineNames = new Set(
    (contractEntries ?? [])
      .filter((entry) => baseline.has(entry.name))
      .map((entry) => entry.name),
  );
  const sourceNames = sourceMethodNames instanceof Set
    ? sourceMethodNames
    : new Set(sourceMethodNames ?? []);

  if (authorizationStatus === "pending" || authorizationStatus === "ready") {
    if (removalStatus !== "not-started") {
      errors.push(`${authorizationStatus} authorization requires removal status not-started`);
    }
    if (!sameMethodMap(baseline, contractCompatibility)) {
      errors.push("contract compatibility methods differ from ledger baseline");
    }
    for (const entry of contractEntries ?? []) {
      if (baseline.has(entry.name) && entry.removeIn !== "stage-8-after-release-gate") {
        errors.push(`${entry.name} removeIn must be stage-8-after-release-gate`);
      }
    }
    const missingSource = [...baseline.keys()].filter((name) => !sourceNames.has(name));
    if (missingSource.length > 0) {
      errors.push(`facade methods disappeared before authorization was consumed: ${missingSource.join(", ")}`);
    }
  } else if (authorizationStatus === "consumed") {
    if (removalStatus !== "removed") {
      errors.push("consumed authorization requires removal status removed");
    }
    if (!fullCommitPattern.test(ledger?.removal?.commit ?? "")) {
      errors.push("removed lifecycle requires a full removal commit");
    }
    if (contractBaselineNames.size > 0) {
      errors.push(`removed facade methods remain in public contract: ${[...contractBaselineNames].join(", ")}`);
    }
    const resurrected = [...baseline.keys()].filter((name) => sourceNames.has(name));
    if (resurrected.length > 0) {
      errors.push(`removed facade methods reappeared: ${resurrected.join(", ")}`);
    }
  } else {
    errors.push(`unsupported authorization status: ${String(authorizationStatus)}`);
  }

  return {
    ok: errors.length === 0,
    methodCount: methods.length,
    lifecycle: authorizationStatus ?? null,
    errors,
  };
}

export async function readOpenHarnessClientMethodNames(sourcePath, legacyNames) {
  const ts = await import("typescript");
  const sourceText = readFileSync(sourcePath, "utf8");
  const sourceFile = ts.default.createSourceFile(
    sourcePath,
    sourceText,
    ts.default.ScriptTarget.Latest,
    true,
  );
  const clientClass = sourceFile.statements.find(
    (statement) => ts.default.isClassDeclaration(statement) && statement.name?.text === "OpenHarnessClient",
  );
  if (!clientClass) throw new Error("OpenHarnessClient class was not found");
  return new Set(clientClass.members.flatMap((member) => {
    if (!ts.default.isMethodDeclaration(member)) return [];
    if (ts.default.isIdentifier(member.name)) return [member.name.text];
    if (ts.default.isStringLiteral(member.name)) return [member.name.text];
    return [];
  }).filter((name) => legacyNames.has(name)));
}

export function readStage7CompatibilityMethods(repoPath, commit) {
  const result = spawnSync(
    "git",
    ["show", `${commit}:scripts/client-public-api-contract.json`],
    { cwd: repoPath, encoding: "utf8", shell: false },
  );
  if (result.status !== 0) {
    throw new Error(`cannot read Stage 7 contract from ${commit}`);
  }
  const contract = JSON.parse(result.stdout);
  return contract.entries
    .filter((entry) => entry.kind === "client-method" && entry.classification === "compatibility")
    .map(({ name, replacement }) => ({ name, replacement }));
}

export function parseClientCompatIntegrityArgs(argv) {
  const options = {
    ledgerPath: defaultLedgerPath,
    contractPath: defaultContractPath,
    sourcePath: defaultSourcePath,
    repoPath: defaultRepoPath,
    json: false,
  };
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

async function main() {
  try {
    const options = parseClientCompatIntegrityArgs(process.argv.slice(2));
    const ledger = JSON.parse(readFileSync(options.ledgerPath, "utf8"));
    const contract = JSON.parse(readFileSync(options.contractPath, "utf8"));
    const names = new Set(ledger.baseline.methods.map((method) => method.name));
    const sourceMethodNames = await readOpenHarnessClientMethodNames(options.sourcePath, names);
    const stage7Methods = readStage7CompatibilityMethods(
      options.repoPath,
      ledger.baseline.stage7Commit,
    );
    const result = evaluateClientCompatIntegrity({
      ledger,
      contractEntries: contract.entries,
      sourceMethodNames,
      stage7Methods,
    });
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else console.log(`Client compatibility integrity: ${result.ok ? "PASS" : "FAIL"} (${result.methodCount ?? 0} methods)`);
    if (!result.ok) {
      for (const error of result.errors) console.error(`- ${error}`);
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`Client compatibility integrity error: ${error.message}`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
