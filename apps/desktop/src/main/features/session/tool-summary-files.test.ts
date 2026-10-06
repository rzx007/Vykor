import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { applyPatchTool } from "../../../../../../packages/tools/src/file/apply-patch.js";
import { fileEditTool } from "../../../../../../packages/tools/src/file/edit.js";
import { VykorHttpServer } from "../../../../../../packages/server/src/http/server.js";
import { VykorClient } from "@vykor/client";
import type { DesktopSessionPart } from "@shared/session-types";
import { collectChangedFiles } from "../../../renderer/src/components/desktop/conversation-page/message/message-render-model";
import { SessionStore } from "../../../../../../packages/services/src/index.js";
import { SessionTranscriptProjection } from "../../../../../../packages/server/src/application/session/transcript-projection.js";
import { QueryEngine, ToolRegistry, type StreamEvent } from "../../../../../../packages/core/src/index.js";

it("keeps actual long ApplyPatch and ordered Edit file identities without deriving preview line counts", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "oh-summary-files-"));
  const store = new SessionStore({ path: join(cwd, "session.db") });
  vi.stubEnv("VYKOR_CONFIG_DIR", join(cwd, "config"));
  const server = new VykorHttpServer({ store, logger: () => {} });
  try {
    await server.application.ready();
    const before = "OLD".repeat(3000);
    const after = "NEW".repeat(3000);
    writeFileSync(join(cwd, "patch.txt"), before + "\n");
    writeFileSync(join(cwd, "edit.txt"), before + "\n");
    const patchInput = { patch: `--- a/patch.txt\n+++ b/patch.txt\n@@ -1 +1 @@\n-${before}\n+${after}\n` };
    const editInput = { file_path: join(cwd, "edit.txt"), edits: [{ old_string: before, new_string: after }] };
    const wrappedInput = { arguments: { file_path: join(cwd, "wrapped.txt"), old_string: before, new_string: after } };
    writeFileSync(join(cwd, "wrapped.txt"), before + "\n");
    const context = { cwd } as Parameters<NonNullable<typeof applyPatchTool.execute>>[1];
    const patchResult = await applyPatchTool.execute!(patchInput, context);
    const editResult = await fileEditTool.execute!(editInput, context);
    expect(patchResult.isError).not.toBe(true);
    expect(patchResult.metadata?.changedFiles).toEqual({ files: [{ path: "patch.txt", operation: "update" }], fileCount: 1, truncated: false });
    expect(editResult.isError).not.toBe(true);
    const session = store.sessions.create({ cwd, model: "fixture" });
    const projection = new SessionTranscriptProjection(store);
    const state = projection.beginRun(session.id, "input", "run", { id: "input", sessionId: session.id, seq: 1, delivery: "queue", items: [], content: "", attachments: [], metadata: { transcriptVisibility: "hidden" }, createdAt: 1 });
    for (const [name, input, result] of [["ApplyPatch", patchInput, patchResult], ["Edit", editInput, editResult]] as const) {
      projection.projectStreamEvent(state, { type: "tool_use_start", toolUse: { type: "tool_use", id: name, name, input } });
      projection.projectStreamEvent(state, { type: "tool_use_end", toolUseId: name, result });
    }
    const registry = new ToolRegistry();
    registry.register(fileEditTool);
    let requested = false;
    const engine = new QueryEngine({ async *streamMessage(): AsyncIterable<StreamEvent> {
      if (!requested) {
        requested = true;
        yield { type: "tool_use_start", toolUse: { type: "tool_use", id: "WrappedEdit", name: "Edit", input: wrappedInput } };
        yield { type: "complete", stopReason: "tool_use" };
      } else yield { type: "complete", stopReason: "end_turn" };
    } }, registry, { checkTool: async () => ({ action: "allow" }) },
    { register() {}, execute: async () => ({ blocked: false }) }, { cwd, trajectoryTrackerFactory: false });
    for await (const event of engine.submitMessage("fixture")) {
      if (event.type === "tool_use_end") expect(event.result).toMatchObject({ executionState: "completed" });
      // Match the tool.started/tool.completed events handled by the production projector.
      if (event.type === "tool_use_start" || event.type === "tool_use_end") projection.projectStreamEvent(state, event);
    }
    expect(readFileSync(join(cwd, "wrapped.txt"), "utf8")).toBe(after + "\n");
    const canonicalWrapped = store.conversations.listMessageParts(session.id).find(part => part.id === "WrappedEdit")!;
    expect(canonicalWrapped.input).toEqual(wrappedInput);
    expect(canonicalWrapped.input).not.toHaveProperty("file_path");
    const client = new VykorClient({ baseUrl: "http://fixture.test", fetch: async (input, init) => server.app.request(String(input), init) });
    const parts = (await client.sessions.getState(session.id, { partView: "summary" })).parts;
    expect(parts.map(part => part.bodyView?.input)).toEqual(["preview", "preview", "preview"]);
    const files = collectChangedFiles(parts as DesktopSessionPart[]);
    expect(files.map(file => file.path)).toEqual(["patch.txt", join(cwd, "edit.txt"), join(cwd, "wrapped.txt")]);
    expect(files.every(file => file.hasStats === false && file.additions === 0 && file.deletions === 0)).toBe(true);
    const manyPatch = Array.from({ length: 40 }, (_, i) => {
      writeFileSync(join(cwd, `f${i}.txt`), "before\n");
      return `--- a/f${i}.txt\n+++ b/f${i}.txt\n@@ -1 +1 @@\n-before\n+after\n`;
    }).join("");
    const manyResult = await applyPatchTool.execute!({ patch: manyPatch }, context);
    expect(manyResult.isError).not.toBe(true);
    const identities = manyResult.metadata?.changedFiles as { files: Array<{ path: string }>; fileCount: number; truncated: boolean };
    expect(identities).toMatchObject({ fileCount: 40, truncated: true });
    expect(identities.files).toHaveLength(32);
    expect(Buffer.byteLength(JSON.stringify(identities))).toBeLessThan(2200);
  } finally {
    await server.close();
    vi.unstubAllEnvs();
    rmSync(cwd, { recursive: true, force: true });
  }
});
