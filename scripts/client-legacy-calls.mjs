import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

function loadContract(contractPath) {
  const fullPath = contractPath ? resolve(contractPath) : join(root, "scripts", "client-public-api-contract.json");
  const data = JSON.parse(readFileSync(fullPath, "utf8"));
  const entries = Array.isArray(data) ? data : data.entries;
  const compatMap = new Map();
  for (const entry of entries) {
    if (entry.kind === "client-method" && entry.classification === "compatibility") {
      compatMap.set(entry.name, entry.replacement || `sessions.${entry.name}`);
    }
  }
  return compatMap;
}

function getAllSourceFiles(dir) {
  if (!existsSync(dir)) return [];
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && entry.name !== "dist" && entry.name !== ".git") {
        results.push(...getAllSourceFiles(full));
      }
    } else if (/\.(?:ts|tsx)$/.test(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

function tracesToOpenHarnessClient(type, checker, depth = 0, seen = new Set()) {
  if (!type || depth > 8) return false;
  if (seen.has(type)) return false;
  seen.add(type);

  const name = type.getSymbol()?.getName() || type.symbol?.name;
  if (name === "OpenHarnessClient") return true;

  const aliasName = type.aliasSymbol?.name;
  if (aliasName === "OpenHarnessClient") return true;

  if (type.aliasTypeArguments?.some((t) => tracesToOpenHarnessClient(t, checker, depth + 1, seen))) {
    return true;
  }

  if (type.types?.some((t) => tracesToOpenHarnessClient(t, checker, depth + 1, seen))) {
    return true;
  }

  if (type.typeArguments?.some((t) => tracesToOpenHarnessClient(t, checker, depth + 1, seen))) {
    return true;
  }

  if (type.aliasSymbol) {
    for (const decl of type.aliasSymbol.declarations || []) {
      if (ts.isTypeAliasDeclaration(decl)) {
        if (ts.isTypeReferenceNode(decl.type)) {
          for (const arg of decl.type.typeArguments || []) {
            const argType = checker.getTypeFromTypeNode(arg);
            if (tracesToOpenHarnessClient(argType, checker, depth + 1, seen)) return true;
          }
        }
      }
    }
  }

  if (typeof checker.getBaseTypes === "function" && type.isClassOrInterface && type.isClassOrInterface()) {
    const baseTypes = checker.getBaseTypes(type) || [];
    if (baseTypes.some((t) => tracesToOpenHarnessClient(t, checker, depth + 1, seen))) return true;
  }

  return false;
}

function getReceiverKind(expr, checker) {
  if (!expr) return "direct";
  if (expr.kind === ts.SyntaxKind.ThisKeyword) return "member";
  if (ts.isPropertyAccessExpression(expr)) {
    return "member";
  }
  if (
    ts.isAwaitExpression(expr) ||
    (ts.isParenthesizedExpression(expr) && ts.isAwaitExpression(expr.expression))
  ) {
    return "await-factory";
  }
  if (ts.isIdentifier(expr) && checker) {
    const sym = checker.getSymbolAtLocation(expr);
    const decl = sym?.declarations?.[0];
    if (
      decl &&
      ts.isVariableDeclaration(decl) &&
      decl.initializer &&
      (ts.isIdentifier(decl.initializer) || ts.isPropertyAccessExpression(decl.initializer))
    ) {
      return "alias";
    }
  }
  return "direct";
}

function classifyScope(normalizedFile) {
  if (normalizedFile.endsWith("packages/client/src/transport/__test__/http-client.test.ts")) {
    return "compatibility-test";
  }
  const isTest =
    normalizedFile.includes(".test.") ||
    normalizedFile.includes(".spec.") ||
    normalizedFile.includes("/__test__/") ||
    normalizedFile.includes("/tests/");
  return isTest ? "other-test" : "production";
}

export function scanClientLegacyCalls(options = {}) {
  const cwd = options.cwd ? resolve(options.cwd) : root;
  const compatMethods = options.compatMethods || loadContract(options.contractPath);
  const pathFilter = options.pathFilter || options.path;
  const targetScope = options.scope;

  const references = [];
  const unresolvedClientMembers = [];
  const dynamicMembers = [];

  let programs = options.programs;
  if (!programs) {
    const tsconfigConfigs = [
      { config: "packages/client/tsconfig.json", dir: "packages/client/src" },
      { config: "apps/cli/tsconfig.json", dir: "apps/cli/src" },
      { config: "apps/desktop/tsconfig.node.json", dir: "apps/desktop/src" },
      { config: "apps/frontend/tsconfig.json", dir: "apps/frontend/src" },
    ];

    programs = [];
    for (const { config, dir } of tsconfigConfigs) {
      const fullConfig = join(cwd, config);
      if (!existsSync(fullConfig)) continue;
      const configFile = ts.readConfigFile(fullConfig, ts.sys.readFile);
      const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, dirname(fullConfig));
      const allDirFiles = getAllSourceFiles(join(cwd, dir));
      const fileSet = new Set([...parsed.fileNames, ...allDirFiles]);
      const program = ts.createProgram([...fileSet], parsed.options);
      programs.push({ program, scanFiles: allDirFiles });
    }
  }

  for (const item of programs) {
    const program = item.program || item;
    const checker = program.getTypeChecker();
    const files = item.scanFiles || program.getSourceFiles().map((sf) => sf.fileName);

    for (const filePath of files) {
      const normalized = filePath.replaceAll("\\", "/");
      const rel = relative(cwd, filePath).replaceAll("\\", "/");

      if (rel === "packages/client/src/transport/http-client.ts") {
        continue;
      }
      if (pathFilter && !rel.includes(pathFilter.replaceAll("\\", "/"))) {
        continue;
      }

      const scope = classifyScope(rel);
      if (targetScope && targetScope !== "all" && scope !== targetScope) {
        continue;
      }

      const sf = program.getSourceFile(filePath);
      if (!sf) continue;

      function visit(node) {
        if (ts.isPropertyAccessExpression(node)) {
          const propName = node.name.text;
          const receiverType = checker.getTypeAtLocation(node.expression);
          if (tracesToOpenHarnessClient(receiverType, checker)) {
            if (compatMethods.has(propName)) {
              const isCall =
                ts.isCallExpression(node.parent) && node.parent.expression === node;
              const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart());
              references.push({
                file: rel,
                line: line + 1,
                column: character + 1,
                method: propName,
                replacement: compatMethods.get(propName) || "",
                scope,
                receiver: getReceiverKind(node.expression, checker),
                usage: isCall ? "call" : "value-reference",
              });
            } else {
              const propSymbol = checker.getPropertyOfType(receiverType, propName);
              if (!propSymbol) {
                const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart());
                unresolvedClientMembers.push({
                  file: rel,
                  line: line + 1,
                  column: character + 1,
                  member: propName,
                  scope,
                });
              }
            }
          }
        } else if (ts.isElementAccessExpression(node)) {
          const receiverType = checker.getTypeAtLocation(node.expression);
          if (tracesToOpenHarnessClient(receiverType, checker)) {
            const arg = node.argumentExpression;
            if (arg && ts.isStringLiteral(arg)) {
              const propName = arg.text;
              if (compatMethods.has(propName)) {
                const isCall =
                  ts.isCallExpression(node.parent) && node.parent.expression === node;
                const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart());
                references.push({
                  file: rel,
                  line: line + 1,
                  column: character + 1,
                  method: propName,
                  replacement: compatMethods.get(propName) || "",
                  scope,
                  receiver: getReceiverKind(node.expression, checker),
                  usage: isCall ? "call" : "value-reference",
                });
              }
            } else if (arg) {
              const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart());
              dynamicMembers.push({
                file: rel,
                line: line + 1,
                column: character + 1,
                expression: arg.getText(sf),
                scope,
              });
            }
          }
        } else if (ts.isIndexedAccessTypeNode(node)) {
          const objectType = checker.getTypeFromTypeNode(node.objectType);
          if (tracesToOpenHarnessClient(objectType, checker)) {
            if (ts.isLiteralTypeNode(node.indexType) && ts.isStringLiteral(node.indexType.literal)) {
              const propName = node.indexType.literal.text;
              if (compatMethods.has(propName)) {
                const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart());
                references.push({
                  file: rel,
                  line: line + 1,
                  column: character + 1,
                  method: propName,
                  replacement: compatMethods.get(propName) || "",
                  scope,
                  receiver: "direct",
                  usage: "type-index",
                });
              }
            } else {
              const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart());
              dynamicMembers.push({
                file: rel,
                line: line + 1,
                column: character + 1,
                expression: node.indexType.getText(sf),
                scope,
              });
            }
          }
        } else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
          const propName = node.propertyName
            ? node.propertyName.text
            : ts.isIdentifier(node.name)
              ? node.name.text
              : null;
          if (propName && compatMethods.has(propName)) {
            let initExpr = null;
            if (ts.isVariableDeclaration(node.parent.parent)) {
              initExpr = node.parent.parent.initializer;
            }
            if (initExpr) {
              const initType = checker.getTypeAtLocation(initExpr);
              if (tracesToOpenHarnessClient(initType, checker)) {
                const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart());
                references.push({
                  file: rel,
                  line: line + 1,
                  column: character + 1,
                  method: propName,
                  replacement: compatMethods.get(propName) || "",
                  scope,
                  receiver: "destructured",
                  usage: "destructure",
                });
              }
            }
          }
        }
        ts.forEachChild(node, visit);
      }
      visit(sf);
    }
  }

  // Deduplicate
  const uniqueReferences = [];
  const seenRef = new Set();
  for (const ref of references) {
    const key = `${ref.file}:${ref.line}:${ref.column}:${ref.method}:${ref.usage}`;
    if (!seenRef.has(key)) {
      seenRef.add(key);
      uniqueReferences.push(ref);
    }
  }

  const prodCalls = uniqueReferences.filter(
    (r) => r.scope === "production" && r.usage === "call",
  );
  const prodRefs = uniqueReferences.filter(
    (r) => r.scope === "production" && r.usage !== "call",
  );
  const compatCalls = uniqueReferences.filter(
    (r) => r.scope === "compatibility-test",
  );
  const otherCalls = uniqueReferences.filter(
    (r) => r.scope === "other-test",
  );

  return {
    references: uniqueReferences,
    summary: {
      clientLegacyProductionCalls: prodCalls.length,
      clientLegacyProductionReferences: prodRefs.length,
      clientLegacyCompatibilityTestCalls: compatCalls.length,
      clientLegacyOtherTestCalls: otherCalls.length,
    },
    unresolvedClientMembers,
    dynamicMembers,
  };
}

function runCli() {
  const args = process.argv.slice(2);
  const isJson = args.includes("--json");
  const scopeIdx = args.indexOf("--scope");
  const scope = scopeIdx >= 0 ? args[scopeIdx + 1] : undefined;
  const pathIdx = args.indexOf("--path");
  const pathFilter = pathIdx >= 0 ? args[pathIdx + 1] : undefined;

  const result = scanClientLegacyCalls({ scope, pathFilter });

  if (isJson) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }

  process.stdout.write("OpenHarnessClient Legacy API Scan Summary:\n");
  process.stdout.write(JSON.stringify(result.summary, null, 2) + "\n\n");

  if (result.unresolvedClientMembers.length > 0) {
    process.stderr.write(`Unresolved client members found (${result.unresolvedClientMembers.length}):\n`);
    for (const item of result.unresolvedClientMembers) {
      process.stderr.write(`  ${item.file}:${item.line}:${item.column} [${item.scope}] member: ${item.member}\n`);
    }
    process.exitCode = 1;
    return;
  }

  if (result.dynamicMembers.length > 0) {
    process.stderr.write(`Dynamic member accesses found (${result.dynamicMembers.length}):\n`);
    for (const item of result.dynamicMembers) {
      process.stderr.write(`  ${item.file}:${item.line}:${item.column} [${item.scope}] expr: ${item.expression}\n`);
    }
    process.exitCode = 1;
    return;
  }

  if (result.references.length > 0) {
    process.stdout.write("Legacy References:\n");
    for (const ref of result.references) {
      process.stdout.write(`  ${ref.file}:${ref.line}:${ref.column} [${ref.scope}] ${ref.method} -> ${ref.replacement} (${ref.usage}, ${ref.receiver})\n`);
    }
  }

  if (scope === "production" && (result.summary.clientLegacyProductionCalls > 0 || result.summary.clientLegacyProductionReferences > 0)) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli();
}
