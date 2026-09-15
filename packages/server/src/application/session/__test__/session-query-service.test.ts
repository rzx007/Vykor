import { describe, expect, it, vi } from "vitest";

import { SessionQueryService } from "../session-query-service.js";

describe("SessionQueryService", () => {
  it("filters child sessions and resolves list titles", () => {
    const root = { id: "root", title: "Stored root" };
    const child = { id: "child", parentId: "root", title: "Stored child" };
    const store = {
      listSessions: vi.fn(() => [root, child]),
      resolveSessionListTitle: vi.fn((sessionId: string) => `Resolved ${sessionId}`),
      getSession: vi.fn(),
      getSessionState: vi.fn(),
      listMessages: vi.fn(),
      listMessageParts: vi.fn(),
    };
    const queries = new SessionQueryService(store as any);

    const sessions = queries.listSessions({ cwd: "/repo", includeChildren: false, limit: 20 });

    expect(store.listSessions).toHaveBeenCalledWith({
      cwd: "/repo",
      includeArchived: undefined,
      limit: 20,
    });
    expect(sessions).toEqual([{ ...root, title: "Resolved root" }]);
  });

  it("keeps child sessions when explicitly requested", () => {
    const sessions = [
      { id: "root", title: "Root" },
      { id: "child", parentId: "root", title: "Child" },
    ];
    const queries = new SessionQueryService({
      listSessions: () => sessions,
      resolveSessionListTitle: (sessionId: string) => sessionId,
    } as any);

    expect(queries.listSessions({ includeChildren: true })).toHaveLength(2);
  });

  it("passes through getSession and returns undefined when missing", () => {
    const store = {
      getSession: vi.fn((id: string) => (id === "s1" ? ({ id: "s1", cwd: "/repo" } as any) : undefined)),
      listSessions: vi.fn(),
      getSessionState: vi.fn(),
      listMessages: vi.fn(),
      listMessageParts: vi.fn(),
      resolveSessionListTitle: vi.fn(),
    };
    const queries = new SessionQueryService(store);

    expect(queries.getSession("s1")).toEqual({ id: "s1", cwd: "/repo" });
    expect(queries.getSession("missing")).toBeUndefined();
    expect(store.getSession).toHaveBeenCalledWith("s1");
    expect(store.getSession).toHaveBeenCalledWith("missing");
  });

  it("passes through getSessionState unmodified", () => {
    const snapshot = { session: { id: "s1" }, messages: [] };
    const store = {
      getSession: vi.fn(),
      listSessions: vi.fn(),
      getSessionState: vi.fn(() => snapshot as any),
      listMessages: vi.fn(),
      listMessageParts: vi.fn(),
      resolveSessionListTitle: vi.fn(),
    };
    const queries = new SessionQueryService(store);

    expect(queries.getSessionState("s1")).toBe(snapshot);
    expect(store.getSessionState).toHaveBeenCalledWith("s1");
  });

  it("passes through listMessages and listMessageParts with options", () => {
    const messages = [{ id: "m1", sessionId: "s1" }];
    const parts = [{ id: "p1", sessionId: "s1", messageId: "m1" }];
    const store = {
      getSession: vi.fn(),
      listSessions: vi.fn(),
      getSessionState: vi.fn(),
      listMessages: vi.fn(() => messages as any),
      listMessageParts: vi.fn(() => parts as any),
      resolveSessionListTitle: vi.fn(),
    };
    const queries = new SessionQueryService(store);

    expect(queries.listMessages("s1", { limit: 50 })).toBe(messages);
    expect(store.listMessages).toHaveBeenCalledWith("s1", { limit: 50 });

    expect(queries.listMessageParts("s1", { messageId: "m1" })).toBe(parts);
    expect(store.listMessageParts).toHaveBeenCalledWith("s1", { messageId: "m1" });
  });
});
