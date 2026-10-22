export const RESERVED_SHELL_TOOL_NAMES = new Set(["Shell", "Bash"]);

export function canonicalToolName(name: string): string {
  return name.trim() === "Bash" ? "Shell" : name.trim();
}

export function canonicalToolNames(names: readonly string[]): string[] {
  return [...new Set(names.map(canonicalToolName).filter(Boolean))];
}

export function normalizeToolName(
  tool: string,
  knownToolNames: readonly string[] = [],
): string | undefined {
  const trimmed = canonicalToolName(tool);
  if (!trimmed) return undefined;
  if (trimmed === "*") return "*";

  const known = knownToolNames.find((name) => name === trimmed);
  if (known) return known;
  return trimmed;
}

export function normalizeToolNames(
  tools: readonly string[],
  knownToolNames: readonly string[] = [],
): string[] {
  const normalized = tools
    .map((tool) => normalizeToolName(tool, knownToolNames))
    .filter((tool): tool is string => tool !== undefined);
  return [...new Set(normalized)];
}

export function resolveAllowedToolNames(
  tools: readonly string[],
  knownToolNames: readonly string[] = [],
): string[] {
  const normalized = normalizeToolNames(tools, knownToolNames);
  return normalized.includes("*") ? [] : normalized;
}
