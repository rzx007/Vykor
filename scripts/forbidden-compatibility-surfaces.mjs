import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const defaultManifestPath = join(scriptDir, "forbidden-compatibility-surfaces.json");
const categories = [
  "clientMethods",
  "runtimeExports",
  "httpRoutes",
  "cliCommands",
  "cliOptions",
  "environmentVariables",
  "configFields",
  "enumValues",
  "schemaNames",
];
const categoryLabels = {
  clientMethods: "client-method",
  runtimeExports: "runtime-export",
  httpRoutes: "http-route",
  cliCommands: "cli-command",
  cliOptions: "cli-option",
  environmentVariables: "environment-variable",
  configFields: "config-field",
  enumValues: "enum-value",
  schemaNames: "schema-name",
};
const defaultRoots = ["packages", "apps", "scripts", "tests", "docs", ".github", "package.json"];
const defaultAllow = [
  "scripts/forbidden-compatibility-surfaces.json",
  "scripts/forbidden-compatibility-surfaces.test.mjs",
  "tests/client-public-api/consumer.ts",
  "docs/compatibility-surface-audit.md",
  "docs/superpowers/plans/",
  "docs/superpowers/specs/",
];
const scannedExtension = /\.(?:c?js|mjs|json|md|ts|tsx|ya?ml)$/i;
const codeExtension = /\.(?:c?js|mjs|ts|tsx)$/i;

function normalizePath(path) {
  return path.replaceAll("\\", "/");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function validateManifest(data, path) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`${path} must contain an object`);
  }
  if (data.version !== 1) throw new Error(`${path} version must be 1`);
  for (const category of categories) {
    const values = data[category];
    if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || value.length === 0)) {
      throw new Error(`${path} ${category} must be an array of non-empty strings`);
    }
    if (new Set(values).size !== values.length) {
      throw new Error(`${path} ${category} contains duplicates`);
    }
  }
  const allowedKeys = new Set(["$schema", "version", ...categories]);
  const extra = Object.keys(data).filter((key) => !allowedKeys.has(key));
  if (extra.length > 0) throw new Error(`${path} contains unknown keys: ${extra.join(", ")}`);
  return data;
}

export function readForbiddenSurfaces(path = defaultManifestPath) {
  const fullPath = resolve(path);
  return validateManifest(JSON.parse(readFileSync(fullPath, "utf8")), fullPath);
}

function collectFiles(path) {
  if (!existsSync(path)) return [];
  const entries = readdirSync(path, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      return ["node_modules", "dist", ".git", ".turbo"].includes(entry.name)
        ? []
        : collectFiles(child);
    }
    return scannedExtension.test(entry.name) ? [child] : [];
  });
}

function isAllowed(rel, allow) {
  return allow.some((item) => item.endsWith("/") ? rel.startsWith(item) : rel === item);
}

function matchPatterns(category, name, rel) {
  const escaped = escapeRegExp(name);
  if (category === "clientMethods" || category === "runtimeExports") {
    const patterns = [
      new RegExp(`\\bclient\\s*(?:\\?\\.|\\.)\\s*${escaped}\\b`, "g"),
      new RegExp(`\\bclient\\s*(?:\\?\\.\\s*)?\\[\\s*["']${escaped}["']\\s*\\]`, "g"),
    ];
    if (rel === "packages/client/src/transport/http-client.ts") {
      patterns.push(new RegExp(`(?:^|\\n)\\s*(?:readonly\\s+|get\\s+|async\\s+)?${escaped}\\s*(?::|\\()`, "g"));
    }
    if (rel === "scripts/client-public-api-contract.json") {
      patterns.push(new RegExp(`"name"\\s*:\\s*"${escaped}"`, "g"));
    }
    return patterns;
  }
  if (category === "httpRoutes") {
    return [new RegExp(`["']${escaped}["']`, "g")];
  }
  if (category === "cliCommands") {
    return [new RegExp(`\\.command\\(\\s*["']${escaped}["']`, "g")];
  }
  if (category === "cliOptions") {
    return [new RegExp(`(?:^|[\\s,'"])${escaped}(?=$|[\\s,>'"])`, "g")];
  }
  if (category === "configFields") {
    return [new RegExp(`(?:["']${escaped}["']|\\b${escaped}\\b)\\s*[:=]`, "g")];
  }
  return [new RegExp(`\\b${escaped}\\b`, "g")];
}

function unwrapExpression(node) {
  let current = node;
  while (
    current &&
    (ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isSatisfiesExpression(current))
  ) {
    current = current.expression;
  }
  return current;
}

function hasClientType(node, sourceFile) {
  return Boolean(node?.type && /(?:^|\W)OpenHarnessClient(?:$|\W)/.test(node.type.getText(sourceFile)));
}

function propertyName(node) {
  if (!node) return null;
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text;
  return null;
}

function scanClientAst(source, rel, surfaces) {
  const kind = rel.endsWith(".tsx") ? ts.ScriptKind.TSX : rel.endsWith(".jsx") ? ts.ScriptKind.JSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true, kind);
  const forbidden = new Map([
    ...surfaces.clientMethods.map((name) => [name, "client-method"]),
    ...surfaces.runtimeExports.map((name) => [name, "runtime-export"]),
  ]);
  const clientIdentifiers = new Set(["client"]);

  function isClientExpression(node) {
    const expression = unwrapExpression(node);
    if (!expression) return false;
    if (ts.isIdentifier(expression)) return clientIdentifiers.has(expression.text);
    if (ts.isNewExpression(expression)) {
      return /(?:^|\.)OpenHarnessClient$/.test(expression.expression.getText(sourceFile));
    }
    return ts.isPropertyAccessExpression(expression) && expression.name.text === "client";
  }

  let changed = true;
  while (changed) {
    changed = false;
    function collectAliases(node) {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        if (hasClientType(node, sourceFile) || isClientExpression(node.initializer)) {
          if (!clientIdentifiers.has(node.name.text)) {
            clientIdentifiers.add(node.name.text);
            changed = true;
          }
        }
      } else if (ts.isParameter(node) && ts.isIdentifier(node.name) && hasClientType(node, sourceFile)) {
        if (!clientIdentifiers.has(node.name.text)) {
          clientIdentifiers.add(node.name.text);
          changed = true;
        }
      } else if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left) &&
        isClientExpression(node.right) &&
        !clientIdentifiers.has(node.left.text)
      ) {
        clientIdentifiers.add(node.left.text);
        changed = true;
      }
      ts.forEachChild(node, collectAliases);
    }
    collectAliases(sourceFile);
  }

  const errors = [];
  const seen = new Set();
  function report(node, name) {
    const label = forbidden.get(name);
    if (!label) return;
    const start = node.getStart(sourceFile);
    const position = sourceFile.getLineAndCharacterOfPosition(start);
    const key = `${start}:${label}/${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    errors.push({
      surface: `${label}/${name}`,
      file: rel,
      line: position.line + 1,
      column: position.character + 1,
    });
  }

  function visit(node) {
    if (ts.isPropertyAccessExpression(node) && isClientExpression(node.expression)) {
      report(node.name, node.name.text);
    } else if (ts.isElementAccessExpression(node) && isClientExpression(node.expression)) {
      report(node.argumentExpression, propertyName(node.argumentExpression));
    } else if (
      ts.isBindingElement(node) &&
      ts.isObjectBindingPattern(node.parent) &&
      ((ts.isVariableDeclaration(node.parent.parent) && isClientExpression(node.parent.parent.initializer)) ||
        (ts.isParameter(node.parent.parent) && hasClientType(node.parent.parent, sourceFile)))
    ) {
      report(node.propertyName ?? node.name, propertyName(node.propertyName ?? node.name));
    } else if (
      (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) &&
      node.name?.text === "OpenHarnessClient"
    ) {
      for (const member of node.members) report(member.name ?? member, propertyName(member.name));
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return errors;
}

function locate(source, index) {
  const before = source.slice(0, index);
  const lines = before.split("\n");
  return { line: lines.length, column: lines.at(-1).length + 1 };
}

export function scanForbiddenSurfaces(options = {}) {
  const cwd = resolve(options.cwd ?? repoRoot);
  const surfaces = validateManifest(options.surfaces ?? readForbiddenSurfaces(options.manifestPath), "forbidden surfaces");
  const allow = [...defaultAllow, ...(options.allow ?? [])].map(normalizePath);
  const roots = options.roots ?? defaultRoots;
  const files = roots.flatMap((root) => {
    const path = resolve(cwd, root);
    if (!existsSync(path)) return [];
    return scannedExtension.test(path) ? [path] : collectFiles(path);
  });
  const errors = [];
  for (const file of files) {
    const rel = normalizePath(relative(cwd, file));
    if (isAllowed(rel, allow)) continue;
    const source = readFileSync(file, "utf8");
    if (codeExtension.test(rel)) errors.push(...scanClientAst(source, rel, surfaces));
    for (const category of categories) {
      if (codeExtension.test(rel) && (category === "clientMethods" || category === "runtimeExports")) continue;
      for (const name of surfaces[category]) {
        for (const pattern of matchPatterns(category, name, rel)) {
          for (const match of source.matchAll(pattern)) {
            const location = locate(source, match.index);
            errors.push({
              surface: `${categoryLabels[category]}/${name}`,
              file: rel,
              ...location,
            });
          }
        }
      }
    }
  }
  return errors.sort((left, right) =>
    left.file.localeCompare(right.file) || left.line - right.line || left.column - right.column || left.surface.localeCompare(right.surface)
  );
}

function main() {
  try {
    const errors = scanForbiddenSurfaces();
    if (errors.length === 0) {
      process.stdout.write("Forbidden compatibility surfaces: PASS\n");
      return;
    }
    for (const error of errors) {
      process.stderr.write(`${error.file}:${error.line}:${error.column} ${error.surface}\n`);
    }
    process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`Forbidden compatibility surface scan failed: ${error.message}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
