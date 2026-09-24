import { randomUUID } from "node:crypto";
import { access, cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { validateNativePlugin } from "@vykor/plugins";
import { digestSource, digestValue } from "../core/digest.js";
import type { ConversionItem, ConversionPlan, ConversionReport, PluginConverter, SourceInspection } from "../core/converter.js";
import { detectClaudeCodePlugin } from "./detector.js";
import { CLAUDE_HOOK_EVENT_MAP, CLAUDE_MAPPING_VERSION } from "./mappings.js";
import { inspectClaudeCodePlugin } from "./parser.js";
import { convertClaudeAgentMarkdown } from "./convert-agents.js";

const rel = (inspection: SourceInspection, path: string) => relative(inspection.root, path).replaceAll("\\", "/");

function componentPath(inspection: SourceInspection, sourcePath: string, directory: string): string {
  const parts = rel(inspection, sourcePath).split("/");
  const directoryIndex = parts.indexOf(directory);
  return (directoryIndex >= 0 ? parts.slice(directoryIndex + 1) : parts).join("/");
}

async function copySkillBundle(
  inspection: SourceInspection,
  skillFile: string,
  targetRoot: string,
): Promise<void> {
  const sourceDirectory = dirname(skillFile);
  const relativeDirectory = relative(inspection.root, sourceDirectory);
  const targetRelative = relativeDirectory === ""
    ? inspection.identity.name
    : dirname(componentPath(inspection, skillFile, "skills"));
  const targetDirectory = join(targetRoot, targetRelative === "." ? inspection.identity.name : targetRelative);
  if (sourceDirectory !== inspection.root) {
    await cp(sourceDirectory, targetDirectory, { recursive: true, errorOnExist: true, force: false });
    return;
  }
  await mkdir(targetDirectory, { recursive: true });
  await cp(skillFile, join(targetDirectory, "SKILL.md"), { errorOnExist: true, force: false });
  for (const resourceDirectory of ["assets", "references", "scripts"]) {
    const sourceResource = join(sourceDirectory, resourceDirectory);
    if (await access(sourceResource).then(() => true, () => false)) {
      await cp(sourceResource, join(targetDirectory, resourceDirectory), { recursive: true, errorOnExist: true, force: false });
    }
  }
}

async function convertHooks(source: string, target: string): Promise<boolean> {
  const raw = JSON.parse(await readFile(source, "utf8")) as Record<string, unknown>;
  const rows = (raw.hooks && typeof raw.hooks === "object" ? raw.hooks : raw) as Record<string, unknown>;
  const output: Record<string, unknown[]> = {};
  for (const [sourceEvent, entries] of Object.entries(rows)) {
    const event = CLAUDE_HOOK_EVENT_MAP[sourceEvent]; if (!event || !Array.isArray(entries)) continue;
    output[event] = [];
    for (const entry of entries) {
      const row = entry as Record<string, unknown>; const inner = Array.isArray(row.hooks) ? row.hooks : [row];
      for (const hook of inner) output[event]!.push({ ...(hook as object), ...(typeof row.matcher === "string" ? { matcher: row.matcher } : {}) });
    }
  }
  if (!Object.keys(output).length) return false;
  await mkdir(dirname(target), { recursive: true }); await writeFile(target, JSON.stringify(output, null, 2)); return true;
}
async function convertMcp(source: string, target: string): Promise<void> {
  const raw = JSON.parse(await readFile(source, "utf8")) as { mcpServers?: Record<string, Record<string, unknown>> };
  const servers: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(raw.mcpServers ?? {})) {
    if (typeof value.command === "string") servers[name] = { ...value, type: "stdio" };
    else if (typeof value.url === "string") servers[name] = { ...value, type: value.type === "sse" ? "sse" : "http" };
    else throw new Error(`Ambiguous MCP server: ${name}`);
  }
  await mkdir(dirname(target), { recursive: true }); await writeFile(target, JSON.stringify({ servers }, null, 2));
}

export class ClaudeCodePluginConverter implements PluginConverter {
  id = "claude-code"; version = "1.0.0"; sourceFormat = "claude-code";
  detect = detectClaudeCodePlugin;
  inspect = inspectClaudeCodePlugin;
  async plan(inspection: SourceInspection, options: Record<string, unknown> = {}): Promise<ConversionPlan> {
    const items: ConversionItem[] = [];
    for (const [kind, paths] of Object.entries(inspection.inventory)) {
      if (kind === "hooks") continue;
      for (const path of paths) items.push({
        id: `${kind}:${rel(inspection, path)}`, sourceKind: kind, sourcePath: rel(inspection, path),
        targetKind: kind === "commands" ? "skills" : kind,
        fidelity: kind === "commands" || kind === "agents" || kind === "mcpServers" ? "adapted" : "exact",
      });
    }
    for (const hookFile of inspection.inventory.hooks ?? []) {
      const raw = JSON.parse(await readFile(hookFile, "utf8")) as Record<string, unknown>;
      const rows = (raw.hooks && typeof raw.hooks === "object" ? raw.hooks : raw) as Record<string, unknown>;
      if (Object.keys(rows).some((event) => CLAUDE_HOOK_EVENT_MAP[event])) {
        items.push({
          id: `hooks:${rel(inspection, hookFile)}`, sourceKind: "hooks", sourcePath: rel(inspection, hookFile),
          targetKind: "hooks", fidelity: "adapted",
        });
      }
      for (const event of Object.keys(rows)) if (!CLAUDE_HOOK_EVENT_MAP[event]) items.push({
        id: `hooks:event:${event}`, sourceKind: "hooks", sourcePath: rel(inspection, hookFile),
        fidelity: "unsupported", reason: `Claude hook event ${event} has no Native v1 equivalent`,
      });
    }
    return { schemaVersion: 1, converterId: this.id, converterVersion: this.version, sourceFormat: this.sourceFormat,
      sourceDigest: await digestSource(inspection.root), optionsDigest: digestValue(options), mappingVersion: CLAUDE_MAPPING_VERSION,
      items: items.sort((a, b) => a.id.localeCompare(b.id)), diagnostics: [] };
  }
  async convert(input: { inspection: SourceInspection; plan: ConversionPlan; output: string; approvals?: string[] }): Promise<ConversionReport> {
    const blocked = input.plan.items.filter((item) => item.fidelity === "blocked" && !(item.requiredApprovals ?? []).every((x) => input.approvals?.includes(x)));
    if (blocked.length) throw new Error(`Blocked conversion items require approval: ${blocked.map((x) => x.id).join(", ")}`);
    if (await digestSource(input.inspection.root) !== input.plan.sourceDigest) throw new Error("Source changed after conversion planning; inspect and plan again");
    const output = resolve(input.output);
    if (await access(output).then(() => true, () => false)) throw new Error(`Conversion output already exists: ${output}`);
    const temporary = `${output}.tmp-${randomUUID()}`;
    await rm(temporary, { recursive: true, force: true });
    try {
      await mkdir(temporary, { recursive: true });
      const components: Record<string, string[]> = {};
      const skills = input.inspection.inventory.skills ?? [];
      for (const skill of skills) {
        await copySkillBundle(input.inspection, skill, join(temporary, "skills"));
      }
      const commands = input.inspection.inventory.commands ?? [];
      for (const command of commands) {
        const name = basename(command, ".md"); const target = join(temporary, "skills", name, "SKILL.md");
        await mkdir(dirname(target), { recursive: true }); await writeFile(target, await readFile(command, "utf8"));
      }
      if (skills.length || commands.length) components.skills = ["./skills"];
      const agents = input.inspection.inventory.agents ?? [];
      for (const agent of agents) {
        const target = join(temporary, "agents", componentPath(input.inspection, agent, "agents"));
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, convertClaudeAgentMarkdown(await readFile(agent, "utf8")));
      }
      if (agents.length) components.agents = ["./agents"];
      const hooks = input.inspection.inventory.hooks?.[0];
      if (hooks && await convertHooks(hooks, join(temporary, "hooks.json"))) components.hooks = ["./hooks.json"];
      const mcp = input.inspection.inventory.mcpServers?.[0];
      if (mcp) { await convertMcp(mcp, join(temporary, "mcp.json")); components.mcpServers = ["./mcp.json"]; }
      if (!Object.keys(components).length) throw new Error("Claude source contains no convertible components");
      const manifest = { schemaVersion: 1, id: input.inspection.identity.id, name: input.inspection.identity.name,
        version: input.inspection.identity.version,
        metadata: { origin: "converted", sourceFormat: this.sourceFormat, converterId: this.id, converterVersion: this.version },
        components };
      await mkdir(join(temporary, ".vykor-plugin"));
      await writeFile(join(temporary, ".vykor-plugin", "plugin.json"), JSON.stringify(manifest, null, 2));
      const report: ConversionReport = { schemaVersion: 1, status: input.plan.items.some((x) => x.fidelity === "unsupported") ? "partial" : "success", items: input.plan.items, diagnostics: input.plan.diagnostics };
      await mkdir(join(temporary, ".vykor-conversion"));
      await writeFile(join(temporary, ".vykor-conversion", "plan.json"), JSON.stringify(input.plan, null, 2));
      await writeFile(join(temporary, ".vykor-conversion", "report.json"), JSON.stringify(report, null, 2));
      await writeFile(join(temporary, ".vykor-conversion", "provenance.json"), JSON.stringify({ sourceFormat: this.sourceFormat, sourceDigest: input.plan.sourceDigest, converterId: this.id, converterVersion: this.version, mappingVersion: CLAUDE_MAPPING_VERSION }, null, 2));
      const validation = await validateNativePlugin(temporary); if (validation.status !== "valid") throw new Error(validation.diagnostics.map((x) => x.message).join("; "));
      await rename(temporary, output); return report;
    } catch (error) { await rm(temporary, { recursive: true, force: true }); throw error; }
  }
}
