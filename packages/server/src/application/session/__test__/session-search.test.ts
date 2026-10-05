import { describe, expect, it, vi } from "vitest";
import type {
  SessionMessagePartRecord,
  SessionMessageRecord,
  SessionRecord,
} from "@vykor/protocol";
import {
  SessionQueryService,
  type SessionQueryStore,
} from "../session-query-service.js";
import { createSessionRoutes } from "../../../http/routes/session.js";
import { VykorClient } from "@vykor/client";
import { CURRENT_PROTOCOL_VERSION } from "@vykor/protocol";

const session = (
  id: string,
  overrides: Partial<SessionRecord> = {},
): SessionRecord => ({
  id,
  title: "讨论方案",
  cwd: "/repo",
  model: "test",
  status: "idle",
  metadata: {},
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});
const message = (
  id: string,
  sessionId: string,
  seq: number,
  role: SessionMessageRecord["role"] = "user",
): SessionMessageRecord => ({
  id,
  sessionId,
  seq,
  role,
  metadata: {},
  createdAt: seq,
  updatedAt: seq,
});
const part = (
  id: string,
  messageId: string,
  sessionId: string,
  text: string,
  overrides: Partial<SessionMessagePartRecord> = {},
): SessionMessagePartRecord =>
  ({
    id,
    messageId,
    sessionId,
    text,
    type: "text",
    seq: 1,
    status: "completed",
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }) as SessionMessagePartRecord;

function fixture() {
  const sessions = [
    session("old", { status: "archived" }),
    session("new", { updatedAt: 3 }),
    session("child", { parentId: "new", updatedAt: 5 }),
    session("memory", { storage: "memory", updatedAt: 6 }),
  ];
  const messages = [
    message("m1", "new", 1),
    message("m2", "new", 2, "assistant"),
    message("m3", "old", 1),
    message("m4", "child", 1),
    message("m5", "memory", 1),
    message("sys", "new", 3, "system"),
  ];
  const parts = [
    part("p1", "m1", "new", "之前遇到了 ECONNRESET"),
    part("p2", "m2", "new", "重试可以解决 ECONNRESET 连接报错"),
    part("p3", "m3", "old", "归档里的 ECONNRESET 记录"),
    part("p4", "m4", "child", "ECONNRESET"),
    part("p5", "m5", "memory", "ECONNRESET"),
    part("reason", "m2", "new", "内部推理", { type: "reasoning" }),
    part("tool", "m2", "new", "工具输出", { type: "tool" }),
    part("pending", "m2", "new", "未确认答案", {
      metadata: {
        modelGeneration: { generationId: "g1", attempt: 1, committed: false },
      },
    }),
    part("sys", "sys", "new", "系统提示"),
  ];
  const store: SessionQueryStore = {
    listSessions: (options = {}) => sessions
      .filter(s => options.includeArchived || s.status !== "archived")
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, options.limit ?? sessions.length),
    resolveSessionListTitle: () => "讨论方案",
    listMessages: (id) => messages.filter((m) => m.sessionId === id),
    listMessageParts: (id) => parts.filter((p) => p.sessionId === id),
    getSession: (id) => sessions.find((s) => s.id === id),
    getSessionState: vi.fn(),
  };
  return { queries: new SessionQueryService(store), parts, sessions };
}

describe("conversation content search", () => {
  it("finds user/assistant text including archived chats, newest first, once per chat", () => {
    const { queries } = fixture();
    expect(queries.searchSessions({ query: "econnreset" })).toEqual([
      {
        session: session("new", { updatedAt: 3 }),
        messageId: "m2",
        snippet: "重试可以解决 ECONNRESET 连接报错",
      },
      {
        session: session("old", { status: "archived" }),
        messageId: "m3",
        snippet: "归档里的 ECONNRESET 记录",
      },
    ]);
    expect(
      queries.searchSessions({ query: "连接 ECONNRESET", limit: 1 }),
    ).toHaveLength(1);
  });

  it("excludes internal text and incomplete model answers", () => {
    const { queries } = fixture();
    for (const query of [
      "内部推理",
      "工具输出",
      "未确认答案",
      "系统提示",
      "不存在",
    ])
      expect(queries.searchSessions({ query })).toEqual([]);
    expect(queries.searchSessions({ query: "   " })).toEqual([]);
  });

  it("keeps the match visible in a short snippet and searches beyond the sidebar list", () => {
    const { queries, parts, sessions } = fixture();
    sessions.unshift(
      ...Array.from({ length: 450 }, (_, i) =>
        session(`empty-${i}`, { updatedAt: 10 }),
      ),
    );
    parts[2]!.text = "前文".repeat(150) + "目标关键词" + "后文".repeat(150);
    const result = queries.searchSessions({ query: "目标关键词" });
    expect(result).toHaveLength(1);
    expect(result[0]!.snippet).toContain("目标关键词");
    expect(result[0]!.snippet.length).toBeLessThanOrEqual(202);
    expect(result[0]!.snippet.startsWith("…")).toBe(true);
    expect(
      queries.searchSessions({ query: "ECONNRESET", limit: 1 }),
    ).toHaveLength(1);
  });

  it("serves search without warming a session and validates oversized queries", async () => {
    const { queries } = fixture();
    const app = createSessionRoutes({
      queries,
      commands: {} as never,
      interactions: {
        warmSession: () => {
          throw new Error("search must not warm a session");
        },
      },
      traces: { get: vi.fn() },
    });
    const response = await app.request("/search?query=ECONNRESET&limit=1");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      results: [{ messageId: "m2" }],
    });
    expect((await app.request(`/search?query=${"x".repeat(257)}`)).status).toBe(
      400,
    );
    const client = new VykorClient({
      baseUrl: "http://daemon.test",
      fetch: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === "/capabilities")
          return Response.json({
            serverVersion: "test",
            protocol: { version: CURRENT_PROTOCOL_VERSION },
            features: {},
          });
        return app.request(
          url.pathname.replace(/^\/sessions/, "") + url.search,
          init,
        );
      },
    });
    expect(
      await client.sessions.search({ query: "连接 ECONNRESET", limit: 1 }),
    ).toMatchObject([
      { messageId: "m2", snippet: "重试可以解决 ECONNRESET 连接报错" },
    ]);
  });
});
