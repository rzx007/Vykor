import { describe, expect, it, vi } from "vitest";

import { backgroundShellCreateTool, createBackgroundShellTool } from "../background-shell-tools.js";

const shellDescriptor = {
  family: "powershell", dialect: "windows-powershell",
  executable: "powershell.exe", argsPrefix: ["-NoLogo", "-NoProfile", "-Command"],
  displayName: "Windows PowerShell 5.1", version: "5.1",
  pathStyle: "windows", tempDir: "C:\\Temp",
  capabilities: { conditionalAndOr: false, supportsLoginShell: false },
} as const;

describe("BackgroundShellCreate", () => {
  it("is discoverable for long-running bash or shell commands", () => {
    expect(backgroundShellCreateTool.description).toMatch(/long-running/i);
    expect(backgroundShellCreateTool.description).toMatch(/bash|shell/i);
    expect(backgroundShellCreateTool.description).toContain("JobWait");
    expect(backgroundShellCreateTool.description).toContain("JobRead");
  });

  it("exposes only background-shell inputs", () => {
    const schema = backgroundShellCreateTool.inputSchema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(Object.keys(schema.properties)).toEqual(["description", "command"]);
    expect(schema.required).toEqual(["description", "command"]);
  });

  it("rejects the removed Agent creation shape", async () => {
    const result = await backgroundShellCreateTool.execute(
      { type: "local_agent", description: "review", prompt: "review this" },
      { cwd: process.cwd() },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("Use Agent") });
  });

  it("delegates creation to the host and returns its durable job id", async () => {
    const create = vi.fn(async () => ({ jobId: "task-durable", label: "print output" }));
    const tool = createBackgroundShellTool(shellDescriptor);
    const result = await tool.execute(
      { description: "print output", command: 'node -e "process.stdout.write(\'ok\')"' },
      {
        cwd: "/repo",
        sessionId: "session-1",
        toolCallId: "call-1",
        settings: { model: "test" } as any,
        backgroundShell: { create },
      },
    );
    const payload = JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>;
    expect(payload).toMatchObject({
      kind: "job",
      action: "created",
      jobKind: "shell",
      label: "print output",
      jobId: "task-durable",
    });
    expect(result).toMatchObject({ executionState: "completed", compactSummary: expect.stringContaining("task-durable") });
    expect(result.compactSummary).not.toContain("process.stdout");
    expect(create).toHaveBeenCalledWith({
      requestId: "tool:call-1",
      cwd: "/repo",
      sessionId: "session-1",
      command: 'node -e "process.stdout.write(\'ok\')"',
      description: "print output",
      settings: { model: "test" },
      shellDescriptor,
    });
    expect(tool.description).toContain("Windows PowerShell 5.1");
  });

  it("fails before launching when the tool call has no stable identity", async () => {
    const create = vi.fn();
    const result = await backgroundShellCreateTool.execute(
      { description: "server", command: "npm run dev" },
      {
        cwd: "/repo",
        sessionId: "session-1",
        backgroundShell: { create },
      },
    );

    expect(result).toMatchObject({
      isError: true,
      executionState: "not_started",
      failureKind: "configuration",
      content: [{ text: "Background shell request identity is not configured." }],
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("fails before launching when no host is configured", async () => {
    const result = await backgroundShellCreateTool.execute(
      { description: "server", command: "npm run dev" },
      { cwd: "/repo", sessionId: "session-1" },
    );

    expect(result).toMatchObject({
      isError: true,
      content: [{ text: "Background shell host is not configured." }],
    });
  });
});
