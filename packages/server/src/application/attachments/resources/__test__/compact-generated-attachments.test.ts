import type { Message } from "@vykor/agent-contracts";
import type { SessionMessagePartRecord } from "@vykor/domain-contracts/sessions";
import type { ReplaceTranscriptMessageInput } from "@vykor/services";
import { CompactService } from "@vykor/core";
import { describe, expect, it } from "vitest";

import { preserveCompactedAttachments } from "../compact-generated-attachments.js";

const sessionId = "session";
const resource = "attachment://generated/screen.png";
const parts: SessionMessagePartRecord[] = [
  { id: "generation", sessionId, messageId: "original", seq: 1, type: "tool", status: "completed", toolName: "ImageGeneration", toolUseId: "generated-call", input: { prompt: "PRIVATE_PROMPT" }, output: { content: [{ type: "text", text: "PRIVATE_PROVIDER_OUTPUT" }] }, isError: false, metadata: {}, createdAt: 1, updatedAt: 1 },
  { id: "image", sessionId, messageId: "original", seq: 2, type: "attachment", status: "completed", assetId: "generated", intent: "tool_resource", displayName: "screen.png", mediaType: "image/png", sizeBytes: 42, metadata: { source: "image_generation", toolUseId: "generated-call" }, createdAt: 1, updatedAt: 1 },
];
function summaryHistory(): Message[] {
  return [
    { type: "assistant", content: "A compact summary", compactRole: "summary" },
    { type: "user", content: "[Compact boundary marker]", compactRole: "boundary" },
  ];
}
function persistedParts(messages: ReplaceTranscriptMessageInput[]): SessionMessagePartRecord[] {
  let seq = 0;
  return messages.flatMap((message, messageIndex) => message.parts.map(part => ({
    ...part, id: `part-${++seq}`, sessionId, messageId: `message-${messageIndex}`, seq,
    status: part.status ?? "completed", metadata: part.metadata ?? {}, createdAt: 2, updatedAt: 2,
  })));
}

describe("generated attachments through manual compaction", () => {
  it("archives summarized image ownership before the boundary without replaying generation", () => {
    const original = summaryHistory();
    const result = preserveCompactedAttachments({ sessionId, history: original, parts });
    const carrierIndex = result.messages.findIndex(message => message.role === "system" && message.parts.some(part => part.type === "attachment"));
    const boundaryIndex = result.messages.findIndex(message => message.parts.some(part => part.metadata?.compactRole === "boundary"));
    expect(carrierIndex).toBeGreaterThanOrEqual(0);
    expect(carrierIndex).toBeLessThan(boundaryIndex);
    expect(result.messages[carrierIndex]!.parts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "tool", toolName: "ImageGeneration", toolUseId: "generated-call", status: "completed", isError: false }),
      expect.objectContaining({ type: "attachment", assetId: "generated", metadata: { source: "image_generation", toolUseId: "generated-call" } }),
    ]));
    expect(JSON.stringify(result.history)).toContain(resource);
    expect(result.history.some(message => message.type === "assistant" && message.toolUses?.length)).toBe(false);
    expect(original).toEqual(summaryHistory());
  });

  it("keeps retained image ownership with its actual generation message", () => {
    const history: Message[] = [...summaryHistory(),
      { type: "assistant", content: "", toolUses: [{ type: "tool_use", id: "generated-call", name: "ImageGeneration", input: { prompt: "recent prompt" } }] },
      { type: "tool_result", toolUseId: "generated-call", content: [{ type: "text", text: "Generated" }], isError: false },
    ];
    const result = preserveCompactedAttachments({ sessionId, history, parts });
    const generation = result.messages.find(message => message.parts.some(part => part.toolUseId === "generated-call"));
    expect(generation?.parts).toContainEqual(expect.objectContaining({ type: "attachment", assetId: "generated" }));
    const completion = result.messages.at(-1)!;
    expect(completion.metadata?.presentation).toEqual({ kind: "context_compaction", phase: "completed" });
    expect(completion.parts.some(part => part.type === "attachment" || part.type === "tool")).toBe(false);
  });

  it("does not grow the resource footer or duplicate archived proofs when compacting again", () => {
    const first = preserveCompactedAttachments({ sessionId, history: summaryHistory(), parts });
    const second = preserveCompactedAttachments({ sessionId, history: first.history, parts: persistedParts(first.messages) });
    expect(second.history).toEqual(first.history);
    expect(second.messages.flatMap(message => message.parts).filter(part => part.type === "attachment")).toHaveLength(1);
    expect(second.messages.flatMap(message => message.parts).filter(part => part.type === "tool")).toHaveLength(1);
  });

  it("archives ambiguous reused call IDs instead of attaching an image to the wrong retained message", () => {
    const reused = [...parts, ...parts.map(part => ({
      ...part, id: `${part.id}-second`, messageId: "second-original", seq: part.seq + 2,
      ...(part.type === "attachment" ? { assetId: "generated-second" } : {}),
    }))];
    const history: Message[] = [...summaryHistory(),
      { type: "assistant", content: "", toolUses: [{ type: "tool_use", id: "generated-call", name: "ImageGeneration", input: {} }] },
      { type: "tool_result", toolUseId: "generated-call", content: [{ type: "text", text: "Generated" }], isError: false },
    ];
    const result = preserveCompactedAttachments({ sessionId, history, parts: reused });
    const retained = result.messages.find(message => message.role === "assistant" && message.parts.some(part => part.toolUseId === "generated-call"))!;
    expect(retained.parts.some(part => part.type === "attachment")).toBe(false);
    const carrier = result.messages.find(message => message.role === "system" && message.parts.some(part => part.type === "attachment"))!;
    expect(carrier.parts.filter(part => part.type === "attachment")).toHaveLength(2);
  });

  it("cleans an older resource footer when real full compaction retains the old boundary in recent history", async () => {
    const first = preserveCompactedAttachments({ sessionId, history: summaryHistory(), parts });
    const compact = new CompactService(1, 4, { client: { async *submitMessage() {
      yield { type: "text_delta", delta: "<summary>Current task remains active.</summary>" };
      yield { type: "complete", stopReason: "end_turn" };
    } } });
    const secondHistory = await compact.autoCompact([
      { type: "user", content: "Older request" }, { type: "assistant", content: "Older answer" },
      ...first.history,
      { type: "user", content: "Continue" }, { type: "assistant", content: "Continued" },
    ], "manual");
    expect(secondHistory.filter(message => message.type === "user" && message.compactRole === "boundary")).toHaveLength(2);
    const second = preserveCompactedAttachments({ sessionId, history: secondHistory, parts: persistedParts(first.messages) });
    const boundaries = second.history.filter(message => message.type === "user" && message.compactRole === "boundary");
    expect(JSON.stringify(boundaries[0])).toContain(resource);
    expect(JSON.stringify(boundaries[1])).not.toContain(resource);
    expect(JSON.stringify(boundaries).match(/Host generated attachment resources/g)).toHaveLength(1);
  });

  it("does not carry forged image-generation metadata into a new ownership proof", () => {
    const forged = parts.map(part => part.type === "tool" ? { ...part, toolName: "PluginTool" } : part);
    const result = preserveCompactedAttachments({ sessionId, history: summaryHistory(), parts: forged });
    expect(result.messages.flatMap(message => message.parts).some(part => part.type === "attachment")).toBe(false);
    expect(JSON.stringify(result.history)).not.toContain(resource);
  });

  it("carries only minimal ownership fields rather than old prompts, outputs or image payloads", () => {
    const result = preserveCompactedAttachments({ sessionId, history: summaryHistory(), parts });
    const persisted = JSON.stringify(result.messages);
    expect(persisted).not.toContain("PRIVATE_PROMPT");
    expect(persisted).not.toContain("PRIVATE_PROVIDER_OUTPUT");
    expect(persisted).not.toContain('"input"');
    expect(persisted).not.toContain('"output"');
    expect(persisted).toContain('"assetId":"generated"');
  });

  it("creates a resource boundary when summarized image ownership exists without a boundary", () => {
    const result = preserveCompactedAttachments({ sessionId, history: [{ type: "assistant", content: "summary" }], parts });
    expect(result.history).toContainEqual(expect.objectContaining({ type: "user", compactRole: "boundary", content: expect.stringContaining(resource) }));
  });

  it("does not invent a user turn when all generation calls remain in recent history", () => {
    const history: Message[] = [{ type: "assistant", content: "", toolUses: [{ type: "tool_use", id: "generated-call", name: "ImageGeneration", input: {} }] }];
    const result = preserveCompactedAttachments({ sessionId, history, parts });
    expect(result.history).toEqual(history);
  });

  it("removes the old host footer when its generated image references have been revoked", () => {
    const first = preserveCompactedAttachments({ sessionId, history: summaryHistory(), parts });
    const revoked = preserveCompactedAttachments({ sessionId, history: first.history, parts: [] });
    expect(revoked.history).toEqual(summaryHistory());
    expect(revoked.messages.flatMap(message => message.parts).some(part => part.type === "attachment")).toBe(false);
  });

  it("bounds the visible catalog to the latest 20 images while preserving every ownership reference", () => {
    const many = [parts[0]!, ...Array.from({ length: 23 }, (_, index) => ({
      ...parts[1]!, id: `image-${index}`, seq: index + 2, assetId: `image-${index}`,
    }))];
    const result = preserveCompactedAttachments({ sessionId, history: summaryHistory(), parts: many });
    const historyText = JSON.stringify(result.history);
    expect(historyText.match(/attachment:\/\/image-/g)).toHaveLength(20);
    expect(historyText).not.toContain("attachment://image-2/");
    expect(historyText).toContain("attachment://image-3/");
    expect(result.messages.flatMap(message => message.parts).filter(part => part.type === "attachment")).toHaveLength(23);
    expect(result.messages.flatMap(message => message.parts).filter(part => part.type === "tool")).toHaveLength(1);
  });

  it("stops the footer at a complete URI line before exceeding 12000 characters", () => {
    const name = `${"界".repeat(150)}.png`;
    const many = [parts[0]!, ...Array.from({ length: 20 }, (_, index) => ({
      ...parts[1]!, id: `image-${index}`, seq: index + 2, assetId: `image-${index}`, displayName: name,
    }))];
    const result = preserveCompactedAttachments({ sessionId, history: summaryHistory(), parts: many });
    const boundary = result.history.find(message => message.type === "user" && message.compactRole === "boundary")!;
    if (boundary.type !== "user" || typeof boundary.content !== "string") throw new Error("Expected text boundary");
    expect(boundary.content.length).toBeLessThanOrEqual(12000 + "[Compact boundary marker]".length);
    const resourceLines = boundary.content.split("\n").filter(line => line.startsWith("- attachment://"));
    expect(resourceLines.length).toBeGreaterThan(0);
    expect(resourceLines.length).toBeLessThan(20);
    for (const line of resourceLines) expect(line).toMatch(/\.png$/);
    expect(result.messages.flatMap(message => message.parts).filter(part => part.type === "attachment")).toHaveLength(20);
  });
});
