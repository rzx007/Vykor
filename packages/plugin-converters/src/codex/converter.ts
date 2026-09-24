import { randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { requestedPluginPermissions, validateNativePlugin, type VykorPluginManifestV1 } from "@vykor/plugins";
import type { ConversionItem, ConversionPlan, ConversionReport, PluginConverter, SourceInspection } from "../core/converter.js";
import { digestSource, digestValue } from "../core/digest.js";
import { mapCodexMcp } from "./mcp.js";
import { detectCodexPlugin, isWithin, readCodexSource, type CodexSource } from "./source.js";

const VERSION = "1.0.0";
const MAPPING_VERSION = "1";
interface Prepared {
  source: CodexSource;
  plan: ConversionPlan;
  servers: Record<string, unknown>;
  permissions: NonNullable<VykorPluginManifestV1["permissions"]>;
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

async function prepare(inspection: SourceInspection): Promise<Prepared> {
  const before = await digestSource(inspection.root);
  const source = await readCodexSource(inspection.root);
  if (digestValue(source.inspection) !== digestValue(inspection)) throw new Error("Source inspection changed; inspect and plan again");
  const items: ConversionItem[] = (inspection.inventory.skills ?? []).map(path => {
    const sourcePath = relative(inspection.root, path).replaceAll("\\", "/");
    return { id: `skills:${sourcePath}`, sourceKind: "skills", sourcePath, targetKind: "skills", fidelity: "exact" };
  });
  const servers: Record<string, unknown> = Object.create(null);
  const seenServers = new Set<string>();
  const permissions: Prepared["permissions"] = {};
  for (const contribution of source.mcp) {
    for (const [name, raw] of Object.entries(contribution.servers).sort(([a], [b]) => a.localeCompare(b))) {
      if (!name.trim() || ["__proto__", "prototype", "constructor"].includes(name) || seenServers.has(name)) throw new Error(`Invalid or duplicate Codex MCP server name: ${name}`);
      seenServers.add(name);
      const mapped = mapCodexMcp(raw, contribution.portable);
      const id = `mcpServers:${contribution.path}#${name}`;
      const requiredApprovals = [id];
      if (mapped.config) {
        servers[name] = mapped.config;
        for (const category of ["network", "process"] as const) {
          for (const permission of mapped.permissions?.[category] ?? []) {
            permissions[category] = [...new Set([...(permissions[category] ?? []), permission])].sort();
            requiredApprovals.push(`${category}:${permission}`);
          }
        }
      }
      items.push({ id, sourceKind: "mcpServers", sourcePath: contribution.path,
        ...(mapped.config ? { targetKind: "mcpServers" } : {}), fidelity: mapped.config ? "adapted" : "unsupported",
        reason: mapped.reason, requiredApprovals });
    }
  }
  for (const value of source.unsupported) {
    const id = `${value.kind}:${value.path}`;
    items.push({ id, sourceKind: value.kind, sourcePath: value.path, fidelity: "unsupported", reason: value.reason, requiredApprovals: [id] });
  }
  const sourceDigest = await digestSource(inspection.root);
  if (before !== sourceDigest) throw new Error("Source changed during conversion planning; inspect and plan again");
  return {
    source, servers, permissions,
    plan: { schemaVersion: 1, converterId: "codex", converterVersion: VERSION, sourceFormat: "codex", sourceDigest,
      optionsDigest: digestValue({}), mappingVersion: MAPPING_VERSION,
      items: items.sort((a, b) => a.id.localeCompare(b.id)), diagnostics: [] },
  };
}

async function checkOutput(sourceRoot: string, output: string): Promise<void> {
  if (isWithin(sourceRoot, output)) throw new Error("Conversion output cannot be inside the source directory");
  if (await exists(output)) throw new Error(`Conversion output already exists: ${output}`);
  // Resolve the closest existing ancestor so a parent junction cannot place output inside source.
  let parent = dirname(output);
  while (!(await exists(parent))) parent = dirname(parent);
  const canonicalOutput = resolve(await realpath(parent), relative(parent, output));
  if (isWithin(await realpath(sourceRoot), canonicalOutput)) throw new Error("Conversion output resolves inside the source directory");
}

function isSourceMetadata(path: string, source: CodexSource): boolean {
  const lower = path.toLowerCase();
  const top = lower.split("/")[0]!;
  if ([".git", ".codex-plugin", ".claude-plugin", ".vykor-plugin", ".vykor-conversion"].includes(top)) return true;
  return source.metadataPaths.some(item => item.toLowerCase() === lower);
}

export class CodexPluginConverter implements PluginConverter {
  readonly id = "codex";
  readonly version = VERSION;
  readonly sourceFormat = "codex";
  detect = detectCodexPlugin;
  async inspect(root: string): Promise<SourceInspection> { return (await readCodexSource(root)).inspection; }
  async plan(inspection: SourceInspection, options: Record<string, unknown> = {}): Promise<ConversionPlan> {
    if (Object.keys(options).length) throw new Error("Codex conversion options are not supported in this version");
    return (await prepare(inspection)).plan;
  }

  async convert(input: { inspection: SourceInspection; plan: ConversionPlan; output: string; approvals?: string[] }): Promise<ConversionReport> {
    const output = resolve(input.output);
    await checkOutput(input.inspection.root, output);
    // Validate the actual source before trusting any paths supplied through inspection or plan.
    await readCodexSource(input.inspection.root);
    if (await digestSource(input.inspection.root) !== input.plan.sourceDigest) throw new Error("Source changed after conversion planning; inspect and plan again");
    const prepared = await prepare(input.inspection);
    if (digestValue(prepared.plan) !== digestValue(input.plan)) throw new Error("Conversion plan does not match the current source and converter; plan again");
    const missing = [...new Set(prepared.plan.items.flatMap(item => item.requiredApprovals ?? []))].filter(item => !input.approvals?.includes(item));
    if (missing.length) throw new Error(`Explicit conversion approval required: ${missing.join(", ")}`);
    const components: VykorPluginManifestV1["components"] = {};
    const skillFiles = prepared.plan.items.filter(item => item.sourceKind === "skills" && item.fidelity === "exact");
    if (skillFiles.length) components.skills = skillFiles.map(item => `./${item.sourcePath!}`);
    if (Object.keys(prepared.servers).length) components.mcpServers = ["./mcp/servers.json"];
    if (!Object.keys(components).length) throw new Error("Codex source contains no convertible components; see unsupported plan items");
    const manifest: VykorPluginManifestV1 = {
      schemaVersion: 1, ...input.inspection.identity,
      ...(prepared.source.description === undefined ? {} : { description: prepared.source.description }),
      ...(prepared.source.displayName === undefined ? {} : { displayName: prepared.source.displayName }),
      components, ...(Object.keys(prepared.permissions).length ? { permissions: prepared.permissions } : {}),
      metadata: { origin: "converted", sourceFormat: this.sourceFormat, converterId: this.id, converterVersion: this.version },
    };
    const report: ConversionReport = { schemaVersion: 1, status: input.plan.items.some(item => item.fidelity === "unsupported") ? "partial" : "success", items: input.plan.items, diagnostics: input.plan.diagnostics };
    const temporary = `${output}.tmp-${randomUUID()}`;
    const copied: string[] = [];
    try {
      await mkdir(temporary, { recursive: true });
      for (const path of prepared.source.files) {
        if (isSourceMetadata(path, prepared.source)) continue;
        if (components.mcpServers && path.toLowerCase() === "mcp/servers.json") throw new Error("Source resource conflicts with generated Native MCP path");
        const sourcePath = join(input.inspection.root, path);
        if (!(await lstat(sourcePath)).isFile()) throw new Error(`Source file changed during conversion: ${path}`);
        const target = join(temporary, path);
        await mkdir(dirname(target), { recursive: true });
        await copyFile(sourcePath, target);
        copied.push(path);
      }
      const writeJson = async (path: string, value: unknown) => {
        const target = join(temporary, path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, JSON.stringify(value, null, 2));
      };
      if (components.mcpServers) await writeJson("mcp/servers.json", { servers: prepared.servers });
      await writeJson(".vykor-plugin/plugin.json", manifest);
      await writeJson(".vykor-conversion/plan.json", input.plan);
      await writeJson(".vykor-conversion/report.json", report);
      await writeJson(".vykor-conversion/provenance.json", { sourceFormat: this.sourceFormat, sourceDigest: input.plan.sourceDigest, converterId: this.id, converterVersion: this.version, mappingVersion: MAPPING_VERSION });
      await readCodexSource(input.inspection.root);
      if (await digestSource(input.inspection.root) !== input.plan.sourceDigest) throw new Error("Source changed during conversion; inspect and plan again");
      for (const path of copied) {
        if (!(await readFile(join(temporary, path))).equals(await readFile(join(input.inspection.root, path)))) throw new Error(`Source changed while copying: ${path}`);
      }
      const validation = await validateNativePlugin(temporary);
      if (validation.status !== "valid") throw new Error(validation.diagnostics.map(item => item.message).join("; "));
      if (digestValue(requestedPluginPermissions(validation.plugin!.manifest)) !== digestValue(requestedPluginPermissions(manifest))) throw new Error("Converted permissions changed during validation");
      await checkOutput(input.inspection.root, output);
      await rename(temporary, output);
      return report;
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      throw error;
    }
  }
}
