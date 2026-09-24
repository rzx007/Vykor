import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type {
  Message,
  StreamEvent,
  StreamingMessageClient,
} from "@vykor/core";
import { MemoryManager } from "@vykor/memory";
import { getProjectMemoryDir } from "@vykor/core";
import { describe, expect, it } from "vitest";

import { createAgentMemoryRuntime, extractMemories } from "./memory-runtime.js";

it("retrieves persisted project memory on the first turn", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "vk-memory-first-turn-"));
  const previousConfigDir = process.env.VYKOR_CONFIG_DIR;
  process.env.VYKOR_CONFIG_DIR = cwd;
  try {
    const writer = new MemoryManager(1000, getProjectMemoryDir(cwd));
    const entry = await writer.add("The deployment region is ap-southeast-1");

    const memory = await createAgentMemoryRuntime(cwd, 5, "session-123");
    expect(await memory.retrieve("deployment region")).toContain("ap-southeast-1");
    await writer.update(entry.id, { metadata: { disabled: true } });
    expect(await memory.retrieve("deployment region")).toBeNull();
  } finally {
    if (previousConfigDir === undefined) delete process.env.VYKOR_CONFIG_DIR;
    else process.env.VYKOR_CONFIG_DIR = previousConfigDir;
    await rm(cwd, { recursive: true, force: true });
  }
});

const messages: Message[] = [
  { type: "user", content: "remember these durable facts" },
  { type: "assistant", content: "noted" },
];

function fakeClient(responseText: string, onStream?: () => void): StreamingMessageClient {
  return {
    async *streamMessage(): AsyncIterable<StreamEvent> {
      onStream?.();
      yield { type: "text_delta", delta: responseText.slice(0, 17) };
      yield { type: "text_delta", delta: responseText.slice(17) };
      yield { type: "complete", stopReason: "end_turn" };
    },
  };
}

describe("extractMemories", () => {
  it("writes only project memories backed by a user quote and keeps their source", async () => {
    const memoryDir = await mkdtemp(join(tmpdir(), "vk-memory-source-"));
    try {
      const result = await extractMemories({
        apiClient: fakeClient(JSON.stringify({ memories: [
          { title: "Decision", body: "Use SQLite for session state", scope: "project", evidence: "Use SQLite for session state" },
          { title: "Guess", body: "Production runs on Mars", scope: "project", evidence: "Production runs on Mars" },
          { title: "Private", body: "Private preference", scope: "private", evidence: "Use SQLite for session state" },
        ] })),
        model: "test-model",
        messages: [
          { type: "user", content: "Use SQLite for session state" },
          { type: "assistant", content: "Production runs on Mars" },
        ],
        manager: new MemoryManager(100, memoryDir),
        memoryDir,
        cwd: resolve("project"),
        sessionId: "session-123",
        automatic: true,
      });

      expect(result.titles).toEqual(["Decision"]);
      expect((await new MemoryManager(100, memoryDir).getAll()).map((entry) => entry.metadata)).toEqual([{
        source_type: "user_message",
        source_session_id: "session-123",
        source_message_sha256: createHash("sha256").update("Use SQLite for session state").digest("hex"),
      }]);
    } finally {
      await rm(memoryDir, { recursive: true, force: true });
    }
  });

  it("keeps manual remember support for private records", async () => {
    const response =
      "model preface\n" +
      JSON.stringify({
        memories: [
          { title: "Default", body: "default record", type: "unknown", scope: "unknown", evidence: "remember these durable facts" },
          { title: "Team", body: "shared record", scope: "team" },
          { title: "Private", body: "private record", type: "reference", scope: "private" },
          { title: "Fourth", body: "must be capped" },
        ],
      }) +
      "\nmodel epilogue";
    const manager = new MemoryManager(100);

    const result = await extractMemories({
      apiClient: fakeClient(response),
      model: "test-model",
      messages,
      manager,
      memoryDir: resolve("memory"),
      cwd: resolve("project"),
      sessionId: "session-123",
    });

    expect(result).toMatchObject({
      skipped: false,
      titles: ["Default", "Private"],
    });
    const entries = await manager.getAll();
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => [entry.name, entry.type, entry.scope])).toEqual([
      ["Default", "project", "project"],
      ["Private", "reference", "private"],
    ]);
    expect(entries.every((entry) => entry.metadata?.source_type === "manual_remember")).toBe(true);
  });

  it("skips model streaming when an assistant already wrote inside the memory directory", async () => {
    const cwd = resolve("project");
    const memoryDir = join(cwd, ".vykor", "memory");
    const wroteMemory: Message[] = [
      messages[0]!,
      {
        type: "assistant",
        content: "saved directly",
        toolUses: [
          {
            type: "tool_use",
            id: "write-memory",
            name: "Write",
            input: { file_path: join(".vykor", "memory", "manual.md") },
          },
        ],
      },
      {
        type: "tool_result",
        toolUseId: "write-memory",
        content: [{ type: "text", text: "Successfully wrote memory." }],
      },
    ];
    let streamCalls = 0;

    const result = await extractMemories({
      apiClient: fakeClient('{"memories":[]}', () => streamCalls++),
      model: "test-model",
      messages: wroteMemory,
      manager: new MemoryManager(100),
      memoryDir,
      cwd,
      sessionId: "session-123",
    });

    expect(result).toEqual({
      skipped: true,
      reason: "main conversation already wrote memory",
      writtenIds: [],
      titles: [],
    });
    expect(streamCalls).toBe(0);
  });

  it("does not let a successful Remember from a previous run suppress extraction", async () => {
    const cwd = resolve("project");
    const memoryDir = join(cwd, ".vykor", "memory");
    const remembered: Message[] = [
      { type: "user", content: "remember this project fact" },
      {
        type: "assistant",
        content: "saved through the managed tool",
        toolUses: [
          {
            type: "tool_use",
            id: "remember-project-fact",
            name: "Remember",
            input: { scope: "project", content: "Build commands use pnpm." },
          },
        ],
      },
      {
        type: "tool_result",
        toolUseId: "remember-project-fact",
        content: [{ type: "text", text: "Remembered this project information." }],
      },
      { type: "assistant", content: "I will remember that." },
      { type: "user", content: "new run with another durable fact" },
      { type: "assistant", content: "noted the new fact" },
    ];
    let streamCalls = 0;

    const result = await extractMemories({
      apiClient: fakeClient('{"memories":[]}', () => streamCalls++),
      model: "test-model",
      messages: remembered,
      manager: new MemoryManager(100),
      memoryDir,
      cwd,
      sessionId: "session-123",
    });

    expect(result).toEqual({
      skipped: true,
      reason: "no durable memories proposed",
      writtenIds: [],
      titles: [],
    });
    expect(streamCalls).toBe(1);
  });

  it("does not treat a failed Remember or an unrelated successful result as a memory write", async () => {
    const cwd = resolve("project");
    const memoryDir = join(cwd, ".vykor", "memory");
    const failedRemember: Message[] = [
      { type: "user", content: "remember this project fact" },
      {
        type: "assistant",
        content: "trying managed memory",
        toolUses: [
          {
            type: "tool_use",
            id: "remember-failed",
            name: "Remember",
            input: { scope: "project", content: "Build commands use pnpm." },
          },
          {
            type: "tool_use",
            id: "read-succeeded",
            name: "Read",
            input: { file_path: "README.md" },
          },
        ],
      },
      {
        type: "tool_result",
        toolUseId: "read-succeeded",
        content: [{ type: "text", text: "README contents" }],
      },
      {
        type: "tool_result",
        toolUseId: "remember-failed",
        content: [{ type: "text", text: "Error: memory write failed" }],
        isError: true,
      },
      { type: "assistant", content: "I could not save that memory." },
    ];
    let streamCalls = 0;

    const result = await extractMemories({
      apiClient: fakeClient('{"memories":[]}', () => streamCalls++),
      model: "test-model",
      messages: failedRemember,
      manager: new MemoryManager(100),
      memoryDir,
      cwd,
      sessionId: "session-123",
    });

    expect(result).toEqual({
      skipped: true,
      reason: "no durable memories proposed",
      writtenIds: [],
      titles: [],
    });
    expect(streamCalls).toBe(1);
  });

  it("skips extraction only after the current run has a matching successful Remember result", async () => {
    const cwd = resolve("project");
    const memoryDir = join(cwd, ".vykor", "memory");
    const successfulRemember: Message[] = [
      { type: "user", content: "remember this project fact" },
      {
        type: "assistant",
        content: "saving through managed memory",
        toolUses: [
          {
            type: "tool_use",
            id: "remember-succeeded",
            name: "Remember",
            input: { scope: "project", content: "Build commands use pnpm." },
          },
        ],
      },
      {
        type: "tool_result",
        toolUseId: "remember-succeeded",
        content: [{ type: "text", text: "Remembered this project information." }],
      },
      { type: "assistant", content: "I will remember that." },
    ];
    let streamCalls = 0;

    const result = await extractMemories({
      apiClient: fakeClient('{"memories":[]}', () => streamCalls++),
      model: "test-model",
      messages: successfulRemember,
      manager: new MemoryManager(100),
      memoryDir,
      cwd,
      sessionId: "session-123",
    });

    expect(result).toEqual({
      skipped: true,
      reason: "main conversation already wrote memory",
      writtenIds: [],
      titles: [],
    });
    expect(streamCalls).toBe(0);
  });
});
