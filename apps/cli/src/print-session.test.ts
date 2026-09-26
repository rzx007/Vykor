import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

vi.mock("./ensure-daemon.js", () => ({
  ensureLocalDaemon: vi.fn(async () => ({
    url: "http://daemon.test",
    token: "tok",
    pid: 1,
  })),
}));

vi.mock("@vykor/client", async () => {
  const actual = await vi.importActual<typeof import("@vykor/client")>("@vykor/client");
  return {
    ...actual,
    VykorClient: vi.fn(),
  };
});

import { VykorClient } from "@vykor/client";
import { ensureLocalDaemon } from "./ensure-daemon.js";
import { buildPrintSessionMetadata, runPrintSession } from "./print-session.js";

it("marks an inherited CLI effort so later settings edits can affect the session", () => {
  const settings = {
    model: "model-a", effort: "low", permission: { mode: "default" }, maxTurns: 50,
  } as never;
  expect(buildPrintSessionMetadata(settings, {} as never)).toMatchObject({
    runtimeDefaultFields: ["effort", "maxTurns", "systemPrompt"],
  });
  expect(buildPrintSessionMetadata(settings, { effort: "high" } as never))
    .toMatchObject({ runtimeDefaultFields: ["maxTurns", "systemPrompt"] });
  expect(buildPrintSessionMetadata(settings, { maxTurns: 5 } as never))
    .toMatchObject({ runtimeDefaultFields: ["effort", "systemPrompt"] });
  expect(buildPrintSessionMetadata(settings, { systemPrompt: "custom" } as never))
    .toMatchObject({ runtimeDefaultFields: ["effort", "maxTurns"] });
});

function printClient(resources: {
  create: ReturnType<typeof vi.fn>;
  admitPrompt: ReturnType<typeof vi.fn>;
  getState: ReturnType<typeof vi.fn>;
  reply: ReturnType<typeof vi.fn>;
  stream: () => AsyncIterable<unknown>;
}) {
  return {
    sessions: {
      create: resources.create,
      admitPrompt: resources.admitPrompt,
      getState: resources.getState,
    },
    permissions: { reply: resources.reply },
    events: {
      list: vi.fn(async () => []),
      stream: resources.stream,
    },
  };
}

describe("runPrintSession", () => {
  let exitSpy: MockInstance<(code?: string | number | null) => never>;

  beforeEach(() => {
    delete process.env.VYKOR_COORDINATOR_MODE;
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    delete process.env.VYKOR_COORDINATOR_MODE;
    exitSpy.mockRestore();
    vi.clearAllMocks();
  });

  it("creates a session, admits prompt, renders text, and exits on run completion", async () => {
    const writes: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as never);

    const session = {
      id: "s1",
      cwd: "/tmp",
      title: "print",
      model: "m",
      status: "idle",
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    };
    const run = {
      id: "r1",
      sessionId: "s1",
      status: "running",
      metadata: {},
      createdAt: 2,
      updatedAt: 2,
    };
    const completedRun = { ...run, status: "completed", updatedAt: 4 };
    const textPart = {
      id: "p1",
      sessionId: "s1",
      messageId: "m1",
      seq: 1,
      type: "text",
      status: "running",
      text: "",
      metadata: {},
      createdAt: 3,
      updatedAt: 3,
    };

    const Client = VykorClient as unknown as ReturnType<typeof vi.fn>;
    Client.mockImplementation(() => printClient({
      create: vi.fn(async () => session),
      admitPrompt: vi.fn(async () => ({
        input: { id: "i1", sessionId: "s1", seq: 1, delivery: "queue", items: [{ type: "text" as const, text: "hi" }],
        content: "hi", metadata: {}, createdAt: 2 },
        run,
      })),
      getState: vi.fn(async () => ({
        cursor: 1,
        session,
        inputs: [],
        messages: [],
        parts: [],
        runs: [],
        attempts: [],
        permissions: [],
      })),
      reply: vi.fn(),
      stream: async function* () {
        yield {
          id: "e2",
          seq: 2,
          type: "session.run.updated",
          schemaVersion: 1,
          sessionId: "s1",
          createdAt: 2,
          payload: { run },
        };
        yield {
          id: "e3",
          seq: 3,
          type: "session.message.part.delta",
          schemaVersion: 1,
          sessionId: "s1",
          createdAt: 3,
          payload: {
            sessionId: "s1",
            messageId: "m1",
            partId: "p1",
            field: "text",
            delta: "hello from daemon",
          },
        };
        yield {
          id: "e4",
          seq: 4,
          type: "session.message.part.updated",
          schemaVersion: 1,
          sessionId: "s1",
          createdAt: 4,
          payload: { part: { ...textPart, text: "hello from daemon", status: "completed" } },
        };
        yield {
          id: "e5",
          seq: 5,
          type: "session.run.updated",
          schemaVersion: 1,
          sessionId: "s1",
          createdAt: 5,
          payload: { run: completedRun },
        };
      },
    }));

    await runPrintSession(
      { model: "m", outputStyle: "default" } as never,
      "hi",
      { model: "m", cwd: "/tmp", daemonUrl: "https://daemon.example/", daemonToken: "remote-token" },
    );

    expect(Client.mock.results[0]!.value.sessions.admitPrompt).toHaveBeenCalledWith("s1", { id: expect.any(String), items: [{ type: "text", text: "hi" }] });
    expect(writes.join("")).toContain("hello from daemon");
    expect(exitSpy).not.toHaveBeenCalled();
    expect(ensureLocalDaemon).not.toHaveBeenCalled();
    expect(Client).toHaveBeenCalledWith({ baseUrl: "https://daemon.example", token: "remote-token" });
    stdoutSpy.mockRestore();
  });

  it("renders completed snapshot output when a fast daemon run finishes before SSE delivers events", async () => {
    const writes: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as never);

    const session = {
      id: "s1",
      cwd: "/tmp",
      title: "print",
      model: "m",
      status: "idle",
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    };
    const run = {
      id: "r1",
      sessionId: "s1",
      inputId: "i1",
      status: "completed",
      metadata: {},
      createdAt: 2,
      updatedAt: 4,
    };
    const userMessage = {
      id: "m-user",
      sessionId: "s1",
      seq: 1,
      role: "user",
      runId: "r1",
      inputId: "i1",
      metadata: {},
      createdAt: 2,
      updatedAt: 2,
    };
    const assistantMessage = {
      id: "m-assistant",
      sessionId: "s1",
      seq: 2,
      role: "assistant",
      runId: "r1",
      metadata: {},
      createdAt: 3,
      updatedAt: 4,
    };
    const completedSnapshot = {
      cursor: 5,
      session,
      inputs: [{ id: "i1", sessionId: "s1", seq: 1, delivery: "queue", items: [{ type: "text" as const, text: "hi" }],
      content: "hi", metadata: {}, createdAt: 2 }],
      messages: [userMessage, assistantMessage],
      parts: [
        {
          id: "p-user",
          sessionId: "s1",
          messageId: "m-user",
          seq: 1,
          type: "text",
          status: "completed",
          text: "hi",
          metadata: {},
          createdAt: 2,
          updatedAt: 2,
        },
        {
          id: "p-assistant",
          sessionId: "s1",
          messageId: "m-assistant",
          seq: 1,
          type: "text",
          status: "completed",
          text: "fast snapshot output",
          metadata: {},
          createdAt: 3,
          updatedAt: 4,
        },
      ],
      runs: [run],
      attempts: [],
      permissions: [],
    };
    const Client = VykorClient as unknown as ReturnType<typeof vi.fn>;
    Client.mockImplementation(() => printClient({
      create: vi.fn(async () => session),
      admitPrompt: vi.fn(async () => ({
        input: { id: "i1", sessionId: "s1", seq: 1, delivery: "queue", items: [{ type: "text" as const, text: "hi" }],
        content: "hi", metadata: {}, createdAt: 2 },
        run: { ...run, status: "running", updatedAt: 2 },
      })),
      getState: vi.fn()
        .mockResolvedValueOnce({
          cursor: 1,
          session,
          inputs: [],
          messages: [],
          parts: [],
          runs: [],
          attempts: [],
          permissions: [],
        })
        .mockResolvedValue(completedSnapshot),
      reply: vi.fn(),
      stream: async function* () {},
    }));

    await runPrintSession(
      { model: "m", outputStyle: "default" } as never,
      "hi",
      { model: "m", cwd: "/tmp" },
    );

    expect(writes.join("")).toContain("fast snapshot output");
    expect(writes.join("")).not.toContain("hi");
    expect(exitSpy).not.toHaveBeenCalled();
    stdoutSpy.mockRestore();
  });

  it("prints effective JSON and keeps incomplete-usage notice off text stdout", async () => {
    const writes: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as never);
    const errors: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      errors.push(String(chunk));
      return true;
    }) as never);

    const session = {
      id: "s1",
      cwd: "/tmp",
      title: "print",
      model: "m",
      status: "idle",
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    };
    const run = {
      id: "r1",
      sessionId: "s1",
      inputId: "i1",
      status: "completed",
      metadata: { modelUsage: { incomplete: true, unknownAttempts: 1, partialAttempts: 0 } },
      createdAt: 2,
      updatedAt: 4,
    };
    const completedSnapshot = {
      cursor: 5,
      session,
      inputs: [{ id: "i1", sessionId: "s1", seq: 1, delivery: "queue", items: [{ type: "text" as const, text: "hi" }],
      content: "hi", metadata: {}, createdAt: 2 }],
      messages: [
        {
          id: "m-assistant",
          sessionId: "s1",
          seq: 1,
          role: "assistant",
          runId: "r1",
          metadata: {},
          createdAt: 3,
          updatedAt: 4,
        },
      ],
      parts: [
        {
          id: "p-old",
          sessionId: "s1",
          messageId: "m-assistant",
          seq: 1,
          type: "text",
          status: "completed",
          text: "old json text",
          metadata: { modelGeneration: { generationId: "g1", attempt: 1, superseded: true } },
          createdAt: 3,
          updatedAt: 4,
        },
        {
          id: "p-assistant",
          sessionId: "s1",
          messageId: "m-assistant",
          seq: 2,
          type: "text",
          status: "completed",
          text: "snapshot-only json text",
          metadata: {},
          createdAt: 3,
          updatedAt: 4,
        },
      ],
      runs: [run],
      attempts: [{ id: "a1", runId: "r1", sequence: 1, status: "completed", inputTokens: 20, outputTokens: 10, createdAt: 3, updatedAt: 4 }],
      permissions: [],
    };
    const Client = VykorClient as unknown as ReturnType<typeof vi.fn>;
    Client.mockImplementation(() => printClient({
      create: vi.fn(async () => session),
      admitPrompt: vi.fn(async () => ({
        input: { id: "i1", sessionId: "s1", seq: 1, delivery: "queue", items: [{ type: "text" as const, text: "hi" }],
        content: "hi", metadata: {}, createdAt: 2 },
        run: { ...run, status: "running", updatedAt: 2 },
      })),
      getState: vi.fn()
        .mockResolvedValueOnce({
          cursor: 1,
          session,
          inputs: [],
          messages: [],
          parts: [],
          runs: [],
          attempts: [],
          permissions: [],
        })
        .mockResolvedValue(completedSnapshot),
      reply: vi.fn(),
      stream: async function* () {},
    }));

    await runPrintSession(
      { model: "m", outputStyle: "default" } as never,
      "hi",
      { model: "m", cwd: "/tmp", outputFormat: "json" },
    );

    expect(JSON.parse(writes.join(""))).toMatchObject({ sessionId: "s1", runId: "r1", status: "completed", text: "snapshot-only json text", usage: { inputTokens: 20, outputTokens: 10, incomplete: true, unknownAttempts: 1 } });
    writes.length = 0;
    await runPrintSession(
      { model: "m", outputStyle: "default" } as never,
      "hi",
      { model: "m", cwd: "/tmp", outputFormat: "text" },
    );
    expect(writes.join("")).toBe("snapshot-only json text\n");
    expect(errors.join("")).toContain("已知用量：20 输入 / 10 输出；部分请求用量未知");
    expect(errors.join("").match(/部分请求用量未知/g)).toHaveLength(1);
    expect(exitSpy).not.toHaveBeenCalled();
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it("writes permissionMode and maxTurns into createSession metadata", async () => {
    const createSession = vi.fn(async () => ({
      id: "s1",
      cwd: "/tmp",
      title: "print",
      model: "m",
      status: "idle",
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    }));
    const Client = VykorClient as unknown as ReturnType<typeof vi.fn>;
    Client.mockImplementation(() => printClient({
      create: createSession,
      admitPrompt: vi.fn(async () => ({
        input: { id: "i1", sessionId: "s1", seq: 1, delivery: "queue", items: [{ type: "text" as const, text: "hi" }],
        content: "hi", metadata: {}, createdAt: 2 },
        run: { id: "r1", sessionId: "s1", status: "completed", metadata: {}, createdAt: 2, updatedAt: 2 },
      })),
      getState: vi.fn(async () => ({
        cursor: 0,
        session: {
          id: "s1",
          cwd: "/tmp",
          title: "print",
          model: "m",
          status: "idle",
          metadata: {},
          createdAt: 1,
          updatedAt: 1,
        },
        inputs: [],
        messages: [],
        parts: [],
        runs: [],
        attempts: [],
        permissions: [],
      })),
      reply: vi.fn(),
      stream: async function* () {
        yield {
          id: "e1",
          seq: 1,
          type: "session.run.updated",
          schemaVersion: 1,
          sessionId: "s1",
          createdAt: 3,
          payload: {
            run: { id: "r1", sessionId: "s1", status: "completed", metadata: {}, createdAt: 2, updatedAt: 3 },
          },
        };
      },
    }));

    await runPrintSession(
      { model: "m", outputStyle: "default", permission: { mode: "default" }, maxTurns: 50 } as never,
      "hi",
      {
        model: "m",
        cwd: "/tmp",
        permissionMode: "plan",
        coordinator: true,
        maxTurns: 7,
        systemPrompt: "be brief",
        allowedTools: "Read,Glob",
        effort: "low",
        pluginsEnabled: false,
      },
    );

    expect(createSession).toHaveBeenCalledWith({
      cwd: "/tmp",
      model: "m",
      title: "print",
      metadata: {
        runtime: {
          model: "m",
          permissionMode: "plan",
          maxTurns: 7,
          systemPrompt: "be brief",
          allowedTools: ["Read", "Glob"],
          effort: "low",
          sessionMode: "coordinator",
          pluginsEnabled: false,
        },
      },
    });
  });
});
