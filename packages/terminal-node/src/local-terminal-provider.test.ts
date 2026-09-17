import type { TerminalSessionInfo } from "@openharness/terminal";
import { describe, expect, it, vi } from "vitest";

import { LocalTerminalProvider } from "./local-terminal-provider";
import { TerminalOutputStore } from "./terminal-output-store";

describe("LocalTerminalProvider", () => {
  it("releases an environment target when cwd validation fails", async () => {
    const close = vi.fn(async () => {});
    const provider = new LocalTerminalProvider({
      resolveCwd: async () => process.cwd(),
      resolveTarget: async () => ({
        command: "shell", args: [], hostCwd: `${process.cwd()}-missing`,
        executionCwd: "/workspace", shell: "shell",
        signal: vi.fn(async () => {}), close,
      }),
      spawnPty: vi.fn(),
    });

    await expect(provider.create({
      scope: { kind: "session", sessionId: "s1" }, runtime: "environment", cols: 80, rows: 24,
    })).rejects.toBeDefined();
    expect(close).toHaveBeenCalledOnce();
    expect(await provider.list()).toEqual([]);
  });

  it("releases an environment target and preserves a spawn failure", async () => {
    const original = new Error("pty spawn failed");
    const close = vi.fn(async () => { throw new Error("lease cleanup failed"); });
    const provider = new LocalTerminalProvider({
      resolveCwd: async () => process.cwd(),
      resolveTarget: async () => ({
        command: "shell", args: [], hostCwd: process.cwd(),
        executionCwd: "/workspace", shell: "shell",
        signal: vi.fn(async () => {}), close,
      }),
      spawnPty: vi.fn(() => { throw original; }),
    });

    await expect(provider.create({
      scope: { kind: "session", sessionId: "s1" }, runtime: "environment", cols: 80, rows: 24,
    })).rejects.toBe(original);
    expect(close).toHaveBeenCalledOnce();
    expect(await provider.list()).toEqual([]);
  });

  it("kills a spawned PTY and releases its target when listener setup fails", async () => {
    const original = new Error("listener setup failed");
    const close = vi.fn(async () => {});
    const pty = {
      write: vi.fn(), resize: vi.fn(), kill: vi.fn(),
      onData: vi.fn(() => { throw original; }), onExit: vi.fn(),
    } as any;
    const provider = new LocalTerminalProvider({
      resolveCwd: async () => process.cwd(),
      resolveTarget: async () => ({
        command: "shell", args: [], hostCwd: process.cwd(),
        executionCwd: "/workspace", shell: "shell",
        signal: vi.fn(async () => {}), close,
      }),
      spawnPty: vi.fn(() => pty),
    });

    await expect(provider.create({
      scope: { kind: "session", sessionId: "s1" }, runtime: "environment", cols: 80, rows: 24,
    })).rejects.toBe(original);
    expect(pty.kill).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(await provider.list()).toEqual([]);
  });

  it("drives a WSL target through node-pty with input, resize, and signals", async () => {
    let onData: ((data: string) => void) | undefined;
    let onExit: ((event: { exitCode: number }) => void) | undefined;
    const pty = {
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      onData: vi.fn((listener) => { onData = listener; return { dispose() {} }; }),
      onExit: vi.fn((listener) => { onExit = listener; return { dispose() {} }; }),
    } as any;
    const spawnPty = vi.fn(() => pty);
    const signal = vi.fn(async () => {});
    const resize = vi.fn(async () => {});
    const close = vi.fn(async () => {});
    const provider = new LocalTerminalProvider({
      resolveCwd: async () => process.cwd(),
      resolveTarget: async () => ({
        command: "wsl.exe",
        args: ["--cd", "/mnt/d/workspace"],
        hostCwd: process.cwd(),
        executionCwd: "/mnt/d/workspace",
        shell: "default",
        resize,
        signal,
        close,
      }),
      spawnPty,
    });

    const info = await provider.create({
      scope: { kind: "session", sessionId: "s1" },
        runtime: "environment",
      cols: 100,
      rows: 30,
    });
    expect(spawnPty).toHaveBeenCalledWith(
      "wsl.exe",
      ["--cd", "/mnt/d/workspace"],
      expect.objectContaining({ cwd: process.cwd(), cols: 100, rows: 30 }),
    );
    expect(info).toMatchObject({ cwd: "/mnt/d/workspace", shell: "default" });

    await provider.write({ terminalId: info.id, data: "echo ok\r" });
    await provider.resize({ terminalId: info.id, cols: 120, rows: 40 });
    await provider.signal({ terminalId: info.id, signal: "interrupt" });
    await provider.signal({ terminalId: info.id, signal: "eof" });
    expect(pty.write).toHaveBeenCalledWith("echo ok\r");
    expect(pty.write).toHaveBeenCalledWith("\x03");
    expect(pty.write).toHaveBeenCalledWith("\x04");
    expect(pty.resize).toHaveBeenCalledWith(120, 40);
    expect(resize).toHaveBeenCalledWith(120, 40);

    onData?.("ok\r\n");
    expect((await provider.read({ terminalId: info.id })).data).toContain("ok");
    await provider.kill(info.id);
    expect(signal).toHaveBeenCalledWith("terminate");
    expect(pty.kill).toHaveBeenCalledOnce();
    onExit?.({ exitCode: 0 });
    expect(close).toHaveBeenCalledOnce();
  });

  it("observes an exit that happens while wait subscribes", async () => {
    const provider = new LocalTerminalProvider({ resolveCwd: async () => "/repo" });
    const info: TerminalSessionInfo = {
      id: "terminal-1",
      name: "test",
      scope: { kind: "project", projectId: "project-1" },
      projectId: "project-1",
      runtime: "local",
      source: "agent",
      sessionId: "session-1",
      status: "running",
      cwd: "/repo",
      shell: "/bin/sh",
      cols: 80,
      rows: 24,
      createdAt: "2026-08-17T00:00:00.000Z",
    };
    const session = {
      info,
      kind: "pty" as const,
      pty: {},
      output: { drain: vi.fn() },
      transcript: new TerminalOutputStore(),
      cancelRequested: false,
    };
    const internals = provider as unknown as { sessions: Map<string, typeof session> };
    internals.sessions.set(info.id, session);

    const subscribe = provider.subscribe.bind(provider);
    vi.spyOn(provider, "subscribe").mockImplementation((listener) => {
      const unsubscribe = subscribe(listener);
      session.info = {
        ...session.info,
        status: "completed",
        exitedAt: "2026-08-17T00:00:01.000Z",
        exitCode: 0,
      };
      return unsubscribe;
    });

    await expect(provider.wait({ terminalId: info.id, timeoutMs: 100 })).resolves.toMatchObject({
      timedOut: false,
      terminal: { status: "completed" },
    });
  });
});
