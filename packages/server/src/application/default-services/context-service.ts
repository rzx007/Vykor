import { access } from "node:fs/promises";
import { join } from "node:path";

import {
  assembleContextUsageSnapshot,
  createTip,
  formatContextUsageReport,
  getCredentialsFilePath,
  getConfigDir,
  type ContextUsageSnapshot,
} from "@vykor/core";
import {
  buildPromptLayers,
  buildPromptLedgerSegments,
  discoverClaudeMdFiles,
  inspectPersonalPromptFiles,
  listPendingUserProfileUpdates,
  renderPromptLayers,
  type PersonalPromptFileDiagnostic,
  type PromptLayers,
} from "@vykor/prompts";
import { getLocalRulesDir, hasFactSource, loadFacts } from "@vykor/personalization";
import { loadOutputStyles } from "@vykor/output-styles";
import { discoverVykorExtensions } from "@vykor/agent-runtime";

import type { ContextService, ModelProviderInfo } from "../settings-api.js";
import {
  ContextUsageCache,
  sharedContextUsageCache,
} from "../context-usage-cache.js";
import { getBoundContextUsageLiveAssembler } from "../context-usage-live-binder.js";
import { resolveModelContextLimits, type ModelContextLimits } from "../assemble-session-context-usage.js";
import { createDefaultModelService } from "./model-service.js";
import { openMemoryManager } from "./memory-service.js";
import { readCurrentSettings, type DaemonSettingsRef } from "./shared.js";

interface ContextStatusRow {
  source: string;
  status: string;
  written: string;
  injected: string;
  purpose: string;
}

export function createDefaultContextService(
  ref: DaemonSettingsRef,
  cache: ContextUsageCache = sharedContextUsageCache,
  options: {
    assembleLive?: (input: {
      sessionId: string;
      cwd: string;
      previousContextWindow?: number;
    }) => Promise<ContextUsageSnapshot | null>;
    listProviders?: () => Promise<ModelProviderInfo[]> | ModelProviderInfo[];
    resolveModelLimits?: (input: {
      model: string;
      providerHint?: string;
    }) => Promise<ModelContextLimits> | ModelContextLimits;
  } = {},
): ContextService {
  return {
    async plugins({ cwd }) {
      const settings = await readCurrentSettings(ref);
      const { pluginCapabilityInventory } = await discoverVykorExtensions(cwd, settings);
      return { plugins: [...pluginCapabilityInventory.plugins.values()].map((plugin) => ({
        pluginId: plugin.pluginId,
        displayName: plugin.displayName,
        version: plugin.version,
        scope: plugin.scope,
        origin: plugin.origin,
        description: plugin.description,
        capabilities: [
          ...(plugin.skillNames.length ? ["skills" as const] : []),
          ...(plugin.mcpServerIds.length || plugin.nativeToolEntries.length ? ["tools" as const] : []),
          ...(plugin.agentNames.length ? ["agents" as const] : []),
        ],
      })) };
    },
    async preview({ cwd }) {
      const settings = await readCurrentSettings(ref);
      const { manager } = await openMemoryManager(cwd);
      const memoryContent =
        settings.memory?.enabled !== false
          ? manager.buildMemoryPrompt(settings.memory?.maxFiles ?? 10)
          : undefined;
      const { skillRegistry } = await discoverVykorExtensions(cwd, settings);
      const layers = await buildPromptLayers({
        customPrompt: settings.systemPrompt,
        cwd,
        permissionMode: settings.permission.mode,
        workStyle: settings.workStyle,
        fastMode: settings.fastMode,
        effort: settings.effort,
        passes: settings.passes,
        memoryContent,
        skillsList: skillRegistry.modelVisibleList(),
      });
      const diagnostics = await inspectPersonalPromptFiles();
      return { report: formatPromptLayersReport(layers, 2_000, diagnostics) };
    },
    async status({ cwd }) {
      const settings = await readCurrentSettings(ref);
      const diagnostics = await inspectPersonalPromptFiles();
      const pendingUserUpdates = await listPendingUserProfileUpdates();
      const projectInstructionFiles = await discoverClaudeMdFiles(cwd);
      const { manager, directory: memoryDirectory } = await openMemoryManager(cwd);
      const memoryEntries = await manager.getAll();
      const { skillRegistry } = await discoverVykorExtensions(cwd, settings);
      const facts = loadFacts(cwd);
      const sourcedFacts = facts.facts.filter(hasFactSource).length;
      const unverifiedFacts = facts.facts.length - sourcedFacts;
      const legacyRulesExist = await pathExists(join(getConfigDir(), "local_rules", "rules.md"));
      const credentialsPath = getCredentialsFilePath();
      const credentialsConfigured = await pathExists(credentialsPath);
      const outputStyles = loadOutputStyles();

      const rows: ContextStatusRow[] = [
        {
          source: "SOUL.md",
          status: diagnosticStatus(diagnostics, "SOUL.md"),
          written: "/profile init or manual edit",
          injected: "system prompt stable identity",
          purpose: "agent identity and tone",
        },
        {
          source: "USER.md",
          status: diagnosticStatus(diagnostics, "USER.md"),
          written: "/profile init, manual edit, approved pending update",
          injected: "system prompt volatile User Profile",
          purpose: "user long-term preferences",
        },
        {
          source: "USER pending",
          status: `${pendingUserUpdates.length} pending`,
          written: "queueUserProfileUpdate()",
          injected: "not injected until approved",
          purpose: "review boundary for USER.md changes",
        },
        {
          source: "local_rules",
          status: `${sourcedFacts} sourced, ${unverifiedFacts} unverified${legacyRulesExist ? "; legacy global rules preserved" : ""}`,
          written: "/remember success best-effort",
          injected: "system prompt volatile local rules",
          purpose: "machine environment facts",
        },
        {
          source: "Project Instructions",
          status: `${projectInstructionFiles.length} file(s)`,
          written: "manual project files",
          injected: "system prompt context Project Instructions",
          purpose: "repo rules and workflows",
        },
        {
          source: "settings.systemPrompt",
          status: settings.systemPrompt?.trim() ? "set" : "empty",
          written: "/config, CLI args, session runtime metadata",
          injected: "system prompt context Custom Instructions",
          purpose: "extra user-configured instructions",
        },
        {
          source: "Environment",
          status: "dynamic",
          written: "computed per prompt build",
          injected: "system prompt stable Environment",
          purpose: "cwd, OS, git, shell facts",
        },
        {
          source: "Runtime modes",
          status: `permission=${settings.permission.mode}, fast=${settings.fastMode ? "on" : "off"}, effort=${settings.effort ?? "medium"}`,
          written: "settings or session runtime metadata",
          injected: "system prompt stable runtime sections",
          purpose: "execution policy and reasoning knobs",
        },
        {
          source: "Available Skills",
          status: `${skillRegistry.modelVisibleList().length} visible`,
          written: "skill/plugin discovery",
          injected: "system prompt stable Available Skills",
          purpose: "model-visible extension catalog",
        },
        {
          source: "Project Memory",
          status: `${memoryEntries.length} entr${memoryEntries.length === 1 ? "y" : "ies"}`,
          written: "/memory, /remember, auto extract",
          injected: "per-turn system-reminder; preview may show full prompt",
          purpose: "project durable semantic facts",
        },
        {
          source: "Session Memory",
          status: "per-session checkpoint",
          written: "after each successful turn",
          injected: "compact/autocompact summary prompt only",
          purpose: "conversation continuity after compact",
        },
        {
          source: "Session History",
          status: "daemon runtime store",
          written: "session events/messages/runs/tasks",
          injected: "/sessions, /resume, daemon recovery",
          purpose: "restore conversation state",
        },
        {
          source: "Output styles",
          status: `${outputStyles.length} style(s)`,
          written: "manual files",
          injected: "output style selection service",
          purpose: "presentation style",
        },
        {
          source: "Credentials",
          status: credentialsConfigured ? "configured" : "missing",
          written: "/auth login or provider setup",
          injected: "provider/auth resolution only",
          purpose: "API keys; never prompt context",
        },
      ];

      return {
        report: [
          "Context status:",
          `cwd: ${cwd}`,
          `config: ${getConfigDir()}`,
          `local_rules: ${getLocalRulesDir(cwd)}`,
          `project_memory: ${memoryDirectory}`,
          "",
          formatContextStatusTable(rows),
        ].join("\n"),
      };
    },
    async usage({ cwd, sessionId, refresh, previousContextWindow }) {
      if (sessionId && !refresh) {
        const cached = cache.get(sessionId);
        if (cached) {
          const snapshot: ContextUsageSnapshot = { ...cached, source: "session_cache" };
          return { snapshot, report: formatContextUsageReport(snapshot) };
        }
      }

      if (sessionId) {
        const assembleLive =
          options.assembleLive ?? getBoundContextUsageLiveAssembler();
        if (assembleLive) {
          const live = await assembleLive({
            sessionId,
            cwd,
            ...(previousContextWindow != null
              ? { previousContextWindow }
              : {}),
          });
          if (live) {
            return { snapshot: live, report: formatContextUsageReport(live) };
          }
        }
      }

      const settings = await readCurrentSettings(ref);
      const { skillRegistry } = await discoverVykorExtensions(cwd, settings);
      const limits = options.resolveModelLimits
        ? await options.resolveModelLimits({
            model: settings.model,
            providerHint: settings.provider,
          })
        : await resolveModelContextLimits({
            model: settings.model,
            providerHint: settings.provider,
            listProviders:
              options.listProviders ??
              (() => createDefaultModelService({ current: settings }).list()),
          });
      const segments = await buildPromptLedgerSegments({
        customPrompt: settings.systemPrompt,
        cwd,
        permissionMode: settings.permission.mode,
        workStyle: settings.workStyle,
        fastMode: settings.fastMode,
        effort: settings.effort,
        passes: settings.passes,
        skillsList: skillRegistry.modelVisibleList(),
      });
      const snapshot = assembleContextUsageSnapshot({
        segments,
        model: settings.model,
        contextWindow: limits.contextWindow,
        outputLimit: limits.outputLimit,
        source: "static_only",
        modelSwitch:
          previousContextWindow != null
            ? { previousContextWindow }
            : undefined,
        extraTips: [createTip("conversation_omitted")],
      });
      return { snapshot, report: formatContextUsageReport(snapshot) };
    },
  };
}

function formatPersonalPromptDiagnostics(diagnostics: PersonalPromptFileDiagnostic[]): string {
  const lines = ["Personal prompt files:"];
  for (const item of diagnostics) {
    const flags = [
      item.truncated ? "truncated" : "",
      item.issues.length > 0 ? `${item.issues.length} issue(s)` : "",
    ].filter(Boolean);
    lines.push(`- ${item.file}: ${item.status}${flags.length ? ` (${flags.join(", ")})` : ""}`);
    lines.push(`  path: ${item.path}`);
    if (item.message) lines.push(`  note: ${item.message}`);
    for (const issue of item.issues) {
      lines.push(`  ${issue.severity}: ${issue.code} - ${issue.message}`);
    }
  }
  return lines.join("\n");
}

function formatPromptLayersReport(
  layers: PromptLayers,
  previewChars: number,
  diagnostics: PersonalPromptFileDiagnostic[],
): string {
  const sectionPreviewChars = 350;
  const prompt = renderPromptLayers(layers);
  const preview = prompt.length > previewChars
    ? `${prompt.slice(0, previewChars)}\n... (truncated)`
    : prompt;
  const section = (name: keyof PromptLayers) => {
    const values = layers[name].filter((value) => value.trim());
    if (values.length === 0) return `[${name}]\n(empty)`;
    const previews = values.map((value, index) => {
      const trimmed = value.trim();
      const text = trimmed.length > sectionPreviewChars
        ? `${trimmed.slice(0, sectionPreviewChars)}\n... (truncated)`
        : trimmed;
      return `section ${index + 1}:\n${text}`;
    });
    return `[${name}]\n${previews.join("\n\n")}`;
  };
  const divider = "-".repeat(60);
  return [
    "Current system prompt layers:",
    `- stable: ${layers.stable.length} section(s), ${layerCharCount(layers.stable)} characters`,
    `- context: ${layers.context.length} section(s), ${layerCharCount(layers.context)} characters`,
    `- volatile: ${layers.volatile.length} section(s), ${layerCharCount(layers.volatile)} characters`,
    divider,
    section("stable"),
    divider,
    section("context"),
    divider,
    section("volatile"),
    divider,
    "Flat preview:",
    preview,
    ...(diagnostics.length > 0 ? [divider, formatPersonalPromptDiagnostics(diagnostics)] : []),
    divider,
    `Total length: ${prompt.length} characters`,
  ].join("\n");
}

function layerCharCount(parts: string[]): number {
  return parts.filter((part) => part.trim()).join("\n\n").length;
}

function formatContextStatusTable(rows: ContextStatusRow[]): string {
  const headers = ["Source", "Status", "Written", "Injected / read", "Purpose"];
  const body = rows.map((row) => [row.source, row.status, row.written, row.injected, row.purpose]);
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...body.map((row) => row[index]!.length)));
  const formatRow = (cells: string[]) =>
    `| ${cells.map((cell, index) => cell.padEnd(widths[index]!)).join(" | ")} |`;
  return [
    formatRow(headers),
    formatRow(widths.map((width) => "-".repeat(width))),
    ...body.map(formatRow),
  ].join("\n");
}

function diagnosticStatus(diagnostics: PersonalPromptFileDiagnostic[], file: "SOUL.md" | "USER.md"): string {
  const item = diagnostics.find((diagnostic) => diagnostic.file === file);
  if (!item) return "unknown";
  const flags = [
    item.truncated ? "truncated" : "",
    item.issues.length ? `${item.issues.length} issue(s)` : "",
  ].filter(Boolean);
  return flags.length ? `${item.status} (${flags.join(", ")})` : item.status;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
