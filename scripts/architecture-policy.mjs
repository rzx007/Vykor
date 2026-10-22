import { existsSync, readFileSync, readdirSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";

const normalize = (value) => value.replaceAll("\\", "/");
const packageName = (path) => path.startsWith("@") ? path.split("/").slice(0, 2).join("/") : path.split("/")[0];
const phaseNumber = (phase) => Number(phase.slice(1));
const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));
const sourceExtension = /\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/;

/** Validate the committed schema without adding a dependency to this Node script. */
export function validateArchitecturePolicy(policy, schema) {
  const errors = [];
  function visit(value, rule, path) {
    if (rule.$ref) return visit(value, schema.$defs[rule.$ref.split("/").at(-1)], path);
    if (rule.enum && !rule.enum.includes(value)) errors.push(`${path}: expected ${rule.enum.join("/")}`);
    if (rule.type === "object") {
      if (!value || typeof value !== "object" || Array.isArray(value)) { errors.push(`${path}: expected object`); return; }
      for (const key of rule.required ?? []) if (!(key in value)) errors.push(`${path}: missing ${key}`);
      for (const [key, child] of Object.entries(value)) {
        const property = rule.properties?.[key];
        if (property) visit(child, property, `${path}.${key}`);
        else if (rule.additionalProperties === false) errors.push(`${path}: unknown ${key}`);
        else if (typeof rule.additionalProperties === "object") visit(child, rule.additionalProperties, `${path}.${key}`);
      }
    } else if (rule.type === "array") {
      if (!Array.isArray(value)) { errors.push(`${path}: expected array`); return; }
      if (rule.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) errors.push(`${path}: duplicate items`);
      value.forEach((item, index) => visit(item, rule.items, `${path}[${index}]`));
    } else if (rule.type === "string") {
      if (typeof value !== "string" || (rule.minLength && value.length < rule.minLength)
        || (rule.pattern && !new RegExp(rule.pattern).test(value))) errors.push(`${path}: invalid string`);
    } else if (rule.type === "boolean" && typeof value !== "boolean") errors.push(`${path}: expected boolean`);
  }
  visit(policy, schema, "policy");
  if (errors.length) return errors;
  const keys = new Set();
  for (const item of policy.stageExceptions) {
    const key = `${item.fromFile}\0${item.target}`;
    if (keys.has(key)) errors.push(`Duplicate architecture exception: ${item.fromFile} ${item.target}`);
    keys.add(key);
    if (phaseNumber(item.removeByPhase) <= phaseNumber(policy.currentPhase)) errors.push(`Expired architecture exception: ${item.fromFile} ${item.target} (${item.removeByPhase})`);
  }
  const ids = policy.modules.map((rule) => rule.id);
  if (new Set(ids).size !== ids.length) errors.push("Duplicate architecture module rule id");
  const directories = Object.values(policy.packages).map((item) => item.directory);
  if (new Set(directories).size !== directories.length) errors.push("Duplicate architecture package directory");
  for (const [name, item] of Object.entries(policy.packages)) for (const dependency of [...item.allowed, ...(item.allowedDeclarationOrigins ?? [])]) {
    if (!policy.packages[dependency]) errors.push(`${name}: unknown allowed package ${dependency}`);
  }
  for (const rule of policy.modules) if (!rule.fromFiles?.length && !rule.fromPaths?.length) errors.push(`${rule.id}: missing source selector`);
  return errors;
}

export function readArchitecturePolicy(root) {
  const policy = JSON.parse(readFileSync(join(root, "scripts/architecture-policy.json"), "utf8"));
  const schema = JSON.parse(readFileSync(join(root, "scripts/architecture-policy.schema.json"), "utf8"));
  const errors = validateArchitecturePolicy(policy, schema);
  if (errors.length) throw new Error(errors.join("\n"));
  return policy;
}

function workspaceOwner(path) {
  const match = normalize(path).match(/^(packages|apps)\/([^/]+)\//);
  return match ? `${match[1]}/${match[2]}` : undefined;
}

const matchesFrom = (rule, path) => rule.fromFiles?.includes(path) || rule.fromPaths?.some((prefix) => path.startsWith(prefix));

/** All targets are exact identities. Exceptions never work as glob patterns. */
export function moduleViolations(input, policy) {
  const fromFile = normalize(input.fromFile);
  const resolvedFile = input.resolvedFile && normalize(input.resolvedFile);
  const owner = workspaceOwner(fromFile);
  const actualOwner = resolvedFile && workspaceOwner(resolvedFile);
  const workspace = (path) => policy.packages[Object.keys(policy.packages).find((name) => policy.packages[name].directory === path)];
  const ownerName = Object.keys(policy.packages).find((name) => policy.packages[name].directory === owner);
  const targetName = actualOwner
    ? Object.keys(policy.packages).find((name) => policy.packages[name].directory === actualOwner)
    : policy.packages[packageName(input.specifier)] && packageName(input.specifier);
  const names = [...new Set(input.importedNames ?? ["*"])].sort();
  const identity = `${resolvedFile ?? input.specifier}#${names.join(",")}${input.typeOnly ? ":type" : ""}`;
  const violations = [];
  function add(id, rule, reason) {
    violations.push({ fromFile, target: `${id}:${identity}`, reason, removeByPhase: rule.removeByPhase, migrationId: rule.migrationId,
      message: `${fromFile}: ${id}: ${reason} (${input.specifier} -> ${identity})` });
  }
  const ownerRule = workspace(owner);
  // Canonical declarations re-exported by an allowed package do not create a direct dependency.
  // The declaration origin still has its own explicit ceiling; arbitrary barrels cannot bypass allowed.
  if (ownerRule && targetName && ownerName !== targetName && ![...ownerRule.allowed, ...(input.declarationOrigin ? ownerRule.allowedDeclarationOrigins ?? [] : [])].includes(targetName)) {
    add("package", ownerRule, `${ownerName} must not depend on ${targetName}`);
  }
  for (const rule of policy.modules) {
    if (!matchesFrom(rule, fromFile)) continue;
    const testExternal = /\.test\.[cm]?[jt]sx?$/.test(fromFile) && rule.testExternal?.includes(input.specifier);
    if (rule.targetPackages && !rule.targetPackages.includes(targetName)) continue;
    if (targetName && targetName !== ownerName && rule.allowed && !rule.allowed.includes(targetName)) add(rule.id, rule, `module must not depend on ${targetName}`);
    if (resolvedFile && rule.allowed && !targetName && actualOwner !== owner) add(rule.id, rule, `source is outside the allowed packages: ${resolvedFile}`);
    if (resolvedFile && rule.forbidPaths?.some((path) => resolvedFile.startsWith(path))) add(rule.id, rule, `forbidden source ${resolvedFile}`);
    if (resolvedFile && rule.allowTargetPaths && !rule.allowTargetPaths.some((path) => path.endsWith("/") ? resolvedFile.startsWith(path) : resolvedFile === path)) add(rule.id, rule, `source is outside the allowed contract entries: ${resolvedFile}`);
    if (resolvedFile && actualOwner === owner && rule.allowSelfPaths && !rule.allowSelfPaths.some((path) => path.endsWith("/") ? resolvedFile.startsWith(path) : resolvedFile === path)) add(rule.id, rule, `source is outside the module: ${resolvedFile}`);
    if (!testExternal && rule.forbidBuiltins && (input.specifier.startsWith("node:") || builtins.has(input.specifier))) add(rule.id, rule, "Node builtin is not allowed");
    if (rule.forbidSpecifiers?.some((pattern) => new RegExp(pattern).test(input.specifier))) add(rule.id, rule, "forbidden module specifier");
    if (rule.symbols?.some((pattern) => names.some((name) => new RegExp(pattern).test(name)))) add(rule.id, rule, `forbidden declaration ${names.join(",")}`);
    if (rule.forbidTypeReferences?.some((pattern) => input.typeReferences?.some((name) => new RegExp(pattern).test(name)))) add(rule.id, rule, `runtime type is not data: ${input.typeReferences.join(",")}`);
    if (rule.typeOnlyPackages?.includes(targetName) && !input.typeOnly) add(rule.id, rule, "only a type import is allowed");
    if (!testExternal && !(packageName(input.specifier) === "vitest" && /\.test\.[cm]?[jt]sx?$/.test(fromFile)) && rule.allowExternal && !targetName && !resolvedFile && !input.specifier.startsWith(".") && !rule.allowExternal.includes(packageName(input.specifier))) add(rule.id, rule, "external implementation is not allowed");
  }
  return [...new Map(violations.map((item) => [item.target, item])).values()];
}

export function checkModuleDependency(input, policy) {
  return moduleViolations(input, policy).filter((item) => !policy.stageExceptions.some((exception) =>
    normalize(exception.fromFile) === item.fromFile && exception.target === item.target
    && exception.removeByPhase === item.removeByPhase && exception.migrationId === item.migrationId
    && phaseNumber(exception.removeByPhase) > phaseNumber(policy.currentPhase),
  )).map((item) => item.message);
}

/** Syntax-based extraction includes aliases, type references and CommonJS/dynamic forms. */
export function extractModuleDependencies(source, file = "source.ts") {
  return parseModule(source, file).dependencies;
}

function parseModule(source, file) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const dependencies = [];
  const exports = new Map();
  const imported = new Map();
  const stars = [];
  const locals = new Set();
  const declarations = new Map();
  const typeReferences = new Set();
  const add = (specifier, names, typeOnly = false) => {
    const entry = { specifier, importedNames: names, typeOnly };
    dependencies.push(entry);
    return entry;
  };
  function visit(node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const entries = [];
      if (clause?.name) entries.push([clause.name.text, "default", clause.isTypeOnly]);
      if (bindings && ts.isNamedImports(bindings)) for (const item of bindings.elements) entries.push([item.name.text, item.propertyName?.text ?? item.name.text, clause.isTypeOnly || item.isTypeOnly]);
      if (bindings && ts.isNamespaceImport(bindings)) entries.push([bindings.name.text, "*", clause.isTypeOnly]);
      if (!entries.length) add(node.moduleSpecifier.text, ["*"], false);
      for (const typeOnly of [false, true]) {
        const group = entries.filter((entry) => Boolean(entry[2]) === typeOnly);
        if (!group.length) continue;
        const dependency = add(node.moduleSpecifier.text, group.map((entry) => entry[1]), typeOnly);
        for (const [local, name] of group) imported.set(local, { dependency, name });
      }
    } else if (ts.isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier) ? node.moduleSpecifier.text : undefined;
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const item of node.exportClause.elements) {
          const name = item.propertyName?.text ?? item.name.text;
          exports.set(item.name.text, specifier ? { dependency: add(specifier, [name], node.isTypeOnly || item.isTypeOnly), name } : { local: name });
        }
      } else if (specifier) {
        const dependency = add(specifier, ["*"], node.isTypeOnly);
        if (node.exportClause && ts.isNamespaceExport(node.exportClause)) exports.set(node.exportClause.name.text, { dependency, name: "*" });
        else stars.push(dependency);
      }
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteralLike(node.moduleReference.expression)) {
      imported.set(node.name.text, { dependency: add(node.moduleReference.expression.text, ["*"], node.isTypeOnly), name: "*" });
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteralLike(node.argument.literal)) {
      let qualifier = node.qualifier;
      while (qualifier && ts.isQualifiedName(qualifier)) qualifier = qualifier.left;
      add(node.argument.literal.text, [qualifier?.text ?? "*"], true);
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))
      && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
      let parent = node.parent;
      while (parent && (ts.isAwaitExpression(parent) || ts.isParenthesizedExpression(parent))) parent = parent.parent;
      const binding = parent && ts.isVariableDeclaration(parent) ? parent.name : undefined;
      const names = binding && ts.isObjectBindingPattern(binding) ? binding.elements.map((item) => item.propertyName?.text ?? item.name.text) :
        parent && ts.isPropertyAccessExpression(parent) ? [parent.name.text] : ["*"];
      add(node.arguments[0].text, names, false);
    }
    if (node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
      if (node.name && ts.isIdentifier(node.name)) locals.add(node.name.text);
      if (ts.isVariableStatement(node)) for (const declaration of node.declarationList.declarations) if (ts.isIdentifier(declaration.name)) locals.add(declaration.name.text);
      if (node.modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)) locals.add("default");
    }
    if ((ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)
      || ts.isVariableDeclaration(node)) && node.name && ts.isIdentifier(node.name)) declarations.set(node.name.text, node);
    if (ts.isTypeReferenceNode(node)) typeReferences.add(node.typeName.getText(ast));
    if (ts.isTypeQueryNode(node)) typeReferences.add(node.exprName.getText(ast));
    if (ts.isExpressionWithTypeArguments(node)) typeReferences.add(node.expression.getText(ast));
    if (ts.isExportAssignment(node)) exports.set("default", ts.isIdentifier(node.expression) ? { local: node.expression.text } : { local: "default" });
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return { dependencies, exports, imported, stars, locals, declarations, typeReferences };
}

function walkSources(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? ["node_modules", "dist", ".git", ".turbo"].includes(entry.name) ? [] : walkSources(path)
      : entry.isFile() && sourceExtension.test(path) ? [path] : [];
  });
}

function workspacePackages(root) {
  return ["packages", "apps"].flatMap((parent) => existsSync(join(root, parent)) ? readdirSync(join(root, parent), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, parent, entry.name, "package.json")))
    .map((entry) => {
      const directory = join(root, parent, entry.name);
      return { directory, json: JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) };
    }) : []);
}

function sourceCandidate(path) {
  const stem = path.replace(/\.(?:d\.[cm]?ts|[cm]?js)$/, "");
  return [path, `${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.cts`, `${path}.ts`, `${path}.tsx`, join(path, "index.ts"), join(path, "index.tsx")]
    .find((candidate) => sourceExtension.test(candidate) && ts.sys.fileExists(candidate));
}

function exportTarget(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return undefined;
  return exportTarget(value.types) ?? exportTarget(value.import) ?? exportTarget(value.default);
}

/** Resolve declarations through barrels, renamed exports, namespace exports and aliases. */
export function collectPolicyViolations(root, policy) {
  const packages = workspacePackages(root);
  const parsed = new Map();
  const resolutions = new Map();
  const originCache = new Map();
  const compilerOptions = new Map();
  function optionsFor(config, active = new Set()) {
    if (compilerOptions.has(config)) return compilerOptions.get(config);
    if (active.has(config)) return {};
    const raw = ts.readConfigFile(config, ts.sys.readFile).config;
    let inherited = {};
    for (const entry of Array.isArray(raw?.extends) ? raw.extends : raw?.extends ? [raw.extends] : []) {
      if (!entry.startsWith(".")) continue;
      const base = resolve(dirname(config), entry);
      const parent = existsSync(base) ? base : `${base}.json`;
      if (existsSync(parent)) inherited = { ...inherited, ...optionsFor(parent, new Set(active).add(config)) };
    }
    const own = ts.convertCompilerOptionsFromJson(raw?.compilerOptions ?? {}, dirname(config)).options;
    const options = { ...inherited, ...own };
    compilerOptions.set(config, options);
    return options;
  }
  const module = (file) => {
    if (!parsed.has(file)) parsed.set(file, parseModule(readFileSync(file, "utf8"), file));
    return parsed.get(file);
  };
  function resolveImport(from, specifier) {
    const key = `${from}\0${specifier}`;
    if (resolutions.has(key)) return resolutions.get(key);
    let result;
    if (specifier.startsWith(".")) result = sourceCandidate(resolve(dirname(from), specifier));
    else {
      const owner = packages.find(({ json }) => json.name === packageName(specifier));
      if (owner) {
        const subpath = specifier.slice(owner.json.name.length);
        const target = exportTarget(owner.json.exports?.[subpath ? `.${subpath}` : "."])
          ?? (!subpath ? owner.json.types ?? owner.json.main ?? "./src/index.ts" : `./src${subpath}.ts`);
        // Published SDK entries point to dist; source ownership lives in src.
        result = sourceCandidate(resolve(owner.directory, target.replace(/^\.\/dist\//, "./src/")))
          ?? sourceCandidate(resolve(owner.directory, target));
      } else if (!builtins.has(specifier) && !specifier.startsWith("node:")) {
        const config = ts.findConfigFile(dirname(from), ts.sys.fileExists);
        if (config) {
          // Parse inherited compiler options only; do not enumerate the project again.
          const options = optionsFor(config);
          if (Object.keys(options.paths ?? {}).some((pattern) => specifier.startsWith(pattern.split("*")[0]))) {
            result = ts.resolveModuleName(specifier, from, options, ts.sys).resolvedModule?.resolvedFileName;
          }
        }
      }
    }
    result = result && resolve(result);
    resolutions.set(key, result);
    return result;
  }
  function origins(file, name, includeTypes, includeSignatures, stopAtProtocol, context = { visited: new Set(), cycles: 0 }) {
    const key = `${file}\0${name}\0${includeTypes}\0${includeSignatures}\0${stopAtProtocol}`;
    if (originCache.has(key)) return originCache.get(key);
    if (context.visited.has(key)) { context.cycles++; return []; }
    const isRoot = context.visited.size === 0;
    const cycleCount = context.cycles;
    // A root query needs the reachable declarations once, regardless of how
    // many alias/type paths lead to each declaration. Share the visited set
    // across branches as well as cycles so diamonds do not grow exponentially.
    context.visited.add(key);
    const data = module(file);
    const results = [];
    const follow = (entry) => {
      const target = resolveImport(file, entry.dependency.specifier);
      if (target && sourceExtension.test(target)) results.push(...origins(target, entry.name, includeTypes, includeSignatures, stopAtProtocol, context));
    };
    if (name === "*") {
      for (const local of data.locals) {
        if (includeSignatures) results.push(...origins(file, local, includeTypes, includeSignatures, stopAtProtocol, context));
        else results.push({ file, name: local });
      }
      for (const exported of data.exports.keys()) results.push(...origins(file, exported, includeTypes, includeSignatures, stopAtProtocol, context));
      for (const star of data.stars) follow({ dependency: star, name: "*" });
    } else {
      const entry = data.exports.get(name);
      if (entry?.dependency) follow(entry);
      else if (entry?.local && data.imported.has(entry.local)) follow(data.imported.get(entry.local));
      else if (entry || data.locals.has(name)) results.push({ file, name });
      else for (const star of data.stars) follow({ dependency: star, name });
      const declaration = data.declarations.get(entry?.local ?? name);
      if (declaration && includeTypes && !(stopAtProtocol && workspaceOwner(normalize(relative(root, file))) === "packages/protocol")
        && (includeSignatures || ts.isInterfaceDeclaration(declaration) || ts.isTypeAliasDeclaration(declaration))) {
        const references = new Set();
        const typeReferences = new Set();
        function visitType(node) {
          if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteralLike(node.argument.literal)) {
            let qualifier = node.qualifier;
            while (qualifier && ts.isQualifiedName(qualifier)) qualifier = qualifier.left;
            follow({ dependency: { specifier: node.argument.literal.text }, name: qualifier?.text ?? "*" });
          }
          if (ts.isTypeReferenceNode(node) || ts.isTypeQueryNode(node) || ts.isExpressionWithTypeArguments(node)) {
            let reference = ts.isTypeReferenceNode(node) ? node.typeName : ts.isTypeQueryNode(node) ? node.exprName : node.expression;
            typeReferences.add(reference.getText());
            while (ts.isQualifiedName(reference)) reference = reference.left;
            while (ts.isPropertyAccessExpression(reference)) reference = reference.expression;
            references.add(reference.text);
          }
          ts.forEachChild(node, visitType);
        }
        // Declarations expose signatures, including callable initializers, not implementation bodies.
        // Following implementation-local annotations would pull unrelated host graphs into a DTO.
        const visitSignature = node => {
          for (const parameter of node.parameters ?? []) if (parameter.type) visitType(parameter.type);
          if (node.type) visitType(node.type);
          // async always exposes Promise, including inferred returns and async arrows.
          if (node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)) typeReferences.add("Promise");
        };
        if (ts.isVariableDeclaration(declaration)) {
          visitSignature(declaration);
          let initializer = declaration.initializer;
          while (initializer && (ts.isParenthesizedExpression(initializer) || ts.isAsExpression(initializer)
            || ts.isSatisfiesExpression(initializer))) initializer = initializer.expression;
          if (initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) visitSignature(initializer);
        } else if (ts.isFunctionDeclaration(declaration)) visitSignature(declaration);
        else if (ts.isClassDeclaration(declaration)) {
          for (const clause of declaration.heritageClauses ?? []) visitType(clause);
          for (const member of declaration.members) visitSignature(member);
        } else visitType(declaration);
        // Check the selected declaration, including private aliases reached from it.
        // Checking the entire source module would reject data next to a host interface.
        let origin = results.find(item => item.file === file && item.name === name);
        if (!origin) results.push(origin = { file, name });
        origin.typeReferences = [...typeReferences];
        for (const reference of references) {
          if (data.imported.has(reference)) follow(data.imported.get(reference));
          else if (reference !== name && data.declarations.has(reference)) results.push(...origins(file, reference, includeTypes, includeSignatures, stopAtProtocol, context));
        }
      }
    }
    // Do not cache an incomplete result reached while breaking an export cycle.
    const unique = [...new Map(results.map(item => [`${item.file}\0${item.name}`, item])).values()];
    if (isRoot || cycleCount === context.cycles) originCache.set(key, unique);
    return unique;
  }
  const violations = new Map();
  const add = (input) => {
    for (const item of moduleViolations(input, policy)) violations.set(`${item.fromFile}\0${item.target}`, item);
  };
  for (const owner of packages) {
    for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      for (const name of Object.keys(owner.json[section] ?? {})) if (policy.packages[name] || section !== "devDependencies") {
        add({ fromFile: normalize(relative(root, join(owner.directory, "package.json"))), specifier: name, importedNames: ["manifest"] });
      }
    }
    for (const file of walkSources(join(owner.directory, "src"))) {
      const fromFile = normalize(relative(root, file));
      const traceRules = policy.modules.filter(rule => rule.traceTypes && matchesFrom(rule, fromFile));
      const legacyTrace = policy.modules.some(rule => ["kernel", "route-storage", "storage-hosts"].includes(rule.id) && matchesFrom(rule, fromFile));
      if (policy.modules.some(rule => rule.forbidTypeReferences && matchesFrom(rule, fromFile))) {
        for (const name of module(file).typeReferences) add({ fromFile, specifier: "<local-types>", resolvedFile: fromFile, importedNames: [name], typeOnly: true, typeReferences: [name] });
      }
      for (const dependency of module(file).dependencies) {
        const target = resolveImport(file, dependency.specifier);
        const input = { ...dependency, fromFile, resolvedFile: target && normalize(relative(root, target)) };
        add(input);
        if (target && sourceExtension.test(target)) {
          const includeTypes = legacyTrace || traceRules.length > 0;
          const declarations = new Map();
          const stopAtProtocol = !legacyTrace && traceRules.length > 0 && traceRules.every(rule => rule.targetPackages?.length === 1 && rule.targetPackages[0] === "@vykor/protocol");
          for (const name of dependency.importedNames) for (const origin of origins(target, name, includeTypes, traceRules.length > 0, stopAtProtocol)) {
            // A targeted trace follows wrappers to that layer without changing unrelated old ceilings.
            const originPath = normalize(relative(root, origin.file));
            const originPackage = packages.find(item => normalize(relative(root, item.directory)) === workspaceOwner(originPath))?.json.name;
            if (!legacyTrace && includeTypes && !traceRules.some(rule => !rule.targetPackages || rule.targetPackages.includes(originPackage))
              && origin.file !== target) continue;
            if (!declarations.has(origin.file)) declarations.set(origin.file, { names: new Set(), typeReferences: new Set() });
            const declaration = declarations.get(origin.file);
            declaration.names.add(origin.name);
            for (const reference of origin.typeReferences ?? []) declaration.typeReferences.add(reference);
          }
          for (const [file, declaration] of declarations) add({ ...input, declarationOrigin: true, resolvedFile: normalize(relative(root, file)),
            importedNames: [...declaration.names], typeReferences: [...declaration.typeReferences] });
        }
      }
    }
  }
  return [...violations.values()].sort((a, b) => a.fromFile.localeCompare(b.fromFile) || a.target.localeCompare(b.target));
}

export function collectArchitecturePolicyErrors(root, policy = readArchitecturePolicy(root)) {
  const violations = collectPolicyViolations(root, policy);
  const active = new Map(violations.map((item) => [`${item.fromFile}\0${item.target}`, item]));
  const exceptions = new Set(policy.stageExceptions.map((item) => `${item.fromFile}\0${item.target}`));
  const errors = violations.filter((item) => !exceptions.has(`${item.fromFile}\0${item.target}`)).map((item) => item.message);
  for (const owner of workspacePackages(root)) if (normalize(relative(root, owner.directory)).startsWith("packages/")) {
    if (policy.packages[owner.json.name]?.directory !== normalize(relative(root, owner.directory))) errors.push(`Workspace package missing architecture policy: ${owner.json.name}`);
  }
  for (const item of policy.stageExceptions) {
    if (phaseNumber(item.removeByPhase) <= phaseNumber(policy.currentPhase)) errors.push(`Expired architecture exception: ${item.fromFile} ${item.target}`);
    if (!active.has(`${item.fromFile}\0${item.target}`)) errors.push(`Stale architecture exception: ${item.fromFile} ${item.target}; remove it`);
    const violation = active.get(`${item.fromFile}\0${item.target}`);
    if (violation && (violation.removeByPhase !== item.removeByPhase || violation.migrationId !== item.migrationId)) errors.push(`Architecture exception deadline/migration mismatch: ${item.fromFile} ${item.target}`);
  }
  return { errors, violationCount: violations.length, exceptionCount: policy.stageExceptions.length };
}
