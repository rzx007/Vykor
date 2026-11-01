import { mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

import { createDefaultNodeAgent, type VykorAgent } from "@vykor/agent-runtime";
import type { ContentBlock, StreamingMessageClient, ToolDefinition } from "@vykor/agent-contracts";
import type { Settings } from "@vykor/host-config";
import { SessionStore } from "@vykor/services";
import { createFileReadTool } from "@vykor/tools";
import { describe, expect, it, vi } from "vitest";

import { DaemonApplication } from "../daemon-application.js";

const imageBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);
const notes = "Keep this attachment available after rebuilding the session.";
const settings: Settings = {
  model: "attachment-vision",
  provider: "attachment-fixture",
  apiFormat: "openai",
  maxTurns: 3,
  permission: { mode: "full_access" },
  sandbox: { enabled: false },
  plugins: { enabled: false },
  memory: { enabled: false },
  customProviders: [{
    id: "attachment-fixture",
    displayName: "Attachment test fixture",
    baseUrl: "https://attachment.invalid/v1",
    apiFormat: "openai",
    models: [{ id: "attachment-vision", displayName: "Vision", imageInputSupport: "native" }],
  }],
};

describe("attachment history lifecycle", () => {
  // Losing the durable references during loader hydration must break both
  // scenarios, even though the original blobs are still intact.
  it.each([
    "daemon restart", "edit and resend", "idle eviction", "daemon restart with one missing original",
  ] as const)(
    "retains readable attachment context after %s",
    async (lifecycle) => {
      const missingImage = lifecycle === "daemon restart with one missing original";
      const directory = mkdtempSync(join(tmpdir(), "vykor-attachment-lifecycle-"));
      const path = join(directory, "sessions.db");
      let store = new SessionStore({ path });
      const agents: VykorAgent[] = [];
      let readTool: ToolDefinition | undefined;
      let application: DaemonApplication | undefined;
      if (lifecycle === "idle eviction") {
        vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
      }
      const client: StreamingMessageClient = {
        async *streamMessage() {
          yield { type: "text_delta", delta: "Attachment request completed." };
          yield { type: "complete", stopReason: "end_turn" };
        },
      };
      const openApplication = async () => {
        const result = new DaemonApplication({
          store,
          settings,
          log: () => {},
          createAgent: async (context) => {
            readTool = context.options.toolDecorators
              ?.find((tool) => tool.name === "Read")
              ?.decorate(createFileReadTool({ settings: context.options.settings }));
            const agent = await createDefaultNodeAgent({ ...context.options, client });
            agents.push(agent);
            return { agent, host: agent.host };
          },
        });
        await result.ready();
        return result;
      };

      try {
        application = await openApplication();
        const session = application.commands.createSession({ cwd: directory, model: settings.model });
        const image = await application.attachments.import({
          displayName: "original.png",
          declaredMediaType: "image/png",
          content: new Blob([imageBytes]).stream(),
        });
        const text = await application.attachments.import({
          displayName: "notes.txt",
          declaredMediaType: "text/plain",
          content: new Blob([notes]).stream(),
        });
        const admitted = await application.interactions.admitPrompt(session.id, {
          content: lifecycle === "edit and resend" ? "" : "Inspect these attachments.",
          attachments: [{ assetId: image.id }, { assetId: text.id }],
        });
        await expect(application.runControl.awaitRun(session.id, admitted.run!.id))
          .resolves.toMatchObject({ status: "completed" });

        if (missingImage) {
          const original = await application.attachments.resolveReadyContentPath(image.id);
          const withinFixture = relative(directory, original.path);
          if (!withinFixture || withinFixture.startsWith("..") || isAbsolute(withinFixture)) {
            throw new Error("Attachment fixture escaped temporary directory");
          }
          unlinkSync(original.path);
        }
        if (lifecycle === "daemon restart" || missingImage) {
          await application.close();
          store.close();
          store = new SessionStore({ path });
          application = await openApplication();
          await application.control.inspectRuntimeHooks(session.id);
        } else if (lifecycle === "idle eviction") {
          expect(application.control.runtimeSnapshot().warmAgentCount).toBe(1);
          await vi.advanceTimersByTimeAsync(31 * 60_000);
          expect(application.control.runtimeSnapshot().warmAgentCount).toBe(0);
          await application.control.inspectRuntimeHooks(session.id);
        } else {
          const continuation = await application.interactions.admitPrompt(session.id, {
            content: "Use the original image in the next step.",
          });
          await application.runControl.awaitRun(session.id, continuation.run!.id);
          const latest = store.conversations.listMessages(session.id)
            .filter((message) => message.role === "user").at(-1)!;
          const edited = await application.interactions.editLatestPrompt(session.id, {
            id: "edited-followup",
            sourceMessageId: latest.id,
            content: "Process the original image and use the notes.",
            traceId: "attachment-edit-regression",
          });
          await expect(application.runControl.awaitRun(session.id, edited.run!.id))
            .resolves.toMatchObject({ status: "completed" });
        }

        expect(agents).toHaveLength(2);
        const blocks = agents.at(-1)!.getHistory()
          .flatMap((message) => message.type === "user" && Array.isArray(message.content)
            ? message.content : []);
        const restoredImage = blocks.find((block) => block.type === "image");
        if (missingImage) {
          expect(restoredImage).toBeUndefined();
        } else {
          expect(restoredImage, "the rebuilt model history must include the original image").toBeDefined();
          if (restoredImage?.type !== "image") throw new Error("Original image was not restored");
          expect(readFileSync(restoredImage.source.path)).toEqual(imageBytes);
        }
        const restoredText = blocks.filter((block) => block.type === "text")
          .map((block) => block.text).join("\n");
        expect(restoredText).toContain(notes);
        expect(restoredText).toContain(`attachment://${image.id}/original.png`);
        expect(restoredText).toContain(`attachment://${text.id}/notes.txt`);

        const context = {
          cwd: directory,
          sessionId: session.id,
          settings,
          requestConfiguration: {
            model: settings.model,
            provider: settings.provider,
            apiFormat: settings.apiFormat,
          },
        };
        const rereadImage = await readTool!.execute({
          file_path: `attachment://${image.id}/original.png`,
        }, context);
        if (missingImage) {
          expect(rereadImage.isError).toBe(true);
          expect(rereadImage.content.every((block) => block.type !== "image")).toBe(true);
        } else {
          expect(rereadImage.isError).not.toBe(true);
          const imageBlock = rereadImage.content.find(
            (block): block is Extract<ContentBlock, { type: "image" }> => block.type === "image",
          );
          expect(imageBlock, "Read must reopen the authorized original after rebuilding").toBeDefined();
          expect(readFileSync(imageBlock!.source.path)).toEqual(imageBytes);
        }
        const rereadText = await readTool!.execute({
          file_path: `attachment://${text.id}/notes.txt`,
        }, context);
        expect(rereadText.isError).not.toBe(true);
        expect(rereadText.content).toContainEqual({ type: "text", text: expect.stringContaining(notes) });
      } finally {
        await application?.close().catch(() => {});
        store.close();
        if (lifecycle === "idle eviction") vi.useRealTimers();
        const withinTemp = relative(tmpdir(), directory);
        if (!withinTemp || withinTemp.startsWith("..") || isAbsolute(withinTemp)) {
          throw new Error("Fixture escaped temporary directory");
        }
        rmSync(directory, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
