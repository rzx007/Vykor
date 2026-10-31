import type { ContentBlock, Message, ToolUseBlock } from "@vykor/agent-contracts";
import { toolFeedbackFields, toolResultReferenceHint } from "../tools/tool-result-feedback";
import { isTextBlock, toolFactsText } from "./compact-messages";

const MESSAGE_LIMIT = 4000;
// Reserve the truncation label plus usable text from both ends of long inputs.
const MIN_PAYLOAD_BUDGET = 128;
const FACT_OMISSION_RESERVE = 100;

interface CallRecord {
  call: ToolUseBlock;
  position: number;
  count: number;
}

/** Text only: never read media sources or expand retained-result references. */
function contentText(content: string | ContentBlock[]): string {
  return typeof content === "string" ? content : content.map(block =>
    isTextBlock(block) ? block.text : "[Image omitted from compaction summarization.]",
  ).join("\n");
}

/** Clipped arguments are explicitly excerpts, never a complete executable JSON input. */
function clip(text: string, budget: number, input = false): string {
  if (text.length <= budget) return text;
  const prefix = input ? "[truncated JSON input; not a complete invocation] " : "";
  const middle = " ... [omitted] ... ";
  const available = budget - prefix.length - middle.length;
  if (available < 2) return (input ? "[input omitted]" : "[text omitted]").slice(0, budget);
  let head = Math.ceil(available / 2);
  let tail = text.length - Math.floor(available / 2);
  // Keep UTF-16 surrogate pairs intact at both excerpt boundaries.
  if (text.charCodeAt(head - 1) >= 0xd800 && text.charCodeAt(head - 1) <= 0xdbff) head--;
  if (text.charCodeAt(tail) >= 0xdc00 && text.charCodeAt(tail) <= 0xdfff) tail++;
  return prefix + text.slice(0, head) + middle + text.slice(tail);
}

/** Fit short values first, then share the remaining budget between long payloads. */
function payloadBudgets(texts: string[], budget: number): number[] {
  const sizes = texts.map(() => 0);
  const order = texts.map((_, index) => index).sort((a, b) => texts[a]!.length - texts[b]!.length);
  for (const [position, index] of order.entries()) {
    sizes[index] = Math.min(texts[index]!.length, Math.floor(budget / (order.length - position)));
    budget -= sizes[index]!;
  }
  return sizes;
}

function assistantText(message: Extract<Message, { type: "assistant" }>): string {
  const prefix = "Assistant: ";
  const calls = message.toolUses ?? [];
  const reserve = calls.length ? `\n[Tool calls omitted: ${calls.length}; summary budget]`.length : 0;
  let remaining = MESSAGE_LIMIT - prefix.length - reserve - Math.min(message.content.length, MIN_PAYLOAD_BUDGET);
  const kept: Array<{ header: string; input?: string }> = [];
  for (const call of calls) {
    const identity = `ToolCall: id=${JSON.stringify(call.id)}; name=${JSON.stringify(call.name)}`;
    const entry = call.inputError
      ? { header: `${identity}; inputError=${JSON.stringify(call.inputError)}` }
      : { header: `${identity}; input=`, input: JSON.stringify(call.input) ?? "[input unavailable]" };
    const cost = 1 + entry.header.length + Math.min(entry.input?.length ?? 0, MIN_PAYLOAD_BUDGET);
    if (cost > remaining) continue;
    kept.push(entry);
    remaining -= cost;
  }
  const omitted = calls.length - kept.length;
  const notice = omitted ? `\n[Tool calls omitted: ${omitted}; summary budget]` : "";
  const headerCost = prefix.length + notice.length + kept.reduce((sum, entry) => sum + 1 + entry.header.length, 0);
  const payloads = [message.content, ...kept.flatMap(entry => entry.input === undefined ? [] : [entry.input])];
  const budgets = payloadBudgets(payloads, MESSAGE_LIMIT - headerCost);
  let payloadIndex = 1;
  const lines = kept.map(entry => entry.header + (entry.input === undefined ? "" : clip(entry.input, budgets[payloadIndex++]!, true)));
  return prefix + clip(message.content, budgets[0]!) + lines.map(line => `\n${line}`).join("") + notice;
}

function resultText(
  message: Extract<Message, { type: "tool_result" }>,
  position: number,
  calls: ReadonlyMap<string, CallRecord>,
  results: ReadonlyMap<string, number>,
): string {
  const call = calls.get(message.toolUseId);
  const ambiguous = (call?.count ?? 0) > 1 || (results.get(message.toolUseId) ?? 0) > 1;
  const paired = !ambiguous && call !== undefined && call.position < position;
  const match = ambiguous ? "ambiguous" : paired ? "paired" : "unmatched";
  const fields = toolFeedbackFields(message);
  let header = `ToolResult: id=${JSON.stringify(message.toolUseId)}`
    + (paired ? `; name=${JSON.stringify(call.call.name)}` : "") + `; match=${match}`;
  if (fields.executionState !== undefined) header += `; executionState=${JSON.stringify(fields.executionState)}`;
  if (message.isError !== undefined) header += `; isError=${JSON.stringify(message.isError)}`;
  if (fields.failureKind !== undefined) header += `; failureKind=${JSON.stringify(fields.failureKind)}`;
  if (header.length > MESSAGE_LIMIT - FACT_OMISSION_RESERVE) {
    return "ToolResult: [Tool result omitted: identity/state exceeds summary budget]";
  }

  const facts = toolFactsText(message);
  const metadata: Array<{ name: string; text: string }> = [];
  let referenceHint: string | undefined;
  if (message.resultRef) {
    const { id, toolName, totalChars } = message.resultRef;
    metadata.push({ name: "resultRef", text: `resultRef=${JSON.stringify({ id, toolName, totalChars })}` });
    const hint = toolResultReferenceHint(message.resultRef);
    if (isTextBlock(hint)) referenceHint = hint.text;
  }
  if (facts) metadata.push({ name: "compactSummary", text: facts });
  if (fields.recoveryHint) metadata.push({ name: "recoveryHint", text: `recoveryHint=${JSON.stringify(fields.recoveryHint)}` });
  let text = header;
  const omitted: string[] = [];
  for (const field of metadata) {
    if (text.length + 1 + field.text.length <= MESSAGE_LIMIT - FACT_OMISSION_RESERVE) text += `\n${field.text}`;
    else omitted.push(field.name);
  }
  if (omitted.length) text += `\n[Tool facts omitted: ${omitted.join(", ")}; summary budget]`;
  const body = contentText(message.content.filter(block => !isTextBlock(block) || block.text !== facts && block.text !== referenceHint));
  if (body) text += `\n${clip(body, MESSAGE_LIMIT - text.length - 1)}`;
  return text;
}

/** Preserve source order and unambiguous identities within each bounded source message. */
export function buildCompactTranscript(messages: readonly Message[]): string {
  const calls = new Map<string, CallRecord>();
  const results = new Map<string, number>();
  for (const [position, message] of messages.entries()) {
    if (message.type === "assistant") for (const call of message.toolUses ?? []) {
      const previous = calls.get(call.id);
      calls.set(call.id, { call, position, count: (previous?.count ?? 0) + 1 });
    }
    else if (message.type === "tool_result") results.set(message.toolUseId, (results.get(message.toolUseId) ?? 0) + 1);
  }
  return messages.map((message, position) => {
    if (message.type === "assistant") return assistantText(message);
    if (message.type === "tool_result") return resultText(message, position, calls, results);
    const prefix = message.type === "user" ? "User: " : "System: ";
    return prefix + clip(contentText(message.content), MESSAGE_LIMIT - prefix.length);
  }).join("\n\n");
}
