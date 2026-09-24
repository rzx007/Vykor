import { createHash } from "node:crypto";

import type { Message, StreamingMessageClient } from "@vykor/core";
import { getProjectMemoryDir } from "@vykor/core";
import {
  buildMemoryExtractionPrompt,
  isMemoryWriteToolCall,
  MemoryManager,
  parseMemoryExtractionRecords,
  selectWritableMemoryExtractionRecords,
} from "@vykor/memory";

import type { FrameworkAgentRunToolActivity } from "./framework-agent-run.js";

export interface AgentRememberResult {
  skipped: boolean;
  reason?: string;
  writtenIds: string[];
  titles: string[];
}

export interface AgentMemoryRuntime {
  manager: MemoryManager;
  directory: string;
  retrieve(userInput: string): Promise<string | null>;
  remember(
    messages: Message[],
    apiClient: StreamingMessageClient,
    model: string,
    completedRunToolActivity?: FrameworkAgentRunToolActivity,
    automatic?: boolean,
  ): Promise<AgentRememberResult>;
}

export async function createAgentMemoryRuntime(
  cwd: string,
  maxFiles: number,
  sessionId: string,
): Promise<AgentMemoryRuntime> {
  const directory = getProjectMemoryDir(cwd);
  const manager = new MemoryManager(1000, directory);
  await manager.getAll();

  return {
    manager,
    directory,
    async retrieve(userInput) {
      await manager.reload();
      const selected = manager.selectRelevantForPrompt(maxFiles, userInput);
      if (selected.ids.length > 0) await manager.markMemoryUsed(selected.ids);
      return selected.text || null;
    },
    async remember(messages, apiClient, model, completedRunToolActivity, automatic) {
      return await extractMemories({
        apiClient,
        model,
        messages,
        manager,
        memoryDir: directory,
        cwd,
        sessionId,
        completedRunToolActivity,
        automatic,
      });
    },
  };
}

export async function extractMemories(options: {
  apiClient: StreamingMessageClient;
  model: string;
  messages: Message[];
  manager: MemoryManager;
  memoryDir: string;
  cwd: string;
  sessionId: string;
  automatic?: boolean;
  completedRunToolActivity?: FrameworkAgentRunToolActivity;
}): Promise<AgentRememberResult> {
  if (options.messages.length < 2) {
    return { skipped: true, reason: "not enough messages", writtenIds: [], titles: [] };
  }
  if (hasMemoryWrites(
    options.completedRunToolActivity ??
      toolActivityFromMessages(currentRunMessages(options.messages)),
    options.memoryDir,
    options.cwd,
  )) {
    return {
      skipped: true,
      reason: "main conversation already wrote memory",
      writtenIds: [],
      titles: [],
    };
  }

  await options.manager.reload();
  const manifest = (await options.manager.getAll())
    .slice(0, 80)
    .map((entry) => `- ${entry.name ?? entry.id}: ${(entry.description ?? "").slice(0, 80)}`)
    .join("\n");
  const transcript = options.messages.slice(-12).map(summarizeMessage);
  const prompt = buildMemoryExtractionPrompt(manifest, transcript);

  let finalText = "";
  for await (const event of options.apiClient.streamMessage({
    model: options.model,
    messages: [{ type: "user", content: prompt }],
    system: [
      "You maintain Vykor durable memory.",
      "Save only stable, future-useful facts that are not derivable from current files, git history, or documentation.",
      "Do not save secrets. If nothing is worth saving, return {\"memories\": []}.",
    ].join("\n"),
    maxTokens: 2048,
    tools: [],
  })) {
    if (event.type === "text_delta") finalText += event.delta;
    if (event.type === "complete") break;
  }

  const records = selectWritableMemoryExtractionRecords(
    parseMemoryExtractionRecords(finalText),
  );
  const userTexts = options.messages.slice(-12)
    .filter((message) => message.type === "user")
    .map((message) => typeof message.content === "string"
      ? message.content
      : summarizeContent(message.content));
  const writtenIds: string[] = [];
  const titles: string[] = [];
  for (const record of records) {
    const quote = record.evidence?.trim();
    const sourceText = quote && userTexts.find((text) => text.includes(quote));
    if (options.automatic && (record.scope !== "project" || !sourceText)) continue;
    const entry = await options.manager.add(record.body, record.tags, {
      source_type: options.automatic ? "user_message" : "manual_remember",
      source_session_id: options.sessionId,
      ...(sourceText ? { source_message_sha256: createHash("sha256").update(sourceText).digest("hex") } : {}),
    }, {
      name: record.title,
      description: record.description,
      type: record.memoryType,
      scope: record.scope,
    });
    writtenIds.push(entry.id);
    titles.push(record.title);
  }

  return writtenIds.length > 0
    ? { skipped: false, writtenIds, titles }
    : { skipped: true, reason: "no durable memories proposed", writtenIds: [], titles: [] };
}

function hasMemoryWrites(
  activity: FrameworkAgentRunToolActivity,
  memoryDir: string,
  cwd: string,
): boolean {
  const memoryWriteIds = new Set<string>();
  for (const toolUse of activity.toolUses) {
    const input = toolUse.input as Record<string, unknown>;
    if (
      toolUse.name === "Remember" ||
      isMemoryWriteToolCall(toolUse.name, input, memoryDir, cwd)
    ) {
      memoryWriteIds.add(toolUse.id);
    }
  }
  return activity.toolResults.some(
    (result) =>
      result.isError !== true && memoryWriteIds.has(result.toolUseId),
  );
}

function toolActivityFromMessages(
  messages: Message[],
): FrameworkAgentRunToolActivity {
  const activity: FrameworkAgentRunToolActivity = {
    toolUses: [],
    toolResults: [],
  };
  for (const message of messages) {
    if (message.type === "assistant") {
      for (const toolUse of message.toolUses ?? []) {
        activity.toolUses.push({
          id: toolUse.id,
          name: toolUse.name,
          input: toolUse.input,
        });
      }
    } else if (message.type === "tool_result") {
      activity.toolResults.push({
        toolUseId: message.toolUseId,
        isError: message.isError,
      });
    }
  }
  return activity;
}

function currentRunMessages(messages: Message[]): Message[] {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.type === "user") return messages.slice(index);
  }
  return messages;
}

function summarizeMessage(message: Message): string {
  if (message.type === "tool_result") return `tool: ${summarizeContent(message.content)}`;
  const role = message.type;
  const text = typeof message.content === "string" ? message.content : summarizeContent(message.content);
  const tools = message.type === "assistant" && message.toolUses?.length
    ? ` tools=${message.toolUses.map((tool) => tool.name).join(",")}`
    : "";
  return `${role}: ${text.split(/\s+/).filter(Boolean).join(" ").slice(0, 1200)}${tools}`;
}

function summarizeContent(content: Array<{ type: string; text?: string }>): string {
  return content.map((block) => block.type === "text" ? block.text ?? "" : `[${block.type}]`).join(" ");
}
