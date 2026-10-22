import { describe, expect, it, vi } from "vitest";
import { createShellTool } from "../../shell/shell.js";
import { createBackgroundShellTool } from "../../background-shell/background-shell-tools.js";

const terminal = {
  id: "terminal-service", name: "preview", scope: { kind: "session", sessionId: "s1" },
  runtime: "local", source: "agent", sessionId: "s1", status: "running", cwd: "/repo",
  shell: "/bin/sh", cols: 100, rows: 30, createdAt: "2026-10-11T00:00:00Z",
} as const;

describe("service terminal routing", () => {
  it.each([
    "pnpm dev", "npm run dev -- --host", "python -m http.server 8080", "uvicorn app:app --reload", "npx vite", "tsc --watch",
    "Set-Location E:\\code\\tobias-quill; npm run dev 2>&1",
    "Set-Location -LiteralPath 'E:\\code\\my project'; npm run dev 2>&1",
    'cd "./my project" && pnpm dev',
    "cd sub\nnpm run dev",
    "npm run dev 2>&1",
  ])("starts %s in a visible terminal", async command => {
    const create = vi.fn(async () => ({ jobId: "background", label: "job" }));
    const open = vi.fn(async (input) => ({ ...terminal, command: input.command }));
    const result = await createShellTool(undefined, undefined, { open }).execute({ command }, {
      cwd: "/repo", sessionId: "s1", toolCallId: "call", terminal: { open }, backgroundShell: { create },
    });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse((result.content[0] as any).text)).toMatchObject({ kind: "terminal", action: "open", jobId: terminal.id, terminal: { command } });
    expect(create).not.toHaveBeenCalled();
  });

  it.each(["pnpm dev", "Set-Location E:\\code\\tobias-quill; npm run dev 2>&1"])("routes an explicit background service through the same terminal: %s", async command => {
    const create = vi.fn(async () => ({ jobId: "background", label: "job" }));
    const open = vi.fn(async (input) => ({ ...terminal, name: input.name, command: input.command }));
    const result = await createBackgroundShellTool(undefined, { open }).execute({ command, description: "site preview" }, {
      cwd: "/repo", sessionId: "s1", toolCallId: "call", terminal: { open }, backgroundShell: { create },
    });
    expect(JSON.parse((result.content[0] as any).text)).toMatchObject({ kind: "terminal", terminal: { name: "site preview", command } });
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    "npm install", "pnpm build", "pnpm test", "docker compose up -d", "npx vite build", "vite --version", "next build", "uvicorn --help", "echo 'npm run dev'",
    "Set-Location E:\\code\\project; npm run build 2>&1", 'echo "cd sub; npm run dev 2>&1"',
    "Write-Output 'npm run dev'; npm install", "npm run dev &", "npm run dev | Out-File server.log",
  ])("keeps finite or unrelated work out of service terminals: %s", async command => {
    const open = vi.fn(async () => terminal);
    const create = vi.fn(async () => ({ jobId: "background", label: "job" }));
    await createBackgroundShellTool(undefined, { open }).execute({ command, description: "task" }, {
      cwd: "/repo", sessionId: "s1", toolCallId: "call", terminal: { open }, backgroundShell: { create },
    });
    expect(open).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledOnce();
  });

  it("does not silently start a service in the wrong working directory", async () => {
    const open = vi.fn(async () => terminal);
    const create = vi.fn(async () => ({ jobId: "background", label: "job" }));
    const result = await createShellTool(undefined, undefined, { open }).execute({ command: "pnpm dev", workdir: "/repo/sub" }, {
      cwd: "/repo", sessionId: "s1", toolCallId: "call", terminal: { open }, backgroundShell: { create },
    });
    expect(result).toMatchObject({ isError: true, executionState: "not_started" });
    expect(open).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});
