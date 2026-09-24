import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { DetectionResult, SourceInspection } from "../core/converter.js";

export const PORTABLE_PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const legacyManifest = ".codex-plugin/plugin.json";
export interface CodexSource {
  inspection: SourceInspection;
  files: string[];
  metadataPaths: string[];
  skillRoots: string[];
  mcp: Array<{ path: string; servers: Record<string, unknown>; portable: boolean }>;
  unsupported: Array<{ kind: string; path: string; reason: string }>;
  description?: string;
  displayName?: string;
}

export function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

/** Reject links before opening any source file, including manifest parents. */
async function sourceFiles(root: string, directory = root): Promise<string[]> {
  const info = await lstat(directory);
  if (info.isSymbolicLink()) throw new Error(`Codex source link is not allowed: ${directory}`);
  if (!info.isDirectory()) throw new Error(`Codex source must be a directory: ${directory}`);
  const files: string[] = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Codex source link is not allowed: ${full}`);
    if (entry.isDirectory()) files.push(...await sourceFiles(root, full));
    else if (entry.isFile()) files.push(relative(root, full).replaceAll("\\", "/"));
    else throw new Error(`Unsupported Codex source file type: ${full}`);
  }
  return files;
}

export function isWithin(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
}

function pathDeclaration(root: string, value: string): string {
  if (!value.startsWith("./") || /[\\:\0]/.test(value) || value.split("/").includes("..")) {
    throw new Error(`Invalid Codex component path: ${value}`);
  }
  const full = resolve(root, value);
  if (full === root || !isWithin(root, full)) throw new Error(`Codex component path escapes source: ${value}`);
  const path = relative(root, full).replaceAll("\\", "/");
  if (path.split("/").some(part => [".git", ".codex-plugin", ".claude-plugin", ".vykor-plugin", ".vykor-conversion"].includes(part))) {
    throw new Error(`Reserved Codex component path: ${value}`);
  }
  return path;
}

async function declaredPaths(root: string, value: unknown, label: string, defaults: string[]): Promise<string[]> {
  if (value === undefined) return (await Promise.all(defaults.map(async path => await exists(join(root, path)) ? path : undefined))).filter((path): path is string => path !== undefined);
  const values = typeof value === "string" ? [value] : value;
  if (!Array.isArray(values) || !values.every(path => typeof path === "string")) throw new Error(`${label} must be a path or path array`);
  const paths = values.map(path => pathDeclaration(root, path));
  for (const path of paths) if (!(await exists(join(root, path)))) throw new Error(`Codex component path does not exist: ${path}`);
  return [...new Set(paths)];
}

async function readJson(root: string, path: string): Promise<Record<string, unknown>> {
  return object(JSON.parse(await readFile(join(root, path), "utf8")), path);
}

export async function detectCodexPlugin(rootInput: string): Promise<DetectionResult | null> {
  const root = resolve(rootInput);
  // Explicit evidence is enough for detection. Inspection owns validation errors.
  if (await exists(join(root, legacyManifest))) return { converterId: "codex", confidence: 1, evidence: [legacyManifest] };
  if (!(await exists(join(root, "plugin.json")))) return null;
  await sourceFiles(root);
  const manifest = await readJson(root, "plugin.json");
  return manifest.$schema === PORTABLE_PLUGIN_SCHEMA
    ? { converterId: "codex", confidence: 1, evidence: [`plugin.json:${PORTABLE_PLUGIN_SCHEMA}`] }
    : null;
}

export async function readCodexSource(rootInput: string): Promise<CodexSource> {
  const root = resolve(rootInput);
  const files = await sourceFiles(root);
  const portableCandidate = files.includes("plugin.json") ? await readJson(root, "plugin.json") : undefined;
  if (typeof portableCandidate?.$schema === "string" && portableCandidate.$schema.startsWith("https://agent-plugins.org/") && portableCandidate.$schema !== PORTABLE_PLUGIN_SCHEMA) {
    throw new Error(`Unsupported portable plugin schema: ${portableCandidate.$schema}`);
  }
  const portable = portableCandidate?.$schema === PORTABLE_PLUGIN_SCHEMA;
  const extensions = portable && portableCandidate!.extensions !== undefined ? object(portableCandidate!.extensions, "extensions") : {};
  const inline = extensions["com.openai"];
  const legacy = (!portable || inline === undefined) && files.includes(legacyManifest) ? await readJson(root, legacyManifest) : undefined;
  const manifest = portable ? portableCandidate! : legacy;
  if (!manifest) throw new Error("Codex manifest is missing or the portable schema is not supported");
  if (typeof manifest.name !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifest.name)) throw new Error("Codex name must use kebab-case");
  if (manifest.version !== undefined && (typeof manifest.version !== "string" || !manifest.version.trim())) throw new Error("Codex version must be a nonempty string");
  const settings = portable
    ? (extensions["com.openai"] === undefined ? legacy ?? {} : object(extensions["com.openai"], "extensions.com.openai"))
    : manifest;
  const inventory: Record<string, string[]> = {};
  const declaredSkillRoots = await declaredPaths(root, portable ? undefined : settings.skills, "skills", ["skills"]);
  const skillRoots = declaredSkillRoots.filter(path => !declaredSkillRoots.some(parent => parent !== path && path.startsWith(`${parent}/`)));
  inventory.skills = [];
  for (const path of skillRoots) {
    const skills = files.filter(file => (file === path || file.startsWith(`${path}/`)) && file.split("/").at(-1) === "SKILL.md");
    if (!skills.length) throw new Error(`Codex skill path contains no SKILL.md: ${path}`);
    inventory.skills.push(...skills.map(file => join(root, file)));
  }
  inventory.skills = [...new Set(inventory.skills)];
  const mcp: CodexSource["mcp"] = [];
  const mcpDeclaration = portable ? undefined : settings.mcpServers;
  if (mcpDeclaration && typeof mcpDeclaration === "object" && !Array.isArray(mcpDeclaration)) {
    const raw = object(mcpDeclaration, "mcpServers");
    mcp.push({ path: `${legacyManifest}#mcpServers`, servers: object(raw.mcpServers ?? raw, "mcpServers"), portable: false });
  } else {
    for (const path of await declaredPaths(root, mcpDeclaration, "mcpServers", [portable ? "mcp.json" : ".mcp.json"])) {
      const raw = await readJson(root, path);
      mcp.push({ path, servers: object(raw.mcpServers, `${path}.mcpServers`), portable });
    }
  }
  inventory.mcpServers = mcp.map(value => value.path);
  const unsupported: CodexSource["unsupported"] = [];
  if (portable) {
    const portableFields = new Set(["$schema", "name", "version", "description", "author", "homepage", "repository", "license", "keywords", "extensions"]);
    for (const key of Object.keys(manifest).filter(key => !portableFields.has(key))) {
      unsupported.push({ kind: "manifest", path: `plugin.json#${key}`, reason: `Unrecognized portable manifest field: ${key}` });
    }
    for (const [key, extension] of Object.entries(extensions)) {
      if (key === "com.openai") continue;
      object(extension, `extensions.${key}`);
      unsupported.push({ kind: "extensions", path: `plugin.json#extensions.${key}`, reason: `Portable extension ${key} has no Native conversion` });
    }
  }
  for (const skill of inventory.skills) {
    const path = relative(root, join(dirname(skill), "agents/openai.yaml")).replaceAll("\\", "/");
    if (files.includes(path)) unsupported.push({ kind: "skillMetadata", path, reason: "Codex skill invocation policy, tool dependencies and presentation in agents/openai.yaml are not applied by Native" });
  }
  for (const kind of ["apps", "hooks", "agents", "commands", "lspServers", "tools", "workflows", "channels", "providers", "ui", "outputStyles", "themes", "monitors", "binaries"]) {
    const declaration = settings[kind];
    const defaults = kind === "hooks" ? ["hooks/hooks.json"] : [];
    let paths: string[];
    if (declaration !== null && typeof declaration === "object" && (!Array.isArray(declaration) || declaration.some(item => typeof item !== "string"))) {
      paths = [`${portable ? "plugin.json" : legacyManifest}#${kind}`];
    } else paths = await declaredPaths(root, declaration, kind, defaults);
    for (const path of paths) unsupported.push({ kind, path, reason: `Codex ${kind} has no supported Native conversion in this version` });
    if (paths.length) inventory[kind] = paths;
  }
  const known = new Set(["$schema", "name", "version", "description", "author", "homepage", "repository", "license", "keywords", "skills", "mcpServers", "interface", "extensions", ...unsupported.map(item => item.kind)]);
  for (const key of Object.keys(settings).filter(key => !known.has(key))) {
    unsupported.push({ kind: key, path: `${portable ? "plugin.json" : legacyManifest}#${key}`, reason: `Unrecognized Codex manifest field: ${key}` });
  }
  const ui = settings.interface === undefined ? {} : object(settings.interface, "interface");
  return {
    inspection: { root, format: "codex", identity: { id: `converted.codex.${manifest.name}`, name: manifest.name, version: (manifest.version as string | undefined) ?? "0.0.0" }, inventory, diagnostics: [] },
    files, metadataPaths: [...(portable ? ["plugin.json"] : []), ...mcp.map(item => item.path), ...unsupported.map(item => item.path)], skillRoots, mcp, unsupported,
    ...(typeof manifest.description === "string" ? { description: manifest.description } : {}),
    ...(typeof ui.displayName === "string" && ui.displayName.trim() ? { displayName: ui.displayName } : {}),
  };
}
