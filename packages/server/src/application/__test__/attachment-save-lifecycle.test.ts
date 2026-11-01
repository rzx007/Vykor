import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

import { createDefaultNodeAgent, type VykorAgent } from "@vykor/agent-runtime";
import type { Message, StreamingMessageClient, ToolUseBlock } from "@vykor/agent-contracts";
import type { Settings } from "@vykor/host-config";
import { SessionStore } from "@vykor/services";
import { describe, expect, it } from "vitest";

import { DaemonApplication } from "../daemon-application.js";

const image = {
  name: "original.png", mediaType: "image/png",
  bytes: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64"),
};
const text = { name: "notes.txt", mediaType: "text/plain", bytes: Buffer.from("\uFEFFOriginal résumé\r\nKeep the BOM and line endings.\r\n") };
const binary = { name: "original.bin", mediaType: "application/octet-stream", bytes: Buffer.from([0, 255, 13, 10, 1, 128, 0, 42]) };
// A complete stored DOCX package: content types, root relationships and one Word document.
const office = {
  name: "original.docx", mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  bytes: Buffer.from("UEsDBBQAAAAAAAAAAADMVIwQnAEAAJwBAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbDw/eG1sIHZlcnNpb249IjEuMCIgZW5jb2Rpbmc9IlVURi04Ij8+PFR5cGVzIHhtbG5zPSJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvcGFja2FnZS8yMDA2L2NvbnRlbnQtdHlwZXMiPjxEZWZhdWx0IEV4dGVuc2lvbj0icmVscyIgQ29udGVudFR5cGU9ImFwcGxpY2F0aW9uL3ZuZC5vcGVueG1sZm9ybWF0cy1wYWNrYWdlLnJlbGF0aW9uc2hpcHMreG1sIi8+PERlZmF1bHQgRXh0ZW5zaW9uPSJ4bWwiIENvbnRlbnRUeXBlPSJhcHBsaWNhdGlvbi94bWwiLz48T3ZlcnJpZGUgUGFydE5hbWU9Ii93b3JkL2RvY3VtZW50LnhtbCIgQ29udGVudFR5cGU9ImFwcGxpY2F0aW9uL3ZuZC5vcGVueG1sZm9ybWF0cy1vZmZpY2Vkb2N1bWVudC53b3JkcHJvY2Vzc2luZ21sLmRvY3VtZW50Lm1haW4reG1sIi8+PC9UeXBlcz5QSwMEFAAAAAAAAAAAADZX3twYAQAAGAEAAAsAAABfcmVscy8ucmVsczw/eG1sIHZlcnNpb249IjEuMCIgZW5jb2Rpbmc9IlVURi04Ij8+PFJlbGF0aW9uc2hpcHMgeG1sbnM9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9wYWNrYWdlLzIwMDYvcmVsYXRpb25zaGlwcyI+PFJlbGF0aW9uc2hpcCBJZD0icklkMSIgVHlwZT0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL29mZmljZURvY3VtZW50LzIwMDYvcmVsYXRpb25zaGlwcy9vZmZpY2VEb2N1bWVudCIgVGFyZ2V0PSJ3b3JkL2RvY3VtZW50LnhtbCIvPjwvUmVsYXRpb25zaGlwcz5QSwMEFAAAAAAAAAAAAIHukoTXAAAA1wAAABEAAAB3b3JkL2RvY3VtZW50LnhtbDw/eG1sIHZlcnNpb249IjEuMCIgZW5jb2Rpbmc9IlVURi04Ij8+PHc6ZG9jdW1lbnQgeG1sbnM6dz0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL3dvcmRwcm9jZXNzaW5nbWwvMjAwNi9tYWluIj48dzpib2R5Pjx3OnA+PHc6cj48dzp0PlByZXNlcnZlIG9yaWdpbmFsIE9mZmljZSBieXRlcy48L3c6dD48L3c6cj48L3c6cD48L3c6Ym9keT48L3c6ZG9jdW1lbnQ+UEsBAhQAFAAAAAAAAAAAAMxUjBCcAQAAnAEAABMAAAAAAAAAAAAAAAAAAAAAAFtDb250ZW50X1R5cGVzXS54bWxQSwECFAAUAAAAAAAAAAAANlfe3BgBAAAYAQAACwAAAAAAAAAAAAAAAADNAQAAX3JlbHMvLnJlbHNQSwECFAAUAAAAAAAAAAAAge6ShNcAAADXAAAAEQAAAAAAAAAAAAAAAAAOAwAAd29yZC9kb2N1bWVudC54bWxQSwUGAAAAAAMAAwC5AAAAFAQAAAAA", "base64"),
};
type SourceFile = typeof image;

async function createFixture(visual = true, permission: Settings["permission"] = { mode: "full_access" }) {
  const directory = mkdtempSync(join(tmpdir(), "vykor-save-attachment-"));
  const path = join(directory, "sessions.db");
  const settings: Settings = {
    model: "save-model", provider: "save-fixture", apiFormat: "openai", maxTurns: 3,
    permission, sandbox: { enabled: false },
    plugins: { enabled: false }, memory: { enabled: false },
    customProviders: [{
      id: "save-fixture", displayName: "Save fixture", baseUrl: "https://save.invalid/v1", apiFormat: "openai",
      models: [{ id: "save-model", displayName: "Save model", imageInputSupport: visual ? "native" : "unsupported" }],
    }],
  };
  let store = new SessionStore({ path });
  let application: DaemonApplication;
  let pending: ToolUseBlock | undefined;
  let callNumber = 0;
  const agents = new Map<string, VykorAgent>();
  const modelRequests: Message[][] = [];
  const client: StreamingMessageClient = {
    async *streamMessage(params) {
      modelRequests.push(structuredClone(params.messages));
      if (params.system === "You are a conversation summarizer.") {
        yield { type: "text_delta", delta: "<summary>Preserve the original source files.</summary>" };
        yield { type: "complete", stopReason: "end_turn" };
      } else if (pending) {
        const toolUse = pending;
        pending = undefined;
        yield { type: "tool_use_start", toolUse };
        yield { type: "complete", stopReason: "tool_use" };
      } else {
        yield { type: "text_delta", delta: "Attachment request completed." };
        yield { type: "complete", stopReason: "end_turn" };
      }
    },
  };
  const open = async () => {
    const result = new DaemonApplication({
      store, settings, log: () => {},
      createAgent: async (context) => {
        const agent = await createDefaultNodeAgent({ ...context.options, client });
        agents.set(context.session.id, agent);
        return { agent, host: agent.host };
      },
    });
    await result.ready();
    return result;
  };
  application = await open();
  const prompt = async (sessionId: string, content: string) => {
    const admitted = await application.interactions.admitPrompt(sessionId, { content });
    return application.runControl.awaitRun(sessionId, admitted.run!.id);
  };
  return {
    directory, modelRequests,
    get app() { return application; },
    get store() { return store; },
    session: () => application.commands.createSession({ cwd: directory, model: settings.model,
      ...(permission.mode === "plan" ? { metadata: { runtime: { approvalMode: "full_access", workMode: "plan" } } } : {}),
    }),
    prompt,
    async upload(sessionId: string, files: SourceFile[]) {
      const sources = [];
      for (const file of files) {
        const asset = await application.attachments.import({
          displayName: file.name, declaredMediaType: file.mediaType, content: new Blob([file.bytes]).stream(),
        });
        sources.push({ ...file, assetId: asset.id, uri: `attachment://${asset.id}/${encodeURIComponent(file.name)}` });
      }
      const admitted = await application.interactions.admitPrompt(sessionId, {
        content: "Keep these source attachments available for saving their original bytes.",
        attachments: sources.map((source) => ({ assetId: source.assetId })),
      });
      const run = await application.runControl.awaitRun(sessionId, admitted.run!.id);
      expect(run.error).toBeUndefined();
      expect(run.status).toBe("completed");
      return sources;
    },
    async save(sessionId: string, uri: string, filePath: string) {
      const id = `save-${++callNumber}`;
      pending = { type: "tool_use", id, name: "SaveAttachment", input: { attachment_uri: uri, file_path: filePath } };
      const run = await prompt(sessionId, "Save the referenced attachment to the workspace.");
      expect(run.error).toBeUndefined();
      const result = agents.get(sessionId)!.getHistory().find(
        (message): message is Extract<Message, { type: "tool_result" }> => message.type === "tool_result" && message.toolUseId === id,
      );
      expect(result).toBeDefined();
      return result!;
    },
    async reopen(sessionId: string) {
      await application.close();
      store.close();
      store = new SessionStore({ path });
      application = await open();
      await application.control.inspectRuntimeHooks(sessionId);
    },
    async close() {
      await application.close().catch(() => {});
      store.close();
      const withinTemp = relative(tmpdir(), directory);
      if (!withinTemp || withinTemp.startsWith("..") || isAbsolute(withinTemp)) throw new Error("Fixture escaped temporary directory");
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

describe("SaveAttachment through the durable daemon", () => {
  it("saves PNG and original text bytes without requiring a visual model", async () => {
    const fixture = await createFixture(false);
    try {
      const session = fixture.session();
      const sources = await fixture.upload(session.id, [image, text]);
      for (const source of sources) {
        const target = join(fixture.directory, `saved-${source.name}`);
        const result = await fixture.save(session.id, source.uri, target);
        expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
        expect(readFileSync(target)).toEqual(source.bytes);
      }
    } finally { await fixture.close(); }
  });

  it.each(["daemon restart", "edit and resend", "manual compact"] as const)(
    "saves uploaded images, binary and Office originals after %s",
    async (lifecycle) => {
      const fixture = await createFixture();
      try {
        const session = fixture.session();
        // Go through normal input admission and routing: a fabricated reference
        // in the store would hide unsupported binary/Office submission paths.
        const sources = await fixture.upload(session.id, [image, binary, office]);
        if (lifecycle === "daemon restart") {
          await fixture.reopen(session.id);
        } else if (lifecycle === "manual compact") {
          await fixture.app.maintenance.compact(session.id);
        } else {
          expect(await fixture.prompt(session.id, "Use the earlier original files." )).toMatchObject({ status: "completed" });
          const latest = fixture.store.conversations.listMessages(session.id).filter((message) => message.role === "user").at(-1)!;
          const edited = await fixture.app.interactions.editLatestPrompt(session.id, {
            id: "edited-save-followup", sourceMessageId: latest.id,
            content: "Save the earlier original files after this correction.", traceId: "save-attachment-edit",
          });
          expect(await fixture.app.runControl.awaitRun(session.id, edited.run!.id)).toMatchObject({ status: "completed" });
        }
        for (const source of sources) {
          const target = join(fixture.directory, `saved-${source.name}`);
          const result = await fixture.save(session.id, source.uri, target);
          expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
          expect(readFileSync(target)).toEqual(source.bytes);
        }
      } finally { await fixture.close(); }
    }, 60_000,
  );

  it("rejects foreign references and revokes deleted sessions without writing a target", async () => {
    const fixture = await createFixture();
    try {
      const owner = fixture.session();
      const [source] = await fixture.upload(owner.id, [text]);
      const ownerTarget = join(fixture.directory, "owner-copy.txt");
      expect((await fixture.save(owner.id, source!.uri, ownerTarget)).isError).not.toBe(true);
      expect(readFileSync(ownerTarget)).toEqual(text.bytes);
      const other = fixture.session();
      const foreignTarget = join(fixture.directory, "foreign-copy.txt");
      expect((await fixture.save(other.id, source!.uri, foreignTarget)).isError).toBe(true);
      expect(existsSync(foreignTarget)).toBe(false);
      await fixture.app.commands.deleteSessionTree(owner.id);
      const deletedTarget = join(fixture.directory, "deleted-copy.txt");
      await expect(fixture.save(owner.id, source!.uri, deletedTarget)).rejects.toMatchObject({ status: 404 });
      expect(existsSync(deletedTarget)).toBe(false);
      expect(readFileSync(ownerTarget)).toEqual(text.bytes);
    } finally { await fixture.close(); }
  });

  it.each<[string, Settings["permission"]]>([
    ["explicit deny in full access", { mode: "full_access", deniedTools: ["SaveAttachment"] }],
    ["read-only plan mode", { mode: "plan" }],
  ])("honors %s even when the source attachment is authorized", async (_name, permission) => {
    const fixture = await createFixture(true, permission);
    try {
      const session = fixture.session();
      const [source] = await fixture.upload(session.id, [text]);
      const target = join(fixture.directory, "permission-denied-copy.txt");
      const result = await fixture.save(session.id, source!.uri, target);
      expect(result).toMatchObject({ isError: true, executionState: "not_started" });
      expect(existsSync(target)).toBe(false);
    } finally { await fixture.close(); }
  });

  it("delivers nested project rules before saving and retains trusted host file facts after retry", async () => {
    const fixture = await createFixture();
    try {
      const session = fixture.session();
      const [source] = await fixture.upload(session.id, [text]);
      const nested = join(fixture.directory, "nested");
      mkdirSync(nested);
      const rule = "NESTED_SAVE_RULE: Preserve every original attachment byte in this directory.";
      writeFileSync(join(nested, "AGENTS.md"), rule);
      const target = join(nested, "original-copy.txt");
      const first = await fixture.save(session.id, source!.uri, target);
      expect(first).toMatchObject({ isError: true, failureKind: "precondition", executionState: "not_started" });
      expect(JSON.stringify(first.content)).toContain(rule);
      expect(existsSync(target)).toBe(false);
      expect(JSON.stringify(fixture.modelRequests.at(-1))).toContain(rule);
      const retried = await fixture.save(session.id, source!.uri, target);
      expect(retried.isError, JSON.stringify(retried.content)).not.toBe(true);
      expect(readFileSync(target)).toEqual(text.bytes);
      expect(retried.hostFileFacts).toMatchObject({
        files: [expect.objectContaining({ path: target, operation: "write", beforeDigest: "missing", completed: true })],
      });
    } finally { await fixture.close(); }
  });
});
