import type { ToolDefinition } from "@openharness/core";
import { SkillRegistry, type SkillDefinition } from "@openharness/skills";
import { posix, win32 } from "node:path";

type SkillRegistryInstance = InstanceType<typeof SkillRegistry>;
type SkillVisibility = "model" | "user" | "all";

const WINDOWS_HOST_PATH = /^(?:[a-zA-Z]:[\\/]|\\\\)/;

export function hostPathDirectory(path: string): string {
  return WINDOWS_HOST_PATH.test(path) ? win32.dirname(path) : posix.dirname(path);
}

export const skillTool: ToolDefinition = {
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
    const name = input.name as string;
    const requestedPath = input.path;

    const registry = await resolveSkillRegistry(context, { refreshFilesystem: true });

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

export const listSkillsTool: ToolDefinition = {
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
    },
  },
  async execute(input, context) {
    const visibility = parseVisibility(input.visibility);
    const registry = await resolveSkillRegistry(context, { refreshFilesystem: true });
    const skills = filterSkills(registry.getAll(), visibility);

    if (skills.length === 0) {
      return {
        content: [{ type: "text", text: `No ${visibility} skills available.` }],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: formatSkillList(skills, visibility),
        },
      ],
    };
  },
};

async function resolveSkillRegistry(
  context: Parameters<ToolDefinition["execute"]>[1],
  options: { refreshFilesystem?: boolean } = {},
) {
  if (context.capabilityView) {
    const registry = new SkillRegistry();
    for (const [name, binding] of context.capabilityView.skills) {
      if (binding.definition.name !== name || binding.path !== binding.definition.path) continue;
      if (binding.ownerPluginId !== undefined && binding.ownerPluginId !== context.capabilityView.pluginId) continue;
      if (binding.definition.source === "plugin" && !binding.ownerPluginId) continue;
      registry.register(binding.definition);
    }
    return registry;
  }
  const sharedRegistry = context.skillRegistry as SkillRegistryInstance | undefined;
  if (sharedRegistry && !options.refreshFilesystem) return sharedRegistry;

  const { createSkillRegistrySnapshot, findProjectSkillDirs, standardUserSkillDirs } = await import("@openharness/skills");
  const { getSkillsDir } = await import("@openharness/core");
  const baseline = sharedRegistry?.getAll().filter((skill) =>
    skill.source === "plugin" || !skill.path
  ) ?? [];
  return createSkillRegistrySnapshot({
    baseline,
    userDirs: standardUserSkillDirs(),
    userDir: getSkillsDir(),
    projectDirs: await findProjectSkillDirs(
      context.environment?.workspace?.hostRoot ?? context.cwd,
    ),
  });
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

function formatSkillList(skills: readonly SkillDefinition[], visibility: SkillVisibility): string {
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
      const metadata = [
        skill.source ? `source=${skill.source}` : null,
        skill.userInvocable ? `command=/${command}` : null,
        skill.disableModelInvocation ? "model=hidden" : null,
      ].filter(Boolean);
      return `- ${skill.name}${skill.description ? ` — ${skill.description}` : ""}${
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
