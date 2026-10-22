import { readFile } from "node:fs/promises";
import { dirname, resolve, relative, isAbsolute } from "node:path";
import ts from "typescript";

const hostModules = /(?:^src\/node\/|agent-runtime\/src\/node\/|(?:^|\/)(?:host-config|tools|plugins|coordinator|protocol|services|server|execution-node|api|auth|hooks|mcp|memory|sandbox|skills|terminal-node|terminal|jobs)\/src\/)/;
export function verifyKernelInputs(metafile) {
  const forbidden = Object.keys(metafile.inputs).filter(path => hostModules.test(path.replaceAll("\\", "/")));
  if (forbidden.length) throw new Error(`Kernel bundle reaches Node host modules:\n${forbidden.join("\n")}`);
}

/** Walk the actual exported declaration closure, including imports inside type expressions. */
export async function verifyKernelDeclarations(root = process.cwd()) {
  const entry = resolve(root, "dist/kernel-entry.d.ts");
  const kernel = resolve(root, "dist/kernel");
  const options = { moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 };
  const visited = new Set();
  async function visit(file) {
    if (visited.has(file)) return;
    const normalizedFile = file.replaceAll("\\", "/");
    if (file !== entry && !normalizedFile.startsWith(kernel.replaceAll("\\", "/") + "/") &&
        !/(?:\/packages\/|\/node_modules\/@vykor\/)(?:agent-contracts|core|environment)\//.test(normalizedFile))
      throw new Error(`Kernel declaration reaches a host path: ${file}`);
    visited.add(file);
    const source = await readFile(file, "utf8");
    if (/\bNodeJS\.|\b(?:Settings|PluginAppRecord|GoalRunBinding|McpClientManager|AgentJobHost|AgentScheduleEffects)\b/.test(source))
      throw new Error(`Kernel declaration reaches Node-specific types: ${file}`);
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const imports = new Set();
    if (ast.typeReferenceDirectives.length) throw new Error(`Kernel declaration reaches a host type reference: ${file}`);
    function scan(node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) imports.add(node.moduleSpecifier.text);
      if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteralLike(node.argument.literal)) imports.add(node.argument.literal.text);
      if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteralLike(node.moduleReference.expression)) imports.add(node.moduleReference.expression.text);
      ts.forEachChild(node, scan);
    }
    scan(ast);
    for (const reference of ast.referencedFiles) await visit(resolve(dirname(file), reference.fileName));
    for (const name of imports) {
      // Core's source-distributed types include its crypto implementation import.
      if (name === "node:crypto" && !file.endsWith(".d.ts")) continue;
      if (!name.startsWith(".") && !/^@vykor\/(?:agent-contracts|core|environment)(?:\/|$)/.test(name))
        throw new Error(`Kernel declaration reaches a host dependency: ${file} -> ${name}`);
      const target = ts.resolveModuleName(name, file, options, ts.sys).resolvedModule?.resolvedFileName;
      if (!target) throw new Error(`Cannot resolve Kernel declaration: ${file} -> ${name}`);
      const normalized = target.replaceAll("\\", "/");
      if (hostModules.test(normalized)) throw new Error(`Kernel declaration reaches a host path: ${file} -> ${target}`);
      if (normalized.startsWith(resolve(root, "dist").replaceAll("\\", "/") + "/")) {
        const local = relative(kernel, target);
        if (local.startsWith("..") || isAbsolute(local)) throw new Error(`Kernel declaration escapes kernel: ${target}`);
      }
      await visit(resolve(dirname(file), target));
    }
  }
  await visit(entry);
  return [...visited];
}
