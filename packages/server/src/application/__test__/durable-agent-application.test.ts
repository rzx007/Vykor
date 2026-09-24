import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  createDefaultNodeAgent,
  type VykorAgent,
} from "@vykor/agent-runtime";
import type {
  AgentBackgroundShellHost,
  AgentEvent,
  AgentEventContext,
  AgentEventInput,
  AgentRunHandle,
  AgentRunResult,
  CompactContextProvider,
  Message,
  StreamingMessageClient,
  ToolDefinition,
} from "@vykor/core";
import type { AgentJobHost } from "@vykor/jobs";
import { AttachmentBlobStore, LightOcrEngine, SessionStore } from "@vykor/services";

import type { CreateDaemonAgent } from "../../daemon/daemon-agent.js";
import { AttachmentService } from "../attachments/attachment-service.js";
import { ChannelApplicationService } from "../channel/channel-application-service.js";
import { DaemonApplication } from "../daemon-application.js";

const createEchoAgent: CreateDaemonAgent = async (context) => {
  let history: Message[] = [];
  let sequence = 0;
  let state: VykorAgent["state"] = "idle";

  const emit = async (
    input: AgentEventInput,
    eventContext: AgentEventContext,
  ): Promise<void> => {
    await context.options.onEvent?.({
      ...input,
      id: `event-${++sequence}`,
      sequence,
      occurredAt: new Date().toISOString(),
      context: eventContext,
    } as AgentEvent);
  };

  const agent: VykorAgent = {
    id: context.session.id,
    get state() {
      return state;
    },
    children: {
      get: () => undefined,
      getBySessionId: () => undefined,
      list: () => [],
    },
    subscribe: () => () => {},
    submitMessage(content, options = {}) {
      state = "running";
      const ids = options.ids!;
      const eventContext: AgentEventContext = {
        agentId: context.session.id,
        sessionId: context.session.id,
        inputId: ids.inputId,
        runId: ids.runId,
        traceId: ids.traceId,
      };
      let handle!: AgentRunHandle;
      const result = Promise.resolve().then(async (): Promise<AgentRunResult> => {
        const text = typeof content === "string" ? content : "";
        await emit(
          {
            type: "input.accepted",
            data: { content, delivery: options.delivery ?? "queue" },
          },
          eventContext,
        );
        await emit({ type: "run.started", data: {} }, eventContext);
        await emit(
          { type: "output.text.delta", data: { delta: `echo: ${text}` } },
          eventContext,
        );
        await emit(
          { type: "run.completed", data: { output: `echo: ${text}` } },
          eventContext,
        );
        state = "idle";
        return {
          status: "completed",
          output: `echo: ${text}`,
          history,
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      });
      handle = {
        id: ids.runId,
        inputId: ids.inputId,
        sessionId: context.session.id,
        traceId: ids.traceId,
        started: Promise.resolve({
          sessionId: context.session.id,
          inputId: ids.inputId,
          runId: ids.runId,
        }),
        result,
        steer: async () => {
          throw new Error("not used in this test");
        },
        interrupt: async () => {},
      };
      return handle;
    },
    async runMessage(content, options) {
      return await this.submitMessage(content, options).result;
    },
    getHistory: () => [...history],
    loadHistory: (messages) => {
      history = [...messages];
    },
    clear: () => {
      history = [];
    },
    setModel: () => {},
    setCompactContextProvider: () => {},
    compact: async () => ({
      history,
      beforeMessageCount: history.length,
      afterMessageCount: history.length,
    }),
    remember: async () => ({ skipped: true, writtenIds: [], titles: [] }),
    getUsage: () => ({ inputTokens: 0, outputTokens: 0 }),
    inspect: () => ({ model: context.session.model, tools: [], hooks: [], mcpServers: [] }),
    close: async () => {
      state = "closed";
    },
  };
  return agent;
};

describe("DaemonApplication", () => {
  it("rejects ready on attachment recovery failure and still releases ownership on close", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vykor-ready-recovery-"));
    const store = new SessionStore({ path: join(directory, "store.db") });
    const attachments = new AttachmentService({
      store: store.attachments,
      blobs: new AttachmentBlobStore({ root: join(directory, "attachments") }),
    });
    const recover = vi.spyOn(attachments, "recover").mockRejectedValueOnce(new Error("attachment recovery failed"));
    const application = new DaemonApplication({ store, attachments, settings: { model: "test" } as any, log: () => {} });
    await expect(application.ready()).rejects.toThrow("attachment recovery failed");
    await expect(application.close()).rejects.toThrow("attachment recovery failed");

    recover.mockResolvedValue({ failedImportIds: [], removedStagingNames: [], retainedStagingNames: [] });
    const replacement = new DaemonApplication({ store, attachments, settings: { model: "test" } as any, log: () => {} });
    await replacement.ready();
    await replacement.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  it("lets a real child Agent read its root attachment without authorizing another session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vykor-child-attachment-"));
    const store = new SessionStore({ path: join(dir, "store.db") });
    let attachmentReadTool: ToolDefinition | undefined;
    const events: AgentEvent[] = [];
    const agents = new Map<string, VykorAgent>();
    let assetId = "";
    const client: StreamingMessageClient = {
      async *streamMessage(params) {
        const latestUser = params.messages
          .filter((message) => message.type === "user")
          .at(-1);
        const userText = latestUser?.type === "user" && typeof latestUser.content === "string"
          ? latestUser.content
          : "";
        const usedTools = params.messages
          .filter((message) => message.type === "assistant")
          .flatMap((message) => message.type === "assistant" ? message.toolUses ?? [] : [])
          .map((toolUse) => toolUse.name);

        if (userText === "read the root attachment") {
          if (!usedTools.includes("Read")) {
            yield {
              type: "tool_use_start" as const,
              toolUse: {
                type: "tool_use" as const,
                id: "child-read-attachment",
                name: "Read",
                input: {
                  file_path: `attachment://${assetId}/root-notes.txt`,
                  offset: 1,
                  limit: 10,
                },
              },
            };
            yield { type: "complete" as const, stopReason: "tool_use" };
            return;
          }
          yield {
            type: "text_delta" as const,
            delta: `child read: ${latestToolResultText(params.messages)}`,
          };
          yield { type: "complete" as const, stopReason: "end_turn" };
          return;
        }

        if (userText === "try the other session attachment") {
          if (!usedTools.includes("Read")) {
            yield {
              type: "tool_use_start" as const,
              toolUse: {
                type: "tool_use" as const,
                id: "other-read-attachment",
                name: "Read",
                input: {
                  file_path: `attachment://${assetId}/root-notes.txt`,
                  offset: 1,
                  limit: 10,
                },
              },
            };
            yield { type: "complete" as const, stopReason: "tool_use" };
            return;
          }
          yield {
            type: "text_delta" as const,
            delta: `other session: ${latestToolResultText(params.messages)}`,
          };
          yield { type: "complete" as const, stopReason: "end_turn" };
          return;
        }

        if (!usedTools.includes("Agent")) {
          yield {
            type: "tool_use_start" as const,
            toolUse: {
              type: "tool_use" as const,
              id: "spawn-attachment-child",
              name: "Agent",
              input: {
                description: "Read the root attachment",
                prompt: "read the root attachment",
                cwd: dir,
              },
            },
          };
          yield { type: "complete" as const, stopReason: "tool_use" };
          return;
        }

        if (!usedTools.includes("JobWait")) {
          const spawned = JSON.parse(
            toolResultText(params.messages, "spawn-attachment-child"),
          ) as { jobId?: string };
          if (!spawned.jobId) throw new Error("Agent tool did not return a child job id");
          yield {
            type: "tool_use_start" as const,
            toolUse: {
              type: "tool_use" as const,
              id: "wait-attachment-child",
              name: "JobWait",
              input: { jobIds: [spawned.jobId], timeoutSeconds: 5 },
            },
          };
          yield { type: "complete" as const, stopReason: "tool_use" };
          return;
        }

        yield {
          type: "text_delta" as const,
          delta: `root received: ${latestToolResultText(params.messages)}`,
        };
        yield { type: "complete" as const, stopReason: "end_turn" };
      },
    };
    const application = new DaemonApplication({
      store,
      settings: {
        apiFormat: "anthropic",
        model: "child-attachment-e2e-model",
        maxTurns: 5,
        permission: { mode: "full_auto" },
        sandbox: { enabled: false },
        memory: { enabled: false },
      },
      createAgent: async (context) => {
        attachmentReadTool = context.options.toolOverrides?.find((tool) => tool.name === "Read");
        if (!attachmentReadTool) throw new Error("attachment Read override missing");
        const agent = await createDefaultNodeAgent({
          ...context.options,
          client,
          onEvent: async (event) => {
            events.push(event);
            await context.options.onEvent?.(event);
          },
        });
        agents.set(context.session.id, agent);
        return agent;
      },
      log: () => {},
    });

    try {
      await application.ready();
      const rootSession = application.commands.createSession({
        cwd: dir,
        model: "child-attachment-e2e-model",
      });
      const attachment = await application.attachments.import({
        displayName: "root-notes.txt",
        declaredMediaType: "text/plain",
        content: new Blob(["attachment visible through the child tool"]).stream(),
      });
      assetId = attachment.id;
      store.conversationTransactions.admitPrompt({
        id: "root-attachment-input",
        sessionId: rootSession.id,
        content: "",
        attachments: [{ assetId: attachment.id, intent: "tool_resource" }],
      });
      const rootAdmission = await application.interactions.admitPrompt(rootSession.id, {
        content: "delegate the attachment read",
      });
      await expect(
        application.runControl.awaitRun(rootSession.id, rootAdmission.run!.id),
      ).resolves.toMatchObject({
        status: "completed",
        output: expect.stringContaining("attachment visible through the child tool"),
      });
      const childCreated = events.find((event) => event.type === "child.created");
      if (!childCreated || childCreated.type !== "child.created") {
        throw new Error("real child lifecycle did not emit child.created");
      }
      const childSessionId = childCreated.data.sessionId;
      expect(events).toContainEqual(expect.objectContaining({
        type: "tool.started",
        context: expect.objectContaining({ sessionId: childSessionId }),
        data: expect.objectContaining({
          toolUse: expect.objectContaining({ name: "Read" }),
        }),
      }));

      const child = agents.get(rootSession.id)?.children.getBySessionId(childSessionId);
      expect(child).toBeDefined();
      await child!.close();
      expect(events).toContainEqual(expect.objectContaining({
        type: "child.closed",
        data: expect.objectContaining({ sessionId: childSessionId }),
      }));
      const closedChildRead = await attachmentReadTool!.execute(
        { file_path: `attachment://${attachment.id}/root-notes.txt`, offset: 1, limit: 1 },
        { cwd: dir, sessionId: childSessionId },
      );
      expect(closedChildRead).toMatchObject({ isError: true });
      expect((closedChildRead.content[0] as { text: string }).text)
        .toContain("attachment_resource_access_denied");

      const otherSession = application.commands.createSession({
        cwd: dir,
        model: "child-attachment-e2e-model",
      });
      const otherAdmission = await application.interactions.admitPrompt(otherSession.id, {
        content: "try the other session attachment",
      });
      await expect(
        application.runControl.awaitRun(otherSession.id, otherAdmission.run!.id),
      ).resolves.toMatchObject({
        status: "completed",
        output: expect.stringContaining("attachment_resource_access_denied"),
      });
    } finally {
      await application.close().catch(() => {});
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("把附件目录和成功 Run 写入的 session checkpoint 一起提供给 compact", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vykor-session-memory-"));
    const previousConfigDir = process.env.VYKOR_CONFIG_DIR;
    process.env.VYKOR_CONFIG_DIR = join(dir, "config");
    const store = new SessionStore({ path: join(dir, "store.db") });
    let compactContextProvider: CompactContextProvider | undefined;
    const application = new DaemonApplication({
      store,
      settings: {
        model: "test-model",
        apiFormat: "openai",
        maxTurns: 10,
        permission: { mode: "default" },
        memory: {
          enabled: true,
          sessionMemoryEnabled: true,
          autoExtractEnabled: false,
        },
      },
      createAgent: async (context) => ({
        ...(await createEchoAgent(context)),
        setCompactContextProvider: (provider) => {
          compactContextProvider = provider;
        },
      }),
      log: () => {},
    });

    try {
      await application.ready();
      const session = application.commands.createSession({
        cwd: dir,
        model: "test-model",
      });
      const admission = await application.interactions.admitPrompt(session.id, {
        content: "preserve this checkpoint detail",
      });
      await expect(
        application.runControl.awaitRun(session.id, admission.run!.id),
      ).resolves.toMatchObject({ status: "completed" });
      const attachment = await application.attachments.import({
        displayName: "phase-two-notes.txt",
        declaredMediaType: "text/plain",
        content: new Blob(["attachment checkpoint detail"]).stream(),
      });
      store.conversationTransactions.admitPrompt({
        id: "attachment-catalog-input",
        sessionId: session.id,
        content: "",
        attachments: [{ assetId: attachment.id, intent: "tool_resource" }],
      });

      expect(compactContextProvider).toBeDefined();
      const compactContext = await compactContextProvider!();
      expect(compactContext).toMatchObject({
        sessionMemory: expect.stringContaining("preserve this checkpoint detail"),
        supplementalSections: [{
          heading: "Conversation Attachments",
          content: expect.stringContaining(`assetId=${attachment.id}`),
        }],
      });
      expect(compactContext.supplementalSections?.[0]?.content)
        .toContain("Use Read with attachment://");
    } finally {
      await application.close().catch(() => {});
      store.close();
      if (previousConfigDir === undefined) delete process.env.VYKOR_CONFIG_DIR;
      else process.env.VYKOR_CONFIG_DIR = previousConfigDir;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("让模型工具创建的后台 shell 立即进入统一 Jobs，并可被取消", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vykor-background-shell-"));
    const store = new SessionStore({ path: join(dir, "store.db") });
    let backgroundShellHost: AgentBackgroundShellHost | undefined;
    let backgroundShellJobs: AgentJobHost | undefined;
    let terminalJobs: AgentJobHost | undefined;
    const application = new DaemonApplication({
      store,
      createAgent: async (context) => {
        const backgroundShell = context.options.capabilityOverrides?.backgroundShell;
        const terminal = context.options.capabilityOverrides?.terminal;
        if (backgroundShell && backgroundShell !== false) {
          backgroundShellHost = backgroundShell.value;
          backgroundShellJobs = backgroundShell.jobs;
        }
        if (terminal && terminal !== false) terminalJobs = terminal.jobs;
        return await createEchoAgent(context);
      },
      log: () => {},
    });

    try {
      await application.ready();
      const session = application.commands.createSession({
        cwd: process.cwd(),
        model: "test-model",
      });
      const admission = await application.interactions.admitPrompt(session.id, { content: "initialize" });
      await application.runControl.awaitRun(session.id, admission.run!.id);

      expect(backgroundShellJobs).not.toBe(terminalJobs);

      const created = await backgroundShellHost!.create({
        requestId: "tool:durable-shell-test",
        cwd: session.cwd,
        sessionId: session.id,
        command: `${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 1000)"`,
        description: "long-running test server",
      });

      await expect(backgroundShellJobs!.list({
        sessionId: session.id,
        includeFinished: true,
      })).resolves.toEqual([
        expect.objectContaining({ id: created.jobId, kind: "shell" }),
      ]);
      await expect(terminalJobs!.list({
        sessionId: session.id,
        includeFinished: true,
      })).resolves.toEqual([]);

      await expect(application.jobs.read({
        sessionId: session.id,
        jobId: created.jobId,
      })).resolves.toMatchObject({
        snapshot: {
          id: created.jobId,
          kind: "shell",
          status: "running",
          ownerSession: session.id,
        },
      });
      await expect(application.jobs.list({ sessionId: session.id })).resolves.toContainEqual(
        expect.objectContaining({ id: created.jobId, kind: "shell" }),
      );
      await expect(application.jobs.cancel({
        sessionId: session.id,
        jobId: created.jobId,
        reason: "test complete",
      })).resolves.toMatchObject({ id: created.jobId, status: "killed" });
    } finally {
      await application.close().catch(() => {});
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses attachment transactions for daemon imports and cached OCR", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vykor-attachment-boundary-"));
    const store = new SessionStore({ path: join(dir, "store.db") });
    const recognize = vi.spyOn(LightOcrEngine.prototype, "recognize").mockResolvedValue({
      lines: [{ text: "invoice 123", confidence: 1, box: [] }],
      timing: { totalMs: 1 },
      modelProfile: "small",
    });
    let imageToText: ToolDefinition | undefined;
    const application = new DaemonApplication({
      store,
      createAgent: async (context) => {
        imageToText = context.options.tools?.find((tool) => tool.name === "ImageToText");
        return await createEchoAgent(context);
      },
      log: () => {},
    });
    try {
      await application.ready();
      const session = application.commands.createSession({ cwd: dir, model: "test-model" });
      const admission = await application.interactions.admitPrompt(session.id, { content: "hello" });
      await application.runControl.awaitRun(session.id, admission.run!.id);
      expect(imageToText).toBeDefined();
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
        "base64",
      );
      const asset = await application.attachments.import({
        displayName: "invoice.png",
        declaredMediaType: "image/png",
        content: new Blob([png]).stream(),
      });
      store.conversationTransactions.admitPrompt({ sessionId: session.id, content: "", attachments: [{ assetId: asset.id }] });
      const first = await imageToText!.execute({ attachment_id: asset.id }, { cwd: dir, sessionId: session.id });
      const cached = await imageToText!.execute({ attachment_id: asset.id }, { cwd: dir, sessionId: session.id });
      expect(first.isError).not.toBe(true);
      expect(cached.isError).not.toBe(true);
      expect(cached.content).toEqual(first.content);
      expect(cached.metadata).toMatchObject({ attachmentOcr: { cached: true } });
      expect(recognize).toHaveBeenCalledOnce();
      expect(store.attachments.listAttachmentRepresentations(asset.id)).toMatchObject([
        { status: "completed", text: "invoice 123" },
      ]);
    } finally {
      await application.close();
      store.close();
      recognize.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("不经过 HTTP 也能完成创建会话、提交输入、运行和读取结果", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vykor-application-"));
    const store = new SessionStore({ path: join(dir, "store.db") });
    const application = new DaemonApplication({
      store,
      createAgent: createEchoAgent,
      log: () => {},
    });
    try {
      expect(() =>
        application.commands.createSession({
          cwd: process.cwd(),
          model: "too-early",
        }),
      ).toThrow("Durable Agent Application is not ready");
      await application.ready();
      const session = application.commands.createSession({
        cwd: process.cwd(),
        model: "test-model",
      });
      const admission = await application.interactions.admitPrompt(session.id, {
        content: "hello",
      });

      expect(admission.run).toBeDefined();
      await expect(
        application.runControl.awaitRun(session.id, admission.run!.id),
      ).resolves.toEqual({ status: "completed", output: "echo: hello" });
      expect(application.queries.getSessionState(session.id)).toMatchObject({
        session: { id: session.id },
        runs: [{ id: admission.run!.id, status: "completed" }],
      });
      expect(
        application.events.list({ sessionId: session.id }).length,
      ).toBeGreaterThan(0);

      await application.close();
      await application.close();
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("让不同外部聊天使用不同 Session，并对重复平台消息复用同一个 Run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vykor-channel-application-"));
    const path = join(dir, "store.db");
    let store = new SessionStore({ path });
    let application = new DaemonApplication({
      store,
      createAgent: createEchoAgent,
      log: () => {},
    });
    const message = {
      connector: "feishu",
      accountId: "app-1",
      externalMessageId: "message-1",
      senderId: "user-1",
      content: "hello from bot",
      cwd: process.cwd(),
      model: "test-model",
    };
    try {
      await application.ready();
      const [first, duplicate] = await Promise.all([
        application.channels.handleMessage({
          ...message,
          chatId: "chat-1",
        }),
        application.channels.handleMessage({
          ...message,
          chatId: "chat-1",
        }),
      ]);
      const otherChat = await application.channels.handleMessage({
        ...message,
        externalMessageId: "message-2",
        chatId: "chat-2",
      });

      expect(duplicate.duplicate).toBe(true);
      expect(duplicate.delivery.runId).toBe(first.delivery.runId);
      expect(duplicate.delivery.id).toBe(first.delivery.id);
      expect(otherChat.conversation.sessionId).not.toBe(
        first.conversation.sessionId,
      );
      await expect(
        application.channels.handleMessage({
          ...message,
          chatId: "chat-1",
          content: "changed body with the same platform id",
        }),
      ).rejects.toThrow("Prompt id is already used");

      await application.commands.archiveSessionTree(
        first.conversation.sessionId,
      );
      const afterArchive = await application.channels.handleMessage({
        ...message,
        chatId: "chat-1",
        externalMessageId: "message-3",
      });
      expect(afterArchive.conversation.sessionId).not.toBe(
        first.conversation.sessionId,
      );

      await application.close();
      store.close();
      store = new SessionStore({ path });
      application = new DaemonApplication({
        store,
        createAgent: createEchoAgent,
        log: () => {},
      });
      await application.ready();
      expect(
        application.channels.status({ connector: "feishu" }).conversations,
      ).toContainEqual(
        expect.objectContaining({
          chatId: "chat-1",
          sessionId: afterArchive.conversation.sessionId,
        }),
      );
    } finally {
      await application.close().catch(() => {});
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("重投递带附件的渠道消息时不重复导入、不触发 prompt_id_conflict", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vykor-channel-attachment-redelivery-"));
    const store = new SessionStore({ path: join(dir, "store.db") });
    const application = new DaemonApplication({
      store,
      createAgent: createEchoAgent,
      log: () => {},
    });
    const bytes = new Uint8Array([1, 2, 3, 4]);
    let downloadCount = 0;
    let importCount = 0;
    const channels = new ChannelApplicationService({
      sessionQueries: {
        getInput: (inputId) => application.store.conversations.getInput(inputId),
        getSession: (sessionId) => application.store.sessions.get(sessionId),
      },
      channels: application.store.channels,
      sessionCommands: application.commands,
      sessionInteractions: application.interactions,
      runControl: application.runControl,
      log: () => {},
      attachments: {
        import: async (input) => {
          importCount += 1;
          return application.attachments.import(input);
        },
      },
      downloadChannelAttachment: async () => {
        downloadCount += 1;
        return {
          stream: new Blob([bytes]).stream(),
          mimeType: "image/png",
        };
      },
    });
    const message = {
      connector: "feishu",
      accountId: "app-1",
      chatId: "chat-attachment",
      externalMessageId: "msg-attachment-1",
      senderId: "user-1",
      content: "",
      cwd: process.cwd(),
      model: "test-model",
      metadata: { attachments: [{ type: "image", externalId: "img_v2_9" }] },
    };
    try {
      await application.ready();
      const first = await channels.handleMessage({ ...message });
      const second = await channels.handleMessage({ ...message });

      expect(second.duplicate).toBe(true);
      expect(second.delivery.runId).toBe(first.delivery.runId);
      // 只下载/导入一次；重投递复用首次的附件引用。
      expect(downloadCount).toBe(1);
      expect(importCount).toBe(1);
    } finally {
      await application.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function latestToolResultText(
  messages: Parameters<StreamingMessageClient["streamMessage"]>[0]["messages"],
): string {
  const latest = messages.filter((message) => message.type === "tool_result").at(-1);
  if (!latest || latest.type !== "tool_result") return "";
  return latest.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function toolResultText(
  messages: Parameters<StreamingMessageClient["streamMessage"]>[0]["messages"],
  toolUseId: string,
): string {
  const result = messages.find((message) =>
    message.type === "tool_result" && message.toolUseId === toolUseId
  );
  if (!result || result.type !== "tool_result") return "";
  return result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}
