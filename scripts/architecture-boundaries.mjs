import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const baselinePath = join(root, "scripts", "architecture-baseline.json");

const forbiddenPackageEdges = new Map([
  [
    "@openharness/protocol",
    new Set(["@openharness/services", "@openharness/server", "@openharness/client"]),
  ],
  ["@openharness/services", new Set(["@openharness/server", "@openharness/client"])],
  ["@openharness/agent-runtime", new Set(["@openharness/server"])],
]);

const storeCallPattern = /\b(?:this\.)?(?:context\.)?store\.([A-Za-z_$][\w$]*)\s*\(/g;
const clientCallPattern = /\bclient\.(createSession|admitPrompt|interruptRun|listProjects)\s*\(/g;

export function checkPackageDependency(from, to) {
  return forbiddenPackageEdges.get(from)?.has(to)
    ? [`${from} must not depend on ${to}`]
    : [];
}

export function validateLegacyBaseline(baseline, current) {
  return Object.entries(baseline).flatMap(([name, previous]) => {
    const next = current[name] ?? 0;
    return next > previous
      ? [`${name} increased from ${previous} to ${next}`]
      : [];
  });
}

export function countLegacyCalls(source, file) {
  const matches = [];
  for (const match of source.matchAll(storeCallPattern)) {
    const line = source.slice(0, match.index).split("\n").length;
    matches.push({ file, line, name: match[1] });
  }
  return matches;
}

function workspacePackagePaths() {
  return ["packages", "apps"].flatMap((parent) =>
    readdirSync(join(root, parent), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, parent, entry.name, "package.json"))
      .filter(existsSync),
  );
}

function packageDependencies(packageJson) {
  return [
    packageJson.dependencies,
    packageJson.devDependencies,
    packageJson.peerDependencies,
    packageJson.optionalDependencies,
  ].flatMap((section) => Object.keys(section ?? {}));
}

function sourceFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory())
      return entry.name === "__test__" ? [] : sourceFiles(path);
    return /\.(?:ts|tsx)$/.test(entry.name) && !/\.(?:test|spec)\.(?:ts|tsx)$/.test(entry.name)
      ? [path]
      : [];
  });
}

function collectArchitectureErrors() {
  const errors = [];
  for (const path of workspacePackagePaths()) {
    const packageJson = JSON.parse(readFileSync(path, "utf8"));
    for (const dependency of packageDependencies(packageJson)) {
      for (const error of checkPackageDependency(packageJson.name, dependency)) {
        errors.push(`${relative(root, path)}: ${error}`);
      }
    }
  }
  return errors;
}

function collectLegacyCalls() {
  const storeFiles = [
    ...sourceFiles(join(root, "packages", "server", "src")),
    ...sourceFiles(join(root, "packages", "services", "src", "attachment")),
    ...sourceFiles(join(root, "packages", "tools", "src", "agent", "workflow")),
  ];
  const clientFiles = [
    ...sourceFiles(join(root, "apps", "cli", "src")),
    ...sourceFiles(join(root, "apps", "desktop", "src")),
    ...sourceFiles(join(root, "apps", "frontend", "src")),
  ];
  const storeCalls = storeFiles.flatMap((path) =>
    countLegacyCalls(readFileSync(path, "utf8"), relative(root, path)),
  );
  const clientCalls = clientFiles.flatMap((path) =>
    [...readFileSync(path, "utf8").matchAll(clientCallPattern)].map((match) => ({
      file: relative(root, path),
      line: readFileSync(path, "utf8").slice(0, match.index).split("\n").length,
      name: match[1],
    })),
  );
  return { storeCalls, clientCalls };
}

function summary(calls) {
  return {
    sessionStoreFlatCalls: calls.storeCalls.length,
    httpClientFlatCalls: calls.clientCalls.length,
  };
}

function run() {
  const calls = collectLegacyCalls();
  const current = summary(calls);
  if (process.argv.includes("--write-baseline")) {
    writeFileSync(baselinePath, `${JSON.stringify(current, null, 2)}\n`);
    process.stdout.write(`Wrote architecture baseline to ${relative(root, baselinePath)}\n`);
    return;
  }

  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  const errors = [
    ...collectArchitectureErrors(),
    ...validateLegacyBaseline(baseline, current),
  ];
  if (errors.length > 0) {
    process.stderr.write(`${errors.join("\n")}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`Architecture boundaries pass: ${JSON.stringify(current)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
