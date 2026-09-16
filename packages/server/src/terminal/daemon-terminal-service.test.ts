import { describe, expect, it, vi } from "vitest";

import { DaemonTerminalService } from "./daemon-terminal-service.js";

describe("DaemonTerminalService scoped environments", () => {
  it("does not acquire an environment or spawn a PTY when the session disappears during create", async () => {
    const session = { id: "race-session", cwd: process.cwd(), projectId: "race-project" } as any;
    let sessionReads = 0;
    const acquireEnvironment = vi.fn(async () => ({
      workspace: { executionRoot: process.cwd() },
      terminal: { prepare: async () => ({
        command: "shell",
        args: [],
        hostCwd: process.cwd(),
        executionCwd: process.cwd(),
        shell: "shell",
        signal: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
      }) },
      release: vi.fn(async () => {}),
    } as any));
    const spawnPty = vi.fn(() => fakePty().value);
    const service = new DaemonTerminalService({
      getProject: () => undefined,
      getSession: () => ++sessionReads <= 3 ? session : undefined,
    } as any, {
      getSettingsForCwd: async () => ({ terminal: {} } as any),
      acquireEnvironment,
      spawnPty,
    });

    await expect(service.create({
      scope: { kind: "session", sessionId: session.id },
      runtime: "environment",
      cols: 100,
      rows: 30,
    })).rejects.toThrow(`Session not found: ${session.id}`);

    expect(spawnPty).not.toHaveBeenCalled();
    expect(acquireEnvironment).not.toHaveBeenCalled();
    await expect(service.list()).resolves.toEqual([]);
  });

  it("opens a projectless terminal through its execution environment", async () => {
    const session = { id: "outside-1", cwd: process.cwd(), status: "idle" } as any;
    const signal = vi.fn(async () => {});
    const targetClose = vi.fn(async () => {});
    const leaseRelease = vi.fn(async () => {});
    const prepare = vi.fn(async () => ({
      command: "wsl.exe",
      args: ["--cd", "/mnt/d/workspace"],
      hostCwd: process.cwd(),
      executionCwd: "/workspace",
      shell: undefined,
      signal,
      close: targetClose,
    }));
    const acquireEnvironment = vi.fn(async () => ({
      workspace: { executionRoot: "/workspace" },
      terminal: { prepare },
      release: leaseRelease,
    } as any));
    const pty = fakePty();
    const service = new DaemonTerminalService({
      getProject: () => undefined,
      getSession: (id: string) => id === session.id ? session : undefined,
    } as any, {
      getSettingsForCwd: async () => ({ terminal: {} } as any),
      acquireEnvironment,
      spawnPty: vi.fn(() => pty.value),
    });

    const terminal = await service.create({
      scope: { kind: "session", sessionId: session.id },
        runtime: "environment",
      cols: 100,
      rows: 30,
    });

    expect(acquireEnvironment).toHaveBeenCalledWith(
      session,
      expect.any(Object),
      { kind: "terminal", id: terminal.id },
    );
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/workspace",
      shell: undefined,
      owner: { kind: "terminal", id: terminal.id },
    }));
    expect(terminal).toMatchObject({
      scope: { kind: "session", sessionId: session.id },
      sessionId: session.id,
      cwd: "/workspace",
    });
    expect(terminal).not.toHaveProperty("projectId");

    await service.close(terminal.id);
    expect(targetClose).toHaveBeenCalledOnce();
    expect(leaseRelease).toHaveBeenCalledOnce();
  });

  it("opens an Agent Terminal for a projectless session in its environment", async () => {
    const session = { id: "outside-agent", cwd: process.cwd(), status: "idle" } as any;
    const prepare = vi.fn(async () => ({
      command: "wsl.exe",
      args: ["exec", "-it"],
      hostCwd: process.cwd(),
      executionCwd: "/workspace",
      shell: "/bin/sh",
      signal: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    }));
    const pty = fakePty();
    const service = new DaemonTerminalService({
      getProject: () => undefined,
      getSession: () => session,
    } as any, {
      getSettingsForCwd: async () => ({ terminal: {} } as any),
      acquireEnvironment: async () => ({
        workspace: { executionRoot: "/workspace" },
        terminal: { prepare },
        release: vi.fn(async () => {}),
      } as any),
      spawnPty: vi.fn(() => pty.value),
    });

    const terminal = await service.createAgentHost(session).open({
      sessionId: session.id,
      cwd: session.cwd,
    });

    expect(terminal).toMatchObject({
      source: "agent",
      runtime: "environment",
      scope: { kind: "session", sessionId: session.id },
      cwd: "/workspace",
    });

    await expect(service.get(terminal.id)).resolves.toMatchObject({ id: terminal.id, status: "running" });
    await service.close(terminal.id);
    await expect(service.get(terminal.id)).resolves.toMatchObject({ id: terminal.id, status: "killed" });
  });
});

function fakePty() {
  let exit: ((event: { exitCode: number }) => void) | undefined;
  return {
    value: {
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(() => exit?.({ exitCode: 0 })),
      onData: vi.fn(() => ({ dispose() {} })),
      onExit: vi.fn((listener) => { exit = listener; return { dispose() {} }; }),
    } as any,
  };
}
