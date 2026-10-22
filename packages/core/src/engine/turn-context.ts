import type {
  Message,
  StreamMessageParams,
  ToolDefinition,
} from "@vykor/agent-contracts";

export interface TurnRequestInput {
  model: string;
  messages: readonly Message[];
  tools: readonly ToolDefinition[];
  system?: string;
  maxOutputTokens?: number;
  reasoningEffort?: string;
}

/** Freeze one request boundary; the Engine alone keeps the mutable history. */
export function createTurnRequest(
  input: TurnRequestInput,
): StreamMessageParams {
  const messages = Object.freeze([...input.messages]);
  const tools = Object.freeze([...input.tools]);
  return Object.freeze({
    model: input.model,
    messages,
    system: input.system,
    ...(tools.length ? { tools } : {}),
    ...(input.maxOutputTokens !== undefined
      ? { maxTokens: input.maxOutputTokens }
      : {}),
    ...(input.reasoningEffort
      ? { reasoningEffort: input.reasoningEffort }
      : {}),
  });
}

export function composeTurnPrompt(
  systemPrompt: string | undefined,
  memory: string | null,
): { systemPrompt: string | undefined; memoryReminderText?: string } {
  if (!memory?.trim()) return { systemPrompt };
  const memoryReminderText =
    "<system-reminder>\n" + memory.trim() + "\n</system-reminder>";
  return {
    systemPrompt: appendSystemGuidance(systemPrompt, memoryReminderText),
    memoryReminderText,
  };
}

export function appendSystemGuidance(
  systemPrompt: string | undefined,
  guidance: string,
): string {
  return systemPrompt?.trim() ? systemPrompt + "\n\n" + guidance : guidance;
}
