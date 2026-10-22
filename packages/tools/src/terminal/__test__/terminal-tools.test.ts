import type { ToolContext, ToolResult } from "@vykor/core";
import type { AgentJobHost, JobSnapshot } from "@vykor/jobs";
import type {
  AgentTerminalHost,
  TerminalSessionInfo,
} from "@vykor/terminal";
import { describe, expect, it, vi } from "vitest";

import {
  createTerminalTools,
} from "../terminal-tools.js";
import { createJobTools } from "../../job/job-tools.js";

const terminal: TerminalSessionInfo = {
  id: "terminal-1",
  name: "dev server",
  projectId: "project-1",
  runtime: "local",
  source: "agent",
  sessionId: "session-1",
  status: "running",
  cwd: "D:\\code\\project",
  shell: "powershell.exe",
  cols: 100,
  rows: 30,
  createdAt: "2026-08-15T00:00:00.000Z",
};

describe("persistent terminal tools", () => {
  it("does not use a context host when no port was injected", async () => {
    const open = vi.fn(async () => terminal);
    const result = await createTerminalTools()[0]!.execute({}, createContext({ open }));
    expect(result.isError).toBe(true);
    expect(open).not.toHaveBeenCalled();
  });
  it("uses the injected host with its method receiver", async () => {
    const host = { terminal, async open() { return this.terminal; } };
    const tool = createTerminalTools(host)[0]!;
    const result = await tool.execute({}, { cwd: terminal.cwd, sessionId: "session-1" });
    expect(parseResult(result)).toMatchObject({ jobId: terminal.id });
  });
  it("starts a named command terminal and returns its job handle", async () => {
    const open = vi.fn(async (input) => ({ ...terminal, command: input.command }));
    const result = await executeTerminal({ name: "preview", command: "npm run dev" }, createContext({ open }));
    expect(parseResult(result)).toMatchObject({ kind: "terminal", action: "open", terminal: { command: "npm run dev" }, jobId: "terminal-1" });
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ command: "npm run dev" }));
  });

  it("opens a terminal scoped to the current durable session and cwd", async () => {
    const open = vi.fn(async () => terminal);
    const context = createContext({ open });

    const result = await executeTerminal(
      { name: "dev server" },
      context,
    );

    expect(open).toHaveBeenCalledWith({
      sessionId: "session-1",
      cwd: "D:\\code\\project",
      name: "dev server",
      cols: undefined,
      rows: undefined,
      shell: undefined,
    });
    expect(parseResult(result)).toMatchObject({
      kind: "terminal",
      action: "open",
      terminal: { id: "terminal-1" },
    });
  });

  it("fails before touching the host when no durable session exists", async () => {
    const open = vi.fn(async () => terminal);
    const result = await executeTerminal(
      {},
      {
        cwd: terminal.cwd,
        terminal: createHost({ open }),
      },
    );

    expect(result.isError).toBe(true);
    expect(open).not.toHaveBeenCalled();
  });

  it("returns the exact terminal id consumed by Job send and cancel", async () => {
    const open = vi.fn(async () => terminal);
    const send = vi.fn(async () => {});
    const cancel = vi.fn(async () => ({ ...terminalJob, status: "stopping" as const }));
    const context = {
      ...createContext({ open }),
      jobs: createJobs({ send, cancel }),
    };

    const opened = parseResult(await executeTerminal({}, context));
    const openedTerminal = opened.terminal as { id: string };
    await createJobTools(context.jobs).find(tool => tool.name === "JobSend")!.execute({ jobId: openedTerminal.id, data: "hello\n" }, context);
    await createJobTools(context.jobs).find(tool => tool.name === "JobCancel")!.execute({ jobId: openedTerminal.id, reason: "done" }, context);

    expect(openedTerminal.id).toBe("terminal-1");
    expect(send).toHaveBeenCalledWith({
      sessionId: "session-1",
      jobId: "terminal-1",
      data: "hello\n",
    });
    expect(cancel).toHaveBeenCalledWith({
      sessionId: "session-1",
      jobId: "terminal-1",
      reason: "done",
    });
  });
});

const terminalJob: JobSnapshot = {
  id: terminal.id,
  kind: "terminal",
  ownerSession: "session-1",
  status: "running",
  capabilities: { read: true, wait: true, send: true, cancel: true },
  cwd: terminal.cwd,
  startedAt: Date.parse(terminal.createdAt),
  updatedAt: Date.parse(terminal.createdAt),
};

function createContext(overrides: Partial<AgentTerminalHost>): ToolContext {
  return {
    cwd: terminal.cwd,
    sessionId: "session-1",
    terminal: createHost(overrides),
  };
}

function createHost(overrides: Partial<AgentTerminalHost>): AgentTerminalHost {
  return {
    open: async () => terminal,
    ...overrides,
  };
}

function createJobs(overrides: Partial<AgentJobHost>): AgentJobHost {
  return {
    list: async () => [terminalJob],
    read: async () => ({ text: "", cursor: 0, truncated: false, snapshot: terminalJob }),
    wait: async () => ({
      text: "",
      cursor: 0,
      truncated: false,
      snapshot: terminalJob,
      timedOut: false,
    }),
    send: async () => {},
    cancel: async () => terminalJob,
    ...overrides,
  };
}

function parseResult(
  result: ToolResult,
): Record<string, unknown> {
  const block = result.content[0];
  if (!block || block.type !== "text")
    throw new Error("Expected a text tool result");
  return JSON.parse(block.text) as Record<string, unknown>;
}

function executeTerminal(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  return createTerminalTools(context.terminal)[0]!.execute(input, context);
}
