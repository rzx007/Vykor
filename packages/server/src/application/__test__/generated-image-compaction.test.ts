import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

import { createDefaultNodeAgent, type VykorAgent } from "@vykor/agent-runtime";
import type { Message, StreamingMessageClient, ToolDefinition, ToolUseBlock } from "@vykor/agent-contracts";
import type { Settings } from "@vykor/host-config";
import { SessionStore } from "@vykor/services";
import { createFileReadTool } from "@vykor/tools";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DaemonApplication } from "../daemon-application.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);
const privatePrompt = "GENERATION-PROMPT-MUST-NOT-BECOME-AUTHORIZATION-PROOF:" + "p".repeat(8_000);
const settings: Settings = {
  model: "generated-vision", provider: "generated-fixture", apiFormat: "openai", maxTurns: 3,
  permission: { mode: "full_access" }, sandbox: { enabled: false },
  plugins: { enabled: false }, memory: { enabled: false },
  customProviders: [{
    id: "generated-fixture", displayName: "Generated image fixture", baseUrl: "https://chat.invalid/v1",
    apiFormat: "openai", models: [{ id: "generated-vision", displayName: "Vision", imageInputSupport: "native" }],
  }],
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function createFixture() {
  const directory = mkdtempSync(join(tmpdir(), "vykor-generated-compact-"));
  const path = join(directory, "sessions.db");
  let store = new SessionStore({ path });
  let application: DaemonApplication;
  const agents = new Map<string, VykorAgent>();
  let read: ToolDefinition;
  let imageGeneration: ToolDefinition;
  let pendingCall: ToolUseBlock | undefined;
  let calls = 0;
  let summarizing = false;
  let summaries = 0;
  const requests: Record<string, unknown>[] = [];
  vi.stubEnv("AGNES_API_KEY", "fixture-key");
  vi.stubEnv("AGNES_IMAGE_BASE_URL", "https://images.invalid/v1");
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    if (String(url) !== "https://images.invalid/v1/images/generations") {
      throw new Error(`Unexpected fixture network request: ${String(url)}`);
    }
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ data: [{ b64_json: png.toString("base64") }] }));
  }));
  const client: StreamingMessageClient = {
    async *streamMessage(params) {
      if (summarizing || params.system === "You are a conversation summarizer.") {
        summaries++;
        // Deliberately omit the attachment URI: the host must retain ownership,
        // independently of what the model chooses to mention in its summary.
        yield { type: "text_delta", delta: "<summary>An image was created. Continue the task.</summary>" };
        yield { type: "complete", stopReason: "end_turn" };
      } else if (pendingCall) {
        const toolUse = pendingCall;
        pendingCall = undefined;
        yield { type: "tool_use_start", toolUse };
        yield { type: "complete", stopReason: "tool_use" };
      } else {
        yield { type: "text_delta", delta: "Image request completed." };
        yield { type: "complete", stopReason: "end_turn" };
      }
    },
  };
  const open = async () => {
    const app = new DaemonApplication({
      store, settings, log: () => {},
      createAgent: async (context) => {
        read = context.options.toolDecorators!.find((tool) => tool.name === "Read")!
          .decorate(createFileReadTool({ settings: context.options.settings }));
        imageGeneration = context.options.tools!.find((tool) => tool.name === "ImageGeneration")!;
        const agent = await createDefaultNodeAgent({ ...context.options, client });
        agents.set(context.session.id, agent);
        return { agent, host: agent.host };
      },
    });
    await app.ready();
    return app;
  };
  application = await open();
  const context = (sessionId: string) => ({
    cwd: directory, sessionId, settings,
    requestConfiguration: { model: settings.model, provider: settings.provider, apiFormat: settings.apiFormat },
  });
  const prompt = async (sessionId: string, content: string) => {
    const admitted = await application.interactions.admitPrompt(sessionId, { content });
    return application.runControl.awaitRun(sessionId, admitted.run!.id);
  };
  return {
    get app() { return application; },
    get store() { return store; },
    get summaries() { return summaries; },
    directory, agents, requests, prompt,
    async generate(sessionId: string, images?: string[]) {
      const id = `generated-call-${++calls}`;
      pendingCall = { type: "tool_use", id, name: "ImageGeneration", input: { prompt: privatePrompt, ...(images ? { images } : {}) } };
      expect(await prompt(sessionId, "Create or edit the image." )).toMatchObject({ status: "completed" });
      const attachment = store.conversations.listMessageParts(sessionId)
        .find((part) => part.type === "attachment" && part.metadata.toolUseId === id)!;
      expect(attachment?.assetId).toBeDefined();
      return { callId: id, assetId: attachment.assetId!, uri: `attachment://${attachment.assetId}/${encodeURIComponent(attachment.displayName!)}` };
    },
    async save(sessionId: string, uri: string, filePath: string) {
      const id = `save-generated-${++calls}`;
      pendingCall = { type: "tool_use", id, name: "SaveAttachment", input: { attachment_uri: uri, file_path: filePath } };
      const run = await prompt(sessionId, "Save the earlier generated image as an original workspace file.");
      expect(run.error).toBeUndefined();
      const result = agents.get(sessionId)!.getHistory().find((message) => message.type === "tool_result" && message.toolUseId === id);
      expect(result).toBeDefined();
      expect(result?.type === "tool_result" && result.isError, JSON.stringify(result)).not.toBe(true);
    },
    async compact(sessionId: string, forceSummary: boolean) {
      if (forceSummary) {
        const agent = agents.get(sessionId)!;
        const recent: Message[] = Array.from({ length: 10 }, (_, index) => ({
          type: index % 2 === 0 ? "user" as const : "assistant" as const,
          content: `recent fixture ${index}: ` + "x".repeat(60_000),
        }));
        // The real manual compactor only summarizes above its 100k token gate.
        // Recent messages stay outside the deterministic older-message collapse.
        agent.loadHistory([...agent.getHistory(), ...recent]);
      }
      summarizing = true;
      try { return await application.maintenance.compact(sessionId); }
      finally { summarizing = false; }
    },
    readImage: (sessionId: string, uri: string) => read.execute({ file_path: uri }, context(sessionId)),
    editImage: (sessionId: string, uri: string) => imageGeneration.execute({ prompt: "edit", images: [uri] }, context(sessionId)),
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

function textOf(messages: Message[]): string {
  return messages.map((message) => typeof message.content === "string" ? message.content
    : message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n")).join("\n");
}

describe("manual compaction of generated image references", () => {
  it.each([false, true])("keeps generated originals readable and editable across compact/reopen (summarized=%s)", async summarized => {
    const fixture = await createFixture();
    try {
      const session = fixture.app.commands.createSession({ cwd: fixture.directory, model: settings.model });
      const original = await fixture.generate(session.id);
      await fixture.compact(session.id, summarized);
      const oldCallRetained = fixture.agents.get(session.id)!.getHistory().some((message) =>
        message.type === "assistant" && message.toolUses?.some((call) => call.id === original.callId));
      expect(oldCallRetained).toBe(!summarized);
      if (summarized) {
        expect(fixture.summaries).toBeGreaterThan(0);
        expect(textOf(fixture.agents.get(session.id)!.getHistory())).toContain(original.uri);
      }
      const readOriginal = async () => {
        const result = await fixture.readImage(session.id, original.uri);
        expect(result.isError).not.toBe(true);
        const image = result.content.find((block) => block.type === "image");
        expect(image?.type).toBe("image");
        if (image?.type !== "image") throw new Error("Generated original was not readable");
        expect(readFileSync(image.source.path)).toEqual(png);
      };
      await readOriginal();
      await fixture.reopen(session.id);
      await readOriginal();
      const savedOriginal = join(fixture.directory, "saved-generated-original.png");
      await fixture.save(session.id, original.uri, savedOriginal);
      expect(readFileSync(savedOriginal)).toEqual(png);
      const continuation = await fixture.prompt(session.id, "Continue using the earlier generated image.");
      expect(continuation.error).toBeUndefined();
      expect(continuation).toMatchObject({ status: "completed" });
      const latestPrompt = fixture.store.conversations.listMessages(session.id)
        .filter((message) => message.role === "user").at(-1)!;
      const replayed = await fixture.app.interactions.editLatestPrompt(session.id, {
        id: "corrected-followup", sourceMessageId: latestPrompt.id,
        content: "Use the earlier original after this correction.", traceId: "generated-compact-edit",
      });
      expect(await fixture.app.runControl.awaitRun(session.id, replayed.run!.id))
        .toMatchObject({ status: "completed" });
      await readOriginal();
      const edited = await fixture.generate(session.id, [original.uri]);
      expect(fixture.requests.at(-1)).toMatchObject({ extra_body: { image: [`data:image/png;base64,${png.toString("base64")}`] } });
      await fixture.compact(session.id, summarized);
      await readOriginal();
      expect((await fixture.readImage(session.id, edited.uri)).isError).not.toBe(true);
      const referenceCount = () => fixture.store.conversations.listMessageParts(session.id)
        .filter((part) => part.type === "attachment" && part.assetId === original.assetId).length;
      const referencesAfterTwo = referenceCount();
      expect(referencesAfterTwo).toBe(1);
      await fixture.compact(session.id, summarized);
      expect(referenceCount()).toBe(referencesAfterTwo);
      const carriers = fixture.store.conversations.listMessages(session.id)
        .filter((message) => message.role === "system" &&
          (message.metadata.presentation as { kind?: string } | undefined)?.kind === "context_compaction");
      const carrierIds = new Set(carriers.map((message) => message.id));
      const proofs = fixture.store.conversations.listMessageParts(session.id).filter((part) => carrierIds.has(part.messageId));
      expect(JSON.stringify({ carriers, proofs })).not.toContain(privatePrompt.slice(0, 50));
      expect(JSON.stringify({ carriers, proofs }).length).toBeLessThan(12_000);
      const beforeDenied = fixture.requests.length;
      await fixture.app.commands.deleteSessionTree(session.id);
      expect((await fixture.readImage(session.id, original.uri)).isError).toBe(true);
      expect((await fixture.editImage(session.id, original.uri)).isError).toBe(true);
      expect(fixture.requests).toHaveLength(beforeDenied);
    } finally { await fixture.close(); }
  }, 60_000);

  it("does not authorize another session's generated image from a URI in user or summary text", async () => {
    const fixture = await createFixture();
    try {
      const cwd = fixture.directory;
      const owner = fixture.app.commands.createSession({ cwd, model: settings.model });
      const original = await fixture.generate(owner.id);
      const other = fixture.app.commands.createSession({ cwd, model: settings.model });
      await fixture.prompt(other.id, `Use this image: ${original.uri}`);
      await fixture.compact(other.id, true);
      expect(textOf(fixture.agents.get(other.id)!.getHistory())).toContain(original.uri);
      const beforeDenied = fixture.requests.length;
      expect((await fixture.readImage(other.id, original.uri)).isError).toBe(true);
      expect((await fixture.editImage(other.id, original.uri)).isError).toBe(true);
      expect(fixture.requests).toHaveLength(beforeDenied);
      expect((await fixture.readImage(owner.id, original.uri)).isError).not.toBe(true);
    } finally { await fixture.close(); }
  }, 60_000);
});
