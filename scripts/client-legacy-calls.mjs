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

export function discoverWorkspaceScanConfigs(cwd = root) {
  const configs = [];
  for (const group of ["apps", "packages"]) {
    const groupDir = join(cwd, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const workspace = `${group}/${entry.name}`;
      const workspaceDir = join(cwd, workspace);
      const sourceFiles = getAllSourceFiles(join(workspaceDir, "src"));
      const usesClient = workspace === "packages/client" || sourceFiles.some((file) =>
        readFileSync(file, "utf8").includes("@openharness/client"),
      );
      if (!usesClient) continue;
      if (existsSync(join(workspaceDir, "tsconfig.json"))) {
        configs.push({ config: `${workspace}/tsconfig.json`, dir: `${workspace}/src` });
        continue;
      }
      for (const child of readdirSync(workspaceDir, { withFileTypes: true })) {
        if (child.isFile() && /^tsconfig\.[^.]+\.json$/.test(child.name)) {
          configs.push({ config: `${workspace}/${child.name}`, dir: `${workspace}/src` });
        }
      }
    }
  }
  return configs.sort((a, b) => a.config.localeCompare(b.config));
}

function literalKeysFromTypeNode(node, checker, seen = new Set()) {
  if (!node || seen.has(node)) return [];
  seen.add(node);
  if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)) return [node.literal.text];
  if (ts.isUnionTypeNode(node)) {
    return node.types.flatMap((item) => literalKeysFromTypeNode(item, checker, seen));
  }
  if (ts.isTypeReferenceNode(node)) {
    const symbol = checker.getSymbolAtLocation(node.typeName);
    for (const declaration of symbol?.declarations || []) {
      if (ts.isTypeParameterDeclaration(declaration) && declaration.constraint) {
        return literalKeysFromTypeNode(declaration.constraint, checker, seen);
      }
    }
  }
  const type = checker.getTypeFromTypeNode(node);
  if (type.isStringLiteral?.()) return [type.value];
  if (type.isUnion?.()) {
    return type.types.filter((item) => item.isStringLiteral?.()).map((item) => item.value);
  }
  return [];
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
        let indexedAccessTraces = false;
        function inspectTypeNode(node) {
          if (indexedAccessTraces) return;
          if (ts.isIndexedAccessTypeNode(node)) {
            const objectType = checker.getTypeFromTypeNode(node.objectType);
            if (tracesToOpenHarnessClient(objectType, checker, depth + 1, seen)) {
              indexedAccessTraces = true;
              return;
            }
          }
          ts.forEachChild(node, inspectTypeNode);
        }
        inspectTypeNode(decl.type);
        if (indexedAccessTraces) return true;
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
    const tsconfigConfigs = discoverWorkspaceScanConfigs(cwd);

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

  const visitedFiles = new Set();
  for (const item of programs) {
    const program = item.program || item;
    const checker = program.getTypeChecker();
    const files = item.scanFiles || program.getSourceFiles().map((sf) => sf.fileName);

    for (const filePath of files) {
      const normalized = filePath.replaceAll("\\", "/");
      const rel = relative(cwd, filePath).replaceAll("\\", "/");

      if (visitedFiles.has(normalized)) continue;
      visitedFiles.add(normalized);

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
            const propertyNames = literalKeysFromTypeNode(node.indexType, checker);
            if (propertyNames.length > 0) {
              for (const propName of propertyNames) {
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
            const parameter = ts.isParameter(node.parent.parent) ? node.parent.parent : null;
            if (initExpr || parameter) {
              const initType = checker.getTypeAtLocation(initExpr || parameter);
              if (tracesToOpenHarnessClient(initType, checker)) {
                const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart());
                references.push({
                  file: rel,
                  line: line + 1,
                  column: character + 1,
                  method: propName,
                  replacement: compatMethods.get(propName) || "",
                  scope,
                  receiver: parameter ? "parameter-destructured" : "destructured",
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
