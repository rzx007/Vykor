import type { ContextLedgerSegment } from "@vykor/core";
import type { WorkStyle } from "@vykor/core";
import type { PromptPermissionMode } from "./index.js";
import {
  buildTaggedPromptSegments,
  taggedSegmentsToLedgerSegments,
} from "./prompt-segments-assembly.js";

export interface BuildPromptLedgerSegmentsOptions {
  customPrompt?: string;
  cwd?: string;
  permissionMode?: PromptPermissionMode;
  fastMode?: boolean;
  workStyle?: WorkStyle;
  effort?: string;
  passes?: number;
  /** Full project memory preview — excluded from ledger segments by design. */
  memoryContent?: string;
  /** Optional per-turn memory reminder counted toward conversation bucket. */
  memoryReminderText?: string;
  includeDelegation?: boolean;
  includeBackgroundShell?: boolean;
  skillsList?: Array<{ name: string; description: string }>;
}

/** Build tagged ledger segments for context-usage estimation. */
export async function buildPromptLedgerSegments(
  options: BuildPromptLedgerSegmentsOptions = {},
): Promise<ContextLedgerSegment[]> {
  const { memoryContent: _memoryContent, memoryReminderText, ...assemblyOptions } = options;

  const segments = await buildTaggedPromptSegments(assemblyOptions);
  const ledger = taggedSegmentsToLedgerSegments(segments);

  const reminder = memoryReminderText?.trim();
  if (reminder) {
    ledger.push({ bucket: "conversation", text: reminder });
  }

  return ledger;
}
