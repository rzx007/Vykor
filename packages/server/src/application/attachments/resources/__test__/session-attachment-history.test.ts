import type { SessionInputAttachmentRecord } from "@vykor/domain-contracts/attachments";
import type { SessionMessageRecord } from "@vykor/domain-contracts/sessions";
import { expect, it } from "vitest";

import { AttachmentCapabilityRouter } from "../../routing/attachment-capability-router.js";
import { restoreSessionAttachmentHistory } from "../session-attachment-history.js";

const references: SessionInputAttachmentRecord[] = [
  { id: "ref-image", sessionId: "s1", inputId: "i1", assetId: "image", seq: 0, intent: "auto", displayName: "screen.png", mediaType: "image/png", sizeBytes: 4, metadata: {}, createdAt: 1 },
  { id: "ref-text", sessionId: "s1", inputId: "i1", assetId: "notes", seq: 1, intent: "auto", displayName: "notes.txt", mediaType: "text/plain", sizeBytes: 5, metadata: {}, createdAt: 1 },
];
const history: SessionMessageRecord[] = [{ id: "m1", sessionId: "s1", inputId: "i1", seq: 1, role: "user", metadata: {}, createdAt: 1, updatedAt: 1 }];
const router = new AttachmentCapabilityRouter({
  resolveReadyContentPath: async assetId => ({ assetId, path: "/host-private/blob", mediaType: "image/png", sizeBytes: 4 }),
  readReadyText: async assetId => ({ assetId, displayName: "notes.txt", mediaType: "text/plain", encoding: "utf-8", text: "notes" }),
});

it("keeps text and stable attachment access when the current model catalog is unavailable", async () => {
  const restored = await restoreSessionAttachmentHistory({
    sessionId: "s1", history, references, router,
    resolveCapabilities: async () => { throw new Error("catalog_load_failed"); },
    availableTools: ["Read", "ImageGeneration"], attachmentOcrAvailable: false,
  });
  const text = restored.m1!.filter(block => block.type === "text").map(block => block.text).join("\n");
  expect(text).toContain("notes");
  expect(text).toContain("attachment://image/screen.png");
  expect(restored.m1!.some(block => block.type === "image")).toBe(false);
  expect(text).not.toContain("/host-private");
});

it("does not load a transcript attachment using another input's authorization", async () => {
  const restored = await restoreSessionAttachmentHistory({
    sessionId: "s1", history,
    references: references.map(reference => ({ ...reference, inputId: "another-input" })),
    router,
    resolveCapabilities: async () => ({ modelCapabilities: { image: "native" }, providerCapabilities: { image: "native", imageMediaTypes: ["image/png"] } }),
    availableTools: ["Read"], attachmentOcrAvailable: false,
  });
  expect(restored).toEqual({});
});

it("restores durable input references in order without depending on transcript attachment parts", async () => {
  const restored = await restoreSessionAttachmentHistory({
    sessionId: "s1", history, references: [...references].reverse(), router,
    resolveCapabilities: async () => ({ modelCapabilities: { image: "native" }, providerCapabilities: { image: "native", imageMediaTypes: ["image/png"] } }),
    availableTools: ["Read"], attachmentOcrAvailable: false,
  });
  expect(restored.m1?.[0]).toMatchObject({ type: "image", source: { path: "/host-private/blob" } });
  const text = restored.m1!.filter(block => block.type === "text").map(block => block.text).join("\n");
  expect(text).toContain("attachment://image/screen.png");
  expect(text).toContain("attachment://notes/notes.txt");
  expect(text).toContain("\nnotes\n");
});
