/**
 * Server-owned command catalog metadata.
 *
 * Catalog is for discovery/autocomplete across clients. It is NOT a generic
 * slash-command executor — session mutations use resource APIs, templates
 * expand into normal session prompts.
 */

export type CommandKind = "session" | "template";
export type CommandSelection = "execute" | "submenu" | "insert";

export type CommandSource =
  | "builtin"
  | "bundled"
  | "user"
  | "plugin"
  | "project";

interface CommandCatalogEntryBase {
  /** Slash form, e.g. `/models` or `/commit`. */
  name: string;
  displayName?: string;
  description?: string;
  source?: CommandSource;
  argumentHint?: string;
  /** Selection behavior for clients that provide a native command adapter. */
  selection?: CommandSelection;
  /** State-changing commands may only be selected from an otherwise empty composer. */
  requiresEmptyComposer?: boolean;
}

export interface SessionCommandCatalogEntry extends CommandCatalogEntryBase {
  kind: "session";
  path?: never;
}

export interface TemplateCommandCatalogEntry extends CommandCatalogEntryBase {
  kind: "template";
  skillName: string;
  /** Absolute path of the current skill definition; empty for embedded bundled skills. */
  path: string;
}

export type CommandCatalogEntry = SessionCommandCatalogEntry | TemplateCommandCatalogEntry;

export interface ListCommandsInput {
  cwd: string;
}

export interface CommandCatalogProvider {
  list(input: ListCommandsInput): Promise<CommandCatalogEntry[]> | CommandCatalogEntry[];
}

/** Always-visible server/session commands (resource APIs, not REPL handlers). */
export const BUILTIN_SESSION_COMMANDS: readonly CommandCatalogEntry[] = [
  {
    name: "/skills",
    description: "List user-invocable skills / template commands",
    kind: "session",
    source: "builtin",
    selection: "execute",
    requiresEmptyComposer: true,
  },
  {
    name: "/config",
    description: "Show or edit daemon settings (show | set KEY VALUE)",
    kind: "session",
    source: "builtin",
    argumentHint: "[show|set KEY VALUE]",
  },
  {
    name: "/provider",
    description: "Show or switch API provider",
    kind: "session",
    source: "builtin",
    argumentHint: "[name|auto]",
  },
  {
    name: "/mcp",
    description: "Show MCP server connection status",
    kind: "session",
    source: "builtin",
  },
  {
    name: "/jobs",
    description: "List, inspect, or cancel Jobs (list | show ID | cancel ID)",
    kind: "session",
    source: "builtin",
    argumentHint: "[list|show ID|cancel ID]",
  },
  {
    name: "/background",
    description: "Start a background shell and return its Job ID",
    kind: "session",
    source: "builtin",
    argumentHint: "<command>",
  },
  {
    name: "/status",
    description: "Show current session status",
    kind: "session",
    source: "builtin",
    selection: "execute",
    requiresEmptyComposer: true,
  },
  {
    name: "/help",
    description: "List available slash commands",
    kind: "session",
    source: "builtin",
  },
  {
    name: "/version",
    description: "Show Vykor version",
    kind: "session",
    source: "builtin",
  },
  {
    name: "/memory",
    description: "Manage project memory (list | show ID | add CONTENT | remove ID)",
    kind: "session",
    source: "builtin",
    argumentHint: "[list|show ID|add CONTENT|remove ID]",
  },
  {
    name: "/auth",
    description: "Manage API credentials (status | login | logout)",
    kind: "session",
    source: "builtin",
    argumentHint: "[status|login <provider> <key>|logout <provider>]",
  },
  {
    name: "/context",
    description: "Show context preview, status table, or usage budget",
    kind: "session",
    argumentHint: "[preview|status|usage]",
    source: "builtin",
  },
  {
    name: "/stats",
    description: "Show session statistics",
    kind: "session",
    source: "builtin",
  },
  {
    name: "/agents",
    description: "Show Agent Jobs",
    kind: "session",
    source: "builtin",
  },
  {
    name: "/compact",
    description: "Summarize conversation to reduce context size",
    kind: "session",
    source: "builtin",
    selection: "execute",
    requiresEmptyComposer: true,
  },
  {
    name: "/goal",
    description: "Set a durable goal for this session",
    kind: "session",
    source: "builtin",
    selection: "execute",
    requiresEmptyComposer: true,
  },
  {
    name: "/remember",
    description: "Extract durable memories from this session",
    kind: "session",
    source: "builtin",
  },
  {
    name: "/dream",
    description: "Start memory consolidation (--preview for plan only)",
    kind: "session",
    source: "builtin",
    argumentHint: "[--preview]",
  },
  {
    name: "/profile",
    description: "Show or initialize SOUL.md / USER.md",
    kind: "session",
    source: "builtin",
    argumentHint: "[status|init]",
  },
  {
    name: "/doctor",
    description: "Run environment diagnostics",
    kind: "session",
    source: "builtin",
  },
  {
    name: "/effort",
    description: "Show or set reasoning effort (low | medium | high)",
    kind: "session",
    source: "builtin",
    argumentHint: "[low|medium|high]",
  },
  {
    name: "/reasoning",
    description: "Show or hide model reasoning in the transcript",
    kind: "session",
    source: "builtin",
    argumentHint: "[on|off]",
  },
  {
    name: "/fast",
    description: "Toggle fast mode (on | off | toggle)",
    kind: "session",
    source: "builtin",
    argumentHint: "[on|off|toggle]",
  },
  {
    name: "/turns",
    description: "Show or set max agentic turns (1-512)",
    kind: "session",
    source: "builtin",
    argumentHint: "[1-512]",
  },
  {
    name: "/usage",
    description: "Show token usage statistics",
    kind: "session",
    source: "builtin",
  },
  {
    name: "/cost",
    description: "Show estimated cost breakdown",
    kind: "session",
    source: "builtin",
  },
  {
    name: "/export",
    description: "Export conversation to Markdown or JSON",
    kind: "session",
    source: "builtin",
    argumentHint: "[filename] [--json]",
  },
  {
    name: "/output-style",
    description: "Show or set output style (show | list | NAME)",
    kind: "session",
    source: "builtin",
    argumentHint: "[show|list|NAME]",
  },
  {
    name: "/init",
    description: "Initialize Vykor project files",
    kind: "session",
    source: "builtin",
  },
  {
    name: "/plugin",
    description: "List or enable/disable plugins",
    kind: "session",
    source: "builtin",
    argumentHint: "[list|enable NAME|disable NAME]",
  },
  {
    name: "/hooks",
    description: "Show configured hooks",
    kind: "session",
    source: "builtin",
  },
  {
    name: "/subagents",
    description: "List available agent personas",
    kind: "session",
    source: "builtin",
  },
  {
    name: "/diff",
    description: "Show git diff (--stat or full)",
    kind: "session",
    source: "builtin",
    argumentHint: "[full]",
  },
  {
    name: "/branch",
    description: "Show current branch or list branches",
    kind: "session",
    source: "builtin",
    argumentHint: "[show|list]",
  },
  {
    name: "/rewind",
    description: "Remove the last N conversation turns (default 1)",
    kind: "session",
    source: "builtin",
    argumentHint: "[N]",
  },
  {
    name: "/commit",
    description: "Git status or stage-all + commit",
    kind: "session",
    source: "builtin",
    argumentHint: "[MSG]",
  },
  {
    name: "/reload-plugins",
    description: "Rediscover plugins and reload session runtimes",
    kind: "session",
    source: "builtin",
  },
];

export function normalizeCommandName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export function parseSlashLine(line: string): { name: string; args: string } | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("/")) return null;
  const spaceIdx = trimmed.search(/\s/);
  if (spaceIdx === -1) return { name: trimmed, args: "" };
  return {
    name: trimmed.slice(0, spaceIdx),
    args: trimmed.slice(spaceIdx + 1).trim(),
  };
}

export function mergeCommandCatalog(
  extras: readonly CommandCatalogEntry[] = [],
): CommandCatalogEntry[] {
  const byName = new Map<string, CommandCatalogEntry>();
  for (const entry of BUILTIN_SESSION_COMMANDS) {
    byName.set(entry.name, entry);
  }
  for (const entry of extras) {
    const name = normalizeCommandName(entry.name);
    if (!name || byName.has(name)) continue; // builtins win
    byName.set(name, { ...entry, name });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
