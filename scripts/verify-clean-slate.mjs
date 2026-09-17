import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  collectForbiddenScanFiles,
  createForbiddenScanAllow,
  isForbiddenScanAllowed,
} from "./forbidden-compatibility-scan-policy.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRoot = resolve(dirname(scriptPath), "..");
const verifierForbiddenAllow = [
  "scripts/clean-slate-smoke.test.mjs",
  "scripts/verify-clean-slate.mjs",
];

function normalize(path) {
  return path.replaceAll("\\", "/");
}

function read(root, file) {
  const path = join(root, file);
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

function lineOf(source, index) {
  return source.slice(0, Math.max(0, index)).split("\n").length;
}

function problem(category, file, line, message) {
  return { category, file: normalize(file), line: Math.max(1, line), message };
}

function missing(category, file) {
  return problem(category, file, 1, "required file is missing");
}

async function checkForbidden(root, options = {}) {
  const manifest = join(root, "scripts", "forbidden-compatibility-surfaces.json");
  if (!existsSync(manifest)) return [missing("forbidden", "scripts/forbidden-compatibility-surfaces.json")];
  let results;
  try {
    if (options.forceScannerFailure) throw new Error("scanner failure requested by test");
    const { scanForbiddenSurfaces } = await import("./forbidden-compatibility-surfaces.mjs");
    results = scanForbiddenSurfaces({
      cwd: root,
      manifestPath: manifest,
      allow: verifierForbiddenAllow,
    }).map((entry) => problem("forbidden", entry.file, entry.line, entry.surface));
  } catch (error) {
    return [problem(
      "forbidden",
      "scripts/forbidden-compatibility-surfaces.mjs",
      1,
      `BLOCKED: primary forbidden-surface scanner unavailable: ${error?.message ?? error}`,
    )];
  }

  const explicit = [
    { text: ".claude/skills", label: "removed skill directory" },
  ];
  const allow = createForbiddenScanAllow(verifierForbiddenAllow);
  for (const file of collectForbiddenScanFiles(root)) {
    const rel = normalize(relative(root, file));
    if (isForbiddenScanAllowed(root, file, allow)) continue;
    const source = readFileSync(file, "utf8");
    for (const item of explicit) {
      let offset = source.indexOf(item.text);
      while (offset >= 0) {
        results.push(problem("forbidden", rel, lineOf(source, offset), `${item.label}: ${item.text}`));
        offset = source.indexOf(item.text, offset + item.text.length);
      }
    }
  }
  for (const file of [
    "packages/protocol/src/requests.ts",
    "packages/protocol/src/session.ts",
  ]) {
    const source = read(root, file);
    if (source === undefined) continue;
    for (const match of source.matchAll(/["']migration["']/g)) {
      results.push(problem(
        "forbidden",
        file,
        lineOf(source, match.index),
        'removed scheduled-task creation source: "migration"',
      ));
    }
  }
  return results;
}

async function checkContract(root) {
  const contractFile = "scripts/client-public-api-contract.json";
  const clientFile = "packages/client/src/transport/http-client.ts";
  const contractSource = read(root, contractFile);
  const clientSource = read(root, clientFile);
  const results = [];
  if (contractSource === undefined) return [missing("contract", contractFile)];
  if (clientSource === undefined) return [missing("contract", clientFile)];
  let contract;
  try {
    contract = JSON.parse(contractSource);
  } catch (error) {
    return [problem("contract", contractFile, 1, `invalid JSON: ${error.message}`)];
  }
  const entries = Array.isArray(contract.entries) ? contract.entries : [];
  const keys = entries.map((entry) => `${entry.kind}:${entry.name}`);
  if (new Set(keys).size !== keys.length) results.push(problem("contract", contractFile, 1, "duplicate contract entries"));
  const expectedResources = entries.filter((entry) => entry.kind === "client-resource").map((entry) => entry.name).sort();
  const classBody = clientSource.match(/export class OpenHarnessClient\s*\{([\s\S]*)\}/)?.[1] ?? "";
  const actualResources = [...classBody.matchAll(/\breadonly\s+([A-Za-z_$][\w$]*)\s*:/g)].map((match) => match[1]).sort();
  if (JSON.stringify(actualResources) !== JSON.stringify(expectedResources)) {
    results.push(problem("contract", clientFile, 1, `Resource contract mismatch; expected [${expectedResources.join(", ")}], found [${actualResources.join(", ")}]`));
  }

  const tsconfig = join(root, "packages/client/tsconfig.json");
  if (existsSync(tsconfig)) {
    try {
      const ts = await import("typescript");
      const config = ts.default.readConfigFile(tsconfig, ts.default.sys.readFile);
      const parsed = ts.default.parseJsonConfigFileContent(config.config, ts.default.sys, dirname(tsconfig));
      const program = ts.default.createProgram(parsed.fileNames, parsed.options);
      const checker = program.getTypeChecker();
      const indexPath = resolve(root, "packages/client/src/index.ts");
      const sourceFile = program.getSourceFile(indexPath);
      const moduleSymbol = sourceFile && checker.getSymbolAtLocation(sourceFile);
      if (!moduleSymbol) throw new Error("cannot resolve @openharness/client module symbol");
      const runtime = [];
      const types = [];
      for (const exported of checker.getExportsOfModule(moduleSymbol)) {
        const symbol = exported.flags & ts.default.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
        ((symbol.flags & ts.default.SymbolFlags.Value) !== 0 ? runtime : types).push(exported.name);
      }
      for (const [kind, actual] of [["runtime-export", runtime], ["type-export", types]]) {
        const expected = entries.filter((entry) => entry.kind === kind).map((entry) => entry.name).sort();
        actual.sort();
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          results.push(problem("contract", contractFile, 1, `${kind} contract does not match TypeScript exports`));
        }
      }
    } catch (error) {
      if (error?.code !== "EPERM" && error?.code !== "EACCES") {
        results.push(problem("contract", "packages/client/src/index.ts", 1, `TypeScript contract comparison failed: ${error.message}`));
      }
    }
  }
  return results;
}

function checkMigrations(root) {
  const directory = join(root, "packages/services/src/session-runtime/migrations");
  const rel = "packages/services/src/session-runtime/migrations";
  if (!existsSync(directory)) return [missing("migration", rel)];
  const sql = readdirSync(directory).filter((name) => name.endsWith(".sql")).sort();
  const results = [];
  if (sql.length !== 1 || sql[0] !== "0000_current_schema.sql") {
    results.push(problem("migration", rel, 1, `expected only 0000_current_schema.sql; found [${sql.join(", ")}]`));
  }
  const journalFile = `${rel}/meta/_journal.json`;
  const journalSource = read(root, journalFile);
  if (journalSource === undefined) return [...results, missing("migration", journalFile)];
  try {
    const journal = JSON.parse(journalSource);
    if (journal.entries?.length !== 1 || journal.entries[0]?.idx !== 0 || journal.entries[0]?.tag !== "0000_current_schema") {
      results.push(problem("migration", journalFile, 1, "journal must contain the single 0000_current_schema baseline"));
    }
  } catch (error) {
    results.push(problem("migration", journalFile, 1, `invalid journal JSON: ${error.message}`));
  }
  return results;
}

function requirePattern(results, category, root, file, pattern, message) {
  const source = read(root, file);
  if (source === undefined) {
    results.push(missing(category, file));
  } else if (!pattern.test(source)) {
    results.push(problem(category, file, 1, message));
  }
}

function checkProtocol(root) {
  const results = [];
  requirePattern(results, "protocol", root, "packages/protocol/src/capabilities.ts", /CURRENT_PROTOCOL_VERSION\s*=\s*4\b/, "CURRENT_PROTOCOL_VERSION must be 4");
  requirePattern(results, "protocol", root, "packages/protocol/src/capabilities.ts", /PROTOCOL_VERSION_HEADER\s*=\s*["']x-openharness-protocol-version["']/, "protocol header constant is missing or wrong");
  requirePattern(results, "protocol", root, "packages/client/src/transport/http-transport.ts", /requestUnknown\(["']\/capabilities["']/, "Client must perform the capabilities handshake");
  requirePattern(results, "protocol", root, "packages/client/src/transport/http-transport.ts", /headers\[PROTOCOL_VERSION_HEADER\]\s*=\s*String\(CURRENT_PROTOCOL_VERSION\)/, "Client business requests must carry the protocol header");
  requirePattern(results, "protocol", root, "packages/server/src/http/protocol-middleware.ts", /path\s*===\s*["']\/health["'][\s\S]*path\s*===\s*["']\/capabilities["']/, "Server must exempt only health and capabilities before exact validation");
  requirePattern(results, "protocol", root, "packages/server/src/http/protocol-middleware.ts", /version\s*!==\s*String\(CURRENT_PROTOCOL_VERSION\)/, "Server must enforce the exact protocol version");
  return results;
}

function checkWorkflow(root) {
  const file = ".github/workflows/tag-release.yml";
  const source = read(root, file);
  if (source === undefined) return [missing("workflow", file)];
  const results = [];
  const order = ["validate:", "preflight:", "build-desktop:", "verify-clean-slate-artifacts:", "create-tag:", "publish-npm:", "publish-release:", "finalize:", "notify:"];
  let cursor = -1;
  for (const marker of order) {
    const index = source.indexOf(`  ${marker}`);
    if (index < 0) results.push(problem("workflow", file, 1, `missing job ${marker.slice(0, -1)}`));
    else if (index <= cursor) results.push(problem("workflow", file, lineOf(source, index), `${marker.slice(0, -1)} is out of release-safety order`));
    else cursor = index;
  }
  const jobBlock = (name) => {
    const start = source.indexOf(`  ${name}:`);
    if (start < 0) return "";
    const next = source.slice(start + 1).search(/^  [a-z][a-z0-9-]*:\s*$/m);
    return next < 0 ? source.slice(start) : source.slice(start, start + 1 + next);
  };
  for (const [job, pattern, message] of [
    ["verify-clean-slate-artifacts", /needs:\s*\[[^\]]*preflight[^\]]*build-desktop[^\]]*\]/, "strict bundle verification must depend on checks and both Desktop builds"],
    ["verify-clean-slate-artifacts", /pnpm check:clean-slate:artifacts/, "strict bundle verification must run before tag creation"],
    ["create-tag", /needs:\s*\[[^\]]*preflight[^\]]*build-desktop[^\]]*verify-clean-slate-artifacts[^\]]*\]/, "tag creation must depend on checks, Desktop builds and strict bundle verification"],
    ["publish-npm", /needs:\s*\[[^\]]*create-tag[^\]]*\]/, "npm publication must depend on tag creation"],
    ["publish-release", /needs:\s*\[[^\]]*create-tag[^\]]*publish-npm[^\]]*build-desktop[^\]]*\]/, "GitHub Release must depend on tag, npm and artifacts"],
    ["finalize", /needs:\s*\[[^\]]*publish-npm[^\]]*publish-release[^\]]*\]/, "final verification must read back npm and release"],
    ["notify", /if:\s*always\(\)/, "failure notification must run even when earlier jobs fail"],
  ]) if (!pattern.test(jobBlock(job))) results.push(problem("workflow", file, 1, message));
  return results;
}

function inventoryDirectory(root, directory, category, requireBuildArtifacts) {
  if (!existsSync(join(root, directory))) {
    const item = problem(category, directory, 1, "built migration directory is missing");
    return requireBuildArtifacts ? { problems: [item], skipped: [] } : { problems: [], skipped: [item] };
  }
  const sql = readdirSync(join(root, directory)).filter((name) => name.endsWith(".sql")).sort();
  const results = [];
  if (sql.length !== 1 || sql[0] !== "0000_current_schema.sql") {
    results.push(problem(category, directory, 1, `bundled migration inventory must contain one baseline; found [${sql.join(", ")}]`));
  }
  const journal = read(root, `${directory}/meta/_journal.json`);
  if (!journal || JSON.parse(journal).entries?.length !== 1) {
    results.push(problem(category, `${directory}/meta/_journal.json`, 1, "bundled journal must contain one entry"));
  }
  return { problems: results, skipped: [] };
}

function checkBundleInventory(root, requireBuildArtifacts) {
  const results = [];
  const skipped = [];
  requirePattern(results, "bundle-inventory", root, "apps/cli/build.ts", /cpSync\([\s\S]*session-runtime\/migrations[\s\S]*dist\/migrations/, "CLI build must copy the current migration baseline");
  requirePattern(results, "bundle-inventory", root, "apps/desktop/electron.vite.config.ts", /copy-session-migrations[\s\S]*session-runtime\/migrations/, "Desktop build must copy the current migration baseline");
  for (const directory of ["apps/cli/dist/migrations", "apps/desktop/out/session-runtime/migrations"]) {
    const inventory = inventoryDirectory(root, directory, "bundle-inventory", requireBuildArtifacts);
    results.push(...inventory.problems);
    skipped.push(...inventory.skipped);
  }
  return { problems: results, skipped };
}

export async function verifyCleanSlate(options = {}) {
  const root = resolve(options.root ?? defaultRoot);
  const bundle = checkBundleInventory(root, options.requireBuildArtifacts === true);
  const groups = await Promise.all([
    checkForbidden(root, options),
    checkContract(root),
    Promise.resolve(checkMigrations(root)),
    Promise.resolve(checkProtocol(root)),
    Promise.resolve(checkWorkflow(root)),
    Promise.resolve(bundle.problems),
  ]);
  const problems = groups.flat().sort((left, right) => left.category.localeCompare(right.category) || left.file.localeCompare(right.file) || left.line - right.line || left.message.localeCompare(right.message));
  Object.defineProperty(problems, "skipped", { value: bundle.skipped, enumerable: false });
  return problems;
}

async function main() {
  try {
    const requireBuildArtifacts = process.argv.includes("--require-build-artifacts");
    const problems = await verifyCleanSlate({ requireBuildArtifacts });
    for (const item of problems.skipped) {
      process.stdout.write(`Clean-slate verifier: SKIPPED [${item.category}] ${item.file}: ${item.message}; rerun with --require-build-artifacts after building\n`);
    }
    if (problems.length === 0) {
      process.stdout.write("Clean-slate verifier: PASS\n");
      return;
    }
    process.stderr.write(`Clean-slate verifier: FAIL (${problems.length} problems)\n`);
    for (const item of problems) {
      process.stderr.write(`[${item.category}] ${item.file}:${item.line} ${item.message}\n`);
    }
    process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`Clean-slate verifier: ERROR ${error?.stack ?? error}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) await main();
