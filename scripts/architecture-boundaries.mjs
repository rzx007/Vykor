import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scanForbiddenSurfaces } from "./forbidden-compatibility-surfaces.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const baselinePath = join(root, "scripts", "architecture-baseline.json");

const forbiddenPackageEdges = new Map([
  [
    "@vykor/protocol",
    new Set(["@vykor/services", "@vykor/server", "@vykor/client"]),
  ],
  ["@vykor/services", new Set(["@vykor/server", "@vykor/client"])],
  ["@vykor/agent-runtime", new Set(["@vykor/server"])],
]);

const storeCallPattern = /\b(?:this\.)?(?:context\.)?store\.([A-Za-z_$][\w$]*)\s*\(/g;
const importPattern = /(?:(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?from\s+)?|import\s*\()\s*['"]([^'"]+)['"]/g;

export function extractImports(source) {
  const matches = [];
  for (const match of source.matchAll(importPattern)) {
    matches.push(match[1]);
  }
  return matches;
}

export function checkImportBoundary(fromFile, specifier) {
  const normalized = fromFile.replaceAll("\\", "/");
  const isDomain = /(?:^|\/)(?:packages\/services\/src\/)?(sessions|conversations|runs)\//.test(normalized);
  if (isDomain) {
    if (specifier === "@vykor/server" || specifier.startsWith("@vykor/server/")) {
      return [`${fromFile} must not depend on @vykor/server`];
    }
    if (/(?:^|\/)session-runtime\/store(?:\.[a-zA-Z]+)?$/.test(specifier)) {
      return [`${fromFile} must not depend on session-runtime/store`];
    }
  }
  const isDatabase = /(?:^|\/)(?:packages\/services\/src\/)?database\//.test(normalized);
  if (isDatabase) {
    const domainMatch = specifier.match(/(?:^|\/|\.\.\/)(sessions|conversations|runs)(?:\/|\.|$)/);
    if (domainMatch) {
      return [`${fromFile} must not depend on ${domainMatch[1]}`];
    }
  }

  const isServerRoute = /(?:^|\/)(?:packages\/server\/src\/)?http\/routes\//.test(normalized);
  if (isServerRoute) {
    if (/(?:^|\/)session-runtime\/store(?:\.[a-zA-Z]+)?$/.test(specifier) || /SessionStore(?:\.[a-zA-Z]+)?$/.test(specifier)) {
      return [`${fromFile} must not depend on SessionStore`];
    }
    if (/(?:^|\/|\.\.\/)(?:sessions\/session-repository|@vykor\/services\/sessions)(?:\/|\.|$)/.test(specifier) || specifier === "@vykor/services/sessions") {
      return [`${fromFile} must not depend on session repository`];
    }
    if (/(?:^|\/|\.\.\/)(?:conversations\/conversation-repository|@vykor\/services\/conversations)(?:\/|\.|$)/.test(specifier) || specifier === "@vykor/services/conversations") {
      return [`${fromFile} must not depend on conversation repository`];
    }
    if (/(?:^|\/|\.\.\/)(?:runs\/run-repository|@vykor\/services\/runs)(?:\/|\.|$)/.test(specifier) || specifier === "@vykor/services/runs") {
      return [`${fromFile} must not depend on run repository`];
    }
  }

  const isSessionCommand = /(?:^|\/)session-command-service(?:\.[a-zA-Z]+)?$/.test(normalized);
  if (isSessionCommand) {
    if (/(?:^|\/)http(?:\/|\.|$)/.test(specifier)) {
      return [`${fromFile} must not depend on http`];
    }
    if (/(?:^|\/)daemon(?:\/|\.|$)/.test(specifier) || /(?:^|\/)daemon-application(?:\.[a-zA-Z]+)?$/.test(specifier)) {
      return [`${fromFile} must not depend on Daemon`];
    }
  }

  const isServerApplication = /(?:^|\/)(?:packages\/server\/src\/)?application\//.test(normalized);
  const isCompositionRoot = /(?:daemon-application|default-node-application|index)\.ts$/.test(normalized);
  if (isServerApplication && !isCompositionRoot) {
    if (/(?:^|\/)daemon-application(?:\.[a-zA-Z]+)?$/.test(specifier)) {
      return [`${fromFile} must not depend on DaemonApplication`];
    }
  }

  const isSessionQuery = /(?:^|\/)session-query-service(?:\.[a-zA-Z]+)?$/.test(normalized);
  if (isSessionQuery) {
    if (/(?:^|\/)(?:runtime|session-runtime)(?:\/|\.|$)/.test(specifier)) {
      return [`${fromFile} must not depend on runtime`];
    }
  }

  const isRunAdmission = /(?:^|\/)run-admission-service(?:\.[a-zA-Z]+)?$/.test(normalized);
  if (isRunAdmission && (/(?:^|\/)http(?:\/|\.|$)/.test(specifier) || /(?:^|\/)daemon(?:\/|\.|$)/.test(specifier) || /(?:^|\/)daemon-application(?:\.[a-zA-Z]+)?$/.test(specifier))) {
    return [`${fromFile} must not depend on http or Daemon`];
  }

  const isRunControl = /(?:^|\/)run-control-service(?:\.[a-zA-Z]+)?$/.test(normalized);
  if (isRunControl && /(?:^|\/)session-run-executor(?:\.[a-zA-Z]+)?$/.test(specifier)) {
    return [`${fromFile} must not depend on SessionRunExecutor`];
  }

  const isServerRuntime = /(?:^|\/)(?:packages\/server\/src\/)?(?:runtime|session-runtime)\//.test(normalized) ||
    /(?:^|\/)(?:packages\/services\/src\/)?session-runtime\//.test(normalized);
  if (isServerRuntime) {
    if (/(?:^|\/)http\/routes(?:\/|\.|$)/.test(specifier)) {
      return [`${fromFile} must not depend on http/routes`];
    }
  }

  const isClientResource = /(?:^|\/)(?:packages\/client\/src\/)?resources\//.test(normalized);
  if (isClientResource) {
    if (/(?:^|\/)http-client(?:\.[a-zA-Z]+)?$/.test(specifier) || specifier === "@vykor/server" || specifier.startsWith("@vykor/server/")) {
      return [`${fromFile} must not depend on VykorClient or Server`];
    }
  }

  const isClientTransport = /(?:^|\/)(?:packages\/client\/src\/)?transport\/(?:http-transport|sse-transport)(?:\.[a-zA-Z]+)?$/.test(normalized);
  if (isClientTransport) {
    if (/(?:^|\/)resources(?:\/|\.|$)/.test(specifier)) {
      return [`${fromFile} must not depend on Resource`];
    }
  }

  const isFrontend = /(?:^|\/)apps\/frontend\//.test(normalized);
  if (isFrontend) {
    if (specifier === "electron" || specifier.startsWith("electron/")) {
      return [`${fromFile} must not depend on Electron`];
    }
    if (specifier === "@vykor/desktop" || /(?:^|\/|\.\.\/)desktop(?:\/|\.|$)/.test(specifier)) {
      return [`${fromFile} must not depend on Desktop`];
    }
  }

  const isDesktopRenderer = /(?:^|\/)apps\/desktop\/src\/renderer\//.test(normalized);
  if (isDesktopRenderer) {
    if (/(?:^|\/)apps\/desktop\/src\/main\//.test(specifier) || /(?:^|\/|\.\.\/)main(?:\/|\.|$)/.test(specifier)) {
      return [`${fromFile} must not depend on Desktop main`];
    }
  }

  const isDesktopMain = /(?:^|\/)apps\/desktop\/src\/main\//.test(normalized);
  if (isDesktopMain) {
    if (/(?:^|\/)apps\/desktop\/src\/renderer\//.test(specifier) || /(?:^|\/|\.\.\/)renderer(?:\/|\.|$)/.test(specifier)) {
      return [`${fromFile} must not depend on Desktop renderer`];
    }
  }

  return [];
}


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

export function checkSessionRunEngineComposition(source, file) {
  const start = source.indexOf("new SessionRunEngine(");
  if (start < 0) return [];
  const end = source.indexOf("\n  });", start);
  const construction = source.slice(start, end < 0 ? source.length : end + 6);
  return /(?:\{|,)\s*(?:admission|control)\s*:/.test(construction)
    ? [`${file} must not inject admission or control facades into SessionRunEngine`]
    : [];
}

export function checkMaintenanceCapability(source, file) {
  return /\b(?:store|data)\s*:\s*SessionStore\s*[;,]/.test(source)
    ? [`${file} must use a narrow maintenance capability instead of SessionStore`]
    : [];
}

export function checkAttachmentLayout(path, source) {
  const errors = [];
  const normalized = path.replaceAll("\\", "/");
  if (/packages\/services\/src\/(?:attachment|attachment-processing)(?:\/|$)/.test(normalized)) {
    errors.push(`${normalized} uses a retired Services attachment root`);
  }
  if (/packages\/server\/src\/application\/attachment-(?:processing|resource|routing|tools)(?:\/|$)/.test(normalized)) {
    errors.push(`${normalized} uses a retired Server attachment root`);
  }
  if (/\bAttachmentApplicationService\b/.test(source)) {
    errors.push("AttachmentApplicationService is retired; use Server AttachmentService");
  }
  return errors;
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

function workspaceSourceFiles(scanRoot) {
  return ["packages", "apps"].flatMap((parent) => {
    const parentPath = join(scanRoot, parent);
    if (!existsSync(parentPath)) return [];
    return readdirSync(parentPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => sourceFiles(join(parentPath, entry.name, "src")));
  });
}

export function collectAttachmentLayoutErrors(scanRoot = root) {
  return workspaceSourceFiles(scanRoot).flatMap((path) =>
    checkAttachmentLayout(relative(scanRoot, path), readFileSync(path, "utf8")),
  );
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
  errors.push(...collectAttachmentLayoutErrors());

  const boundaryFiles = [
    ...sourceFiles(join(root, "packages", "services", "src", "sessions")),
    ...sourceFiles(join(root, "packages", "services", "src", "conversations")),
    ...sourceFiles(join(root, "packages", "services", "src", "runs")),
    ...sourceFiles(join(root, "packages", "services", "src", "database")),
    ...sourceFiles(join(root, "packages", "services", "src", "attachments")),
    ...sourceFiles(join(root, "packages", "services", "src", "attachment")),
    ...sourceFiles(join(root, "packages", "services", "src", "attachment-processing")),
    ...sourceFiles(join(root, "packages", "server", "src", "http", "routes")),
    ...sourceFiles(join(root, "packages", "server", "src", "application")),
    ...sourceFiles(join(root, "packages", "server", "src", "runtime")),
    ...sourceFiles(join(root, "packages", "client", "src", "resources")),
    ...sourceFiles(join(root, "packages", "client", "src", "transport")),
    ...sourceFiles(join(root, "apps", "frontend", "src")),
    ...sourceFiles(join(root, "apps", "desktop", "src")),
  ];

  for (const path of boundaryFiles) {
    const rel = relative(root, path);
    const content = readFileSync(path, "utf8");
    for (const specifier of extractImports(content)) {
      for (const error of checkImportBoundary(rel, specifier)) {
        errors.push(error);
      }
    }
    if (!/\.(?:test|spec)\.(?:ts|tsx)$/.test(path)) {
      errors.push(...checkSessionRunEngineComposition(content, rel));
      if (/session-(?:post-run-)?maintenance-service\.ts$/.test(rel.replaceAll("\\", "/"))) {
        errors.push(...checkMaintenanceCapability(content, rel));
      }
    }
  }

  return errors;
}

function collectLegacyCalls() {
  const storeFiles = [
    ...sourceFiles(join(root, "packages", "server", "src")),
    ...sourceFiles(join(root, "packages", "services", "src", "attachments")),
    ...sourceFiles(join(root, "packages", "tools", "src", "agent", "workflow")),
  ];
  const storeCalls = storeFiles.flatMap((path) =>
    countLegacyCalls(readFileSync(path, "utf8"), relative(root, path)),
  );
  return { storeCalls };
}

export function summary(calls) {
  return {
    sessionStoreFlatCalls: calls.storeCalls.length,
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
    ...scanForbiddenSurfaces({ cwd: root }).map(
      (error) => `${error.file}:${error.line}:${error.column} forbidden ${error.surface}`,
    ),
  ];
  if (errors.length > 0) {
    process.stderr.write(`${errors.join("\n")}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`Architecture boundaries pass: ${JSON.stringify(current)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
