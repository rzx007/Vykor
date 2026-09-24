import type {
  ContextBucketId,
  ContextLedgerSegment,
  WorkStyle,
} from "@vykor/core";
import type { EffectiveEnvironmentInfo } from "@vykor/environment";
import { loadLocalRules } from "@vykor/personalization";
import type { PromptLayers, PromptPermissionMode } from "./index.js";
import {
  buildDelegationSection,
  buildMarkdownPresentationSection,
  buildPermissionModeSection,
  buildWorkStyleSection,
  formatEnvironmentSection,
  formatEffectiveEnvironmentSection,
  getDefaultIdentity,
  getEnvironmentInfo,
  loadClaudeMdPrompt,
  loadSoulMd,
  loadUserProfile,
  resolveInvariantGuidance,
} from "./index.js";

export type PromptLayerKind = keyof PromptLayers;

export interface TaggedPromptSegment {
  bucket: ContextBucketId;
  text: string;
  layer: PromptLayerKind;
}

export interface PromptSegmentsAssemblyOptions {
  customPrompt?: string;
  cwd?: string;
  permissionMode?: PromptPermissionMode;
  fastMode?: boolean;
  workStyle?: WorkStyle;
  effort?: string;
  passes?: number;
  includeDelegation?: boolean;
  includeBackgroundShell?: boolean;
  includeMarkdownPresentation?: boolean;
  skillsList?: Array<{ name: string; description: string }>;
  environmentInfo?: EffectiveEnvironmentInfo;
}

function pushSegment(
  segments: TaggedPromptSegment[],
  layer: PromptLayerKind,
  bucket: ContextBucketId,
  text: string,
): void {
  if (text.trim()) segments.push({ layer, bucket, text });
}

/**
 * Assemble prompt sections with an explicit bucket tag at each push site.
 * Does not include project-memory preview (memoryContent) — callers add that
 * separately when building model-visible layers.
 */
export async function buildTaggedPromptSegments(
  options: PromptSegmentsAssemblyOptions = {},
): Promise<TaggedPromptSegment[]> {
  const segments: TaggedPromptSegment[] = [];
  const promptCwd = options.cwd ?? process.cwd();
  const envSection = options.environmentInfo
    ? formatEffectiveEnvironmentSection(options.environmentInfo)
    : formatEnvironmentSection(await getEnvironmentInfo(promptCwd));

  pushSegment(
    segments,
    "stable",
    "system",
    (await loadSoulMd()) ?? getDefaultIdentity(),
  );
  pushSegment(
    segments,
    "stable",
    "system",
    resolveInvariantGuidance(options.includeBackgroundShell !== false),
  );
  if (options.includeMarkdownPresentation !== false) {
    pushSegment(
      segments,
      "stable",
      "system",
      buildMarkdownPresentationSection(),
    );
  }
  pushSegment(segments, "stable", "system", envSection);
  pushSegment(
    segments,
    "stable",
    "system",
    buildPermissionModeSection(options.permissionMode ?? "default"),
  );
  pushSegment(
    segments,
    "stable",
    "system",
    buildWorkStyleSection(options.workStyle ?? "practical"),
  );

  if (options.fastMode) {
    pushSegment(
      segments,
      "stable",
      "system",
      "# Session Mode\nFast mode is enabled. Prefer concise replies, minimal tool use, and quicker progress.",
    );
  }

  if (options.effort || options.passes) {
    const parts: string[] = ["# Reasoning Settings"];
    if (options.effort) parts.push(`- Effort: ${options.effort}`);
    if (options.passes) parts.push(`- Passes: ${options.passes}`);
    pushSegment(segments, "stable", "system", parts.join("\n"));
  }

  if (options.skillsList && options.skillsList.length > 0) {
    const lines = [
      "# Available Skills",
      "",
      "The following skills are available via the `skill` tool.",
      "",
    ];
    for (const skill of options.skillsList) {
      lines.push(`- **${skill.name}**: ${skill.description}`);
    }
    pushSegment(segments, "stable", "skills", lines.join("\n"));
  }

  if (options.includeDelegation !== false) {
    pushSegment(segments, "stable", "subagents", buildDelegationSection());
  }

  if (options.customPrompt?.trim()) {
    pushSegment(
      segments,
      "context",
      "rules",
      `# Custom Instructions\n\n${options.customPrompt.trim()}`,
    );
  }

  const claudeMd = await loadClaudeMdPrompt(promptCwd);
  if (claudeMd) pushSegment(segments, "context", "rules", claudeMd);

  const userProfile = await loadUserProfile();
  if (userProfile) pushSegment(segments, "volatile", "rules", userProfile);

  const localRules = loadLocalRules(promptCwd);
  if (localRules) pushSegment(segments, "volatile", "rules", localRules);

  return segments;
}

export function taggedSegmentsToLayers(
  segments: TaggedPromptSegment[],
): PromptLayers {
  const layers: PromptLayers = { stable: [], context: [], volatile: [] };
  for (const segment of segments) {
    layers[segment.layer].push(segment.text);
  }
  return layers;
}

export function taggedSegmentsToLedgerSegments(
  segments: TaggedPromptSegment[],
): ContextLedgerSegment[] {
  return segments.map(({ bucket, text }) => ({ bucket, text }));
}
