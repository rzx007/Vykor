import type {
  TerminalCreateRequest,
  TerminalEventListener,
  TerminalSessionInfo,
} from "@openharness/terminal";
import { describe, expect, it, vi } from "vitest";

import type { DaemonTerminalService } from "../../terminal/index.js";
import { createTerminalRoutes, TerminalHttpEventHub } from "./terminal.js";

describe("TerminalHttpEventHub", () => {
  it("closes active terminal SSE clients during daemon shutdown", async () => {
    let listener: TerminalEventListener | undefined;
    const unsubscribe = vi.fn();
    const terminals = {
      subscribe(next: TerminalEventListener) {
        listener = next;
        return unsubscribe;
      },
    } as unknown as DaemonTerminalService;
    const hub = new TerminalHttpEventHub(terminals);
    const response = hub.createStream();
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Expected an SSE response body");

    const connected = await reader.read();
    expect(new TextDecoder().decode(connected.value)).toContain("connected");
    expect(listener).toBeTypeOf("function");
    expect(hub.clientCount).toBe(1);

    hub.closeClients();

    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(hub.clientCount).toBe(0);
    await expect(reader.read()).resolves.toMatchObject({ done: true });
  });
});

describe("Terminal routes", () => {
  it("forwards sandbox terminal create options to the daemon service", async () => {
    const create = vi.fn(async (input: TerminalCreateRequest): Promise<TerminalSessionInfo> => ({
      id: "terminal-1",
      name: input.name ?? "Terminal",
      scope: input.scope,
      runtime: input.runtime,
      source: input.source ?? "user",
      ...(input.scope.kind === "project" ? { projectId: input.scope.projectId } : { sessionId: input.scope.sessionId }),
      status: "running",
      cwd: input.cwd ?? "/repo",
      shell: input.shell ?? "/bin/sh",
      cols: input.cols,
      rows: input.rows,
      createdAt: "2026-08-15T00:00:00.000Z",
    }));
    const terminals = {
      create,
      subscribe: () => () => {},
    } as unknown as DaemonTerminalService;
    const app = createTerminalRoutes(terminals, new TerminalHttpEventHub(terminals));

    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope: { kind: "session", sessionId: "session-1" },
        runtime: "environment",
        cols: 120,
        rows: 32,
        name: "Sandbox",
        shell: "/bin/sh -i",
        cwd: "/repo/apps/web",
        source: "agent",
      }),
    });

    expect(response.status).toBe(201);
    expect(create).toHaveBeenCalledWith({
      scope: { kind: "session", sessionId: "session-1" },
      runtime: "environment",
      cols: 120,
      rows: 32,
      name: "Sandbox",
      shell: "/bin/sh -i",
      cwd: "/repo/apps/web",
      source: "agent",
    });
    await expect(response.json()).resolves.toMatchObject({
      terminal: {
        id: "terminal-1",
        runtime: "environment",
        source: "agent",
        sessionId: "session-1",
      },
    });
  });

  it.each([
    { projectId: "project-1" },
    { sessionId: "session-1" },
  ])("rejects a legacy top-level terminal scope payload: %s", async (legacyScope) => {
    const create = vi.fn();
    const terminals = { create, subscribe: () => () => {} } as unknown as DaemonTerminalService;
    const app = createTerminalRoutes(terminals, new TerminalHttpEventHub(terminals));

    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...legacyScope, runtime: "local", cols: 80, rows: 24 }),
    });

    expect(response.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it("accepts a new session-scoped terminal request without projectId", async () => {
    const create = vi.fn(async (input: TerminalCreateRequest): Promise<TerminalSessionInfo> => ({
      id: "terminal-outside",
      name: "Terminal",
      scope: input.scope!,
      sessionId: input.scope?.kind === "session" ? input.scope.sessionId : undefined,
      runtime: input.runtime,
      source: "user",
      status: "running",
      cwd: "/workspace",
      shell: "/bin/sh",
      cols: input.cols,
      rows: input.rows,
      createdAt: "2026-09-07T00:00:00.000Z",
    }));
    const terminals = { create, subscribe: () => () => {} } as unknown as DaemonTerminalService;
    const app = createTerminalRoutes(terminals, new TerminalHttpEventHub(terminals));

    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope: { kind: "session", sessionId: "outside-1" },
        runtime: "environment",
        cols: 100,
        rows: 30,
      }),
    });

    expect(response.status).toBe(201);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      scope: { kind: "session", sessionId: "outside-1" },
    }));
  });
});
