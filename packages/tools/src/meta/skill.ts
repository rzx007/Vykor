import type { ToolDefinition } from "@vykor/agent-contracts";
import type { SkillCatalogSnapshot, SkillCatalogPort, ToolSkillDefinition as SkillDefinition } from "../ports/skill.js";
import { posix, win32, resolve } from "node:path";

type SkillVisibility = "model" | "user" | "all";

const WINDOWS_HOST_PATH = /^(?:[a-zA-Z]:[\\/]|\\\\)/;

export function hostPathDirectory(path: string): string {
  return WINDOWS_HOST_PATH.test(path) ? win32.dirname(path) : posix.dirname(path);
}

export function createSkillTools(catalog?: SkillCatalogPort): ToolDefinition[] {
  const skillTool: ToolDefinition = {
    name: "Skill",
    description:
      "Read a bundled, user, or plugin skill by name. Returns the skill's full Markdown content.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill name" },
        path: {
          type: "string",
          description: "Optional catalog path. When supplied, it must identify the current skill winner.",
        },
      },
      required: ["name"],
    },
    async execute(input, context) {
      if (!catalog) return { content: [{ type: "text", text: "Skills are not available in this host." }], isError: true };
      const name = input.name as string;
      const requestedPath = typeof input.path === "string"
        ? context.environment?.paths?.toHostPath?.(input.path) ?? input.path
        : input.path;

      const registry = await catalog.resolve(context);

      const resolvedByName = registry.resolve(name);
      const skill = typeof requestedPath === "string"
        ? registry.resolvePath(requestedPath)
        : resolvedByName;
      if (!skill || (typeof requestedPath === "string" && skill !== resolvedByName)) {
        return {
          content: [{ type: "text", text: `Skill not found: ${name}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: formatLoadedSkill(skill, context) }],
      };
    },
  };

  const listSkillsTool: ToolDefinition = {
    name: "ListSkills",
    description:
      "List bundled, user, project, or plugin skills available in this runtime. Returns names, descriptions, sources, and slash command names, not full skill contents.",
    inputSchema: {
      type: "object",
      properties: {
        visibility: {
          type: "string",
          enum: ["model", "user", "all"],
          description:
            "Which skills to list. 'model' lists skills visible to the model, 'user' lists slash-command skills, and 'all' lists every loaded skill.",
        },
        ownerPluginId: { type: "string", description: "List only Skills owned by this stable plugin ID." },
        pluginId: { type: "string", description: "Alias for ownerPluginId." },
        offset: { type: "integer", minimum: 0, description: "Zero-based offset after visibility and owner filters; default 0." },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Page size; default 50, maximum 100." },
      },
    },
    async execute(input, context) {
      if (!catalog) return { content: [{ type: "text", text: "Skills are not available in this host." }], isError: true };
      const visibility = parseVisibility(input.visibility);
      const ownerPluginId = input.ownerPluginId ?? input.pluginId;
      if ([input.ownerPluginId, input.pluginId].some(value => value !== undefined && (typeof value !== "string" || !value.trim()))
        || (input.ownerPluginId !== undefined && input.pluginId !== undefined && input.ownerPluginId !== input.pluginId)
        || (input.offset !== undefined && (!Number.isSafeInteger(input.offset) || (input.offset as number) < 0))
        || (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || (input.limit as number) < 1))) {
        return { content: [{ type: "text", text: "Invalid ListSkills filter or pagination: use one matching plugin ID, offset >= 0 and limit >= 1." }], isError: true };
      }
      const offset = (input.offset as number | undefined) ?? 0;
      const limit = Math.min((input.limit as number | undefined) ?? 50, 100);
      const definitions = await catalog.resolve(context);
      const skills = filterSkills(definitions.getAll(), visibility).filter(skill =>
        ownerPluginId === undefined || skillOwner(skill, context) === ownerPluginId);

      if (skills.length === 0) {
        return {
          content: [{ type: "text", text: `No ${visibility} skills available.` }],
        };
      }
      const page = skills.slice(offset, offset + limit);
      if (!page.length) return { content: [{ type: "text", text: `No ${visibility} skills on this page (offset=${offset}, total=${skills.length}).` }] };
      const nextOffset = offset + page.length;
      const nextInput = { visibility, ...(ownerPluginId !== undefined ? { ownerPluginId } : {}), offset: nextOffset, limit };

      return {
        content: [
          {
            type: "text",
            text: [formatSkillList(page, visibility, context),
              `Showing ${offset + 1}-${nextOffset} of ${skills.length} skills (offset=${offset}, limit=${limit}).`,
              ...(nextOffset < skills.length ? [`More skills available. Call ListSkills with ${JSON.stringify(nextInput)}.`] : []),
            ].join("\n"),
          },
        ],
      };
    },
  };

  return [skillTool, listSkillsTool];
}

/** The Node host supplies only this Run's frozen, already authorized definitions. */
export function createCapturedSkillCatalog(definitions: readonly SkillDefinition[]): SkillCatalogPort {
  const snapshot = skillCatalogSnapshot(definitions);
  return { async resolve() { return snapshot; } };
}
export function skillCatalogSnapshot(definitions: readonly SkillDefinition[]): SkillCatalogSnapshot {
  const skills = [...definitions].sort((a, b) => a.name.localeCompare(b.name));
  const pathKey = (value: string) => process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value);
  return {
    getAll: () => skills,
    resolve(name) {
      const trimmed = name.trim();
      if (!trimmed) return undefined;
      return skills.find(skill => skill.source === "plugin" && skill.commandName === trimmed)
        ?? skills.find(skill => skill.name === trimmed)
        ?? skills.find(skill => skill.name === trimmed.toLowerCase())
        ?? skills.find(skill => skill.name === trimmed.charAt(0).toUpperCase() + trimmed.slice(1))
        ?? skills.find(skill => skill.commandName === trimmed);
    },
    resolvePath(path) { return path.trim() ? skills.find(skill => skill.path && pathKey(skill.path) === pathKey(path)) : undefined; },
  };
}

function parseVisibility(value: unknown): SkillVisibility {
  return value === "user" || value === "all" ? value : "model";
}

function filterSkills(
  skills: readonly SkillDefinition[],
  visibility: SkillVisibility,
): readonly SkillDefinition[] {
  if (visibility === "all") return skills;
  if (visibility === "user") return skills.filter((skill) => skill.userInvocable);
  return skills.filter((skill) => skill.disableModelInvocation !== true);
}

function skillOwner(skill: SkillDefinition, context: Parameters<ToolDefinition["execute"]>[1]): string | undefined {
  return skill.ownerPluginId ?? (skill.source === "plugin" && typeof skill.metadata?.pluginId === "string" ? skill.metadata.pluginId : undefined);
}

function catalogText(value: string): string {
  return JSON.stringify(value).slice(1, -1).replace(/[<>&]/g, character =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function formatSkillList(skills: readonly SkillDefinition[], visibility: SkillVisibility, context: Parameters<ToolDefinition["execute"]>[1]): string {
  const title =
    visibility === "model"
      ? "Model-visible skills"
      : visibility === "user"
        ? "User-invocable skills"
        : "All loaded skills";
  return [
    `${title}:`,
    ...skills.map((skill) => {
      const command = skill.commandName ?? skill.name;
      const owner = skillOwner(skill, context);
      const path = skill.path ? context.environment?.paths?.presentHostPath(skill.path) ?? skill.path : "(embedded)";
      const metadata = [
        skill.source ? `source=${skill.source}` : null,
        owner ? `ownerPluginId="${catalogText(owner)}"` : null,
        `path="${catalogText(path)}"`,
        skill.userInvocable ? `command=/${catalogText(command)}` : null,
        skill.disableModelInvocation ? "model=hidden" : null,
      ].filter(Boolean);
      return `- ${catalogText(skill.name)}${skill.description ? ` — ${catalogText(skill.description.length > 300 ? `${skill.description.slice(0, 299)}…` : skill.description)}` : ""}${
        metadata.length ? ` (${metadata.join(", ")})` : ""
      }`;
    }),
  ].join("\n");
}

function formatLoadedSkill(
  skill: SkillDefinition,
  context: Parameters<ToolDefinition["execute"]>[1],
): string {
  const embedded = !skill.path;
  const skillFile = embedded
    ? "(embedded)"
    : context.environment?.paths.presentHostPath(skill.path) ??
      (context.environment ? "(unavailable in this environment)" : skill.path);
  const skillRoot = embedded
    ? "(embedded)"
    : context.environment?.paths.presentHostPath(hostPathDirectory(skill.path)) ??
      (context.environment ? "(unavailable in this environment)" : hostPathDirectory(skill.path));
  const unavailable = !embedded && context.environment &&
    (skillFile.startsWith("(unavailable") || skillRoot.startsWith("(unavailable"));
  return [
    `Skill: ${skill.name}`,
    `Skill file: ${skillFile}`,
    `Skill root: ${skillRoot}`,
    "",
    "Resolve relative paths mentioned by this skill against Skill root.",
    ...(unavailable
      ? ["This Skill's supporting files are not mounted in the execution environment."]
      : []),
    "",
    "<skill-content>",
    skill.content,
    "</skill-content>",
    ...skillShellReminder(context),
  ].join("\n");
}

function skillShellReminder(
  context: Parameters<ToolDefinition["execute"]>[1],
): string[] {
  const shell = context.environment?.info?.shellDescriptor;
  if (!shell) return [];
  const lines = [
    "",
    "<execution-environment-reminder>",
    `Current execution shell: ${shell.displayName} (${shell.dialect}).`,
    `Current path style: ${shell.pathStyle}; temporary directory: ${shell.tempDir}.`,
    "Shell-specific examples must be translated to the current execution shell; preserve their intent instead of copying incompatible syntax.",
  ];
  if (shell.dialect === "windows-powershell") {
    lines.push(
      "Windows PowerShell 5.1: use Get-Content -Raw -Encoding UTF8 -LiteralPath for UTF-8 JSON; ConvertFrom-Json has no -Depth parameter; Bash heredoc syntax is invalid.",
    );
  } else if (shell.dialect === "pwsh") {
    lines.push("PowerShell: prefer native object pipelines and do not use Bash heredoc syntax.");
  }
  lines.push("</execution-environment-reminder>");
  return lines;
}
