import { describe, expect, it } from "vitest"

import type { DesktopSessionPart, DesktopSessionTask } from "@shared/session-types"
import { emptySessionView } from "@renderer/stores/desktop-session/store-test-fixtures"
import { collectSessionSources, summarizeAgentTasks } from "./session-summary-model"

function tool(
  id: string,
  toolName: string,
  input: Record<string, unknown>,
  extra: Partial<DesktopSessionPart> = {}
): DesktopSessionPart {
  return {
    id,
    toolUseId: id,
    sessionId: "chat",
    messageId: "assistant",
    seq: 1,
    type: "tool",
    status: "completed",
    toolName,
    input,
    output: { content: [{ type: "text", text: "success" }] },
    metadata: {},
    createdAt: 2,
    updatedAt: 2,
    ...extra,
  } as DesktopSessionPart
}

describe("session summary", () => {
  it("counts successful, failed, stopped and active agents separately", () => {
    const tasks = ["pending", "running", "completed", "failed", "interrupted", "stopped"].map(
      (status, index) =>
        ({
          id: String(index),
          sessionId: "chat",
          childSessionId: `child-${index}`,
          type: "agent",
          status,
          description: "task",
          cwd: "D:/repo",
          metadata: {},
          createdAt: 1,
          updatedAt: 1,
        }) as DesktopSessionTask
    )
    expect(
      summarizeAgentTasks([
        ...tasks,
        { ...tasks[0]!, childSessionId: undefined },
        { ...tasks[0]!, type: "shell" },
      ])
    ).toEqual({ total: 6, active: 2, completed: 1, failed: 1, stopped: 2 })
  })

  it("deduplicates provided and successfully read files using the session cwd", () => {
    const view = emptySessionView("chat")
    view.inputs = [
      {
        id: "input",
        sessionId: "chat",
        seq: 1,
        delivery: "queue",
        content: "",
        items: [{ type: "mention", name: "README.md", path: "README.md" }],
        attachments: [],
        metadata: {},
        createdAt: 1,
      },
    ]
    view.parts = [tool("read", "Read", { file_path: "d:\\repo\\README.md" })]
    const sources = collectSessionSources(view)
    expect(sources).toHaveLength(1)
    expect(sources[0]).toMatchObject({ kind: "file", path: "d:/repo/README.md", origin: "read" })
  })

  it("accepts a separate successful tool result but excludes failed and unfinished reads", () => {
    const view = emptySessionView("chat")
    view.parts = [
      tool("read", "Read", { file_path: "good.ts" }, { output: undefined }),
      { ...tool("result", "Read", {}), type: "tool_result", toolUseId: "read" },
      tool("failed", "Read", { file_path: "failed.ts" }, { isError: true }),
      tool(
        "pending",
        "Read",
        { file_path: "pending.ts" },
        { status: "running", output: undefined }
      ),
      tool("directory", "Read", { file_path: "." }),
      tool("foreign", "Read", { file_path: "foreign.ts" }, { sessionId: "another-chat" }),
    ]
    expect(collectSessionSources(view).map((source) => source.label)).toEqual(["good.ts"])
  })

  it("keeps fetched pages and search discoveries distinct, ignores arbitrary URLs in output", () => {
    const view = emptySessionView("chat")
    view.parts = [
      tool(
        "fetch",
        "WebFetch",
        { url: "https://docs.example/guide#top" },
        {
          output: {
            content: [
              {
                type: "text",
                text: "URL: https://docs.example/guide\nStatus: 200\n\nhttps://unrelated.example",
              },
            ],
          },
        }
      ),
      tool(
        "search",
        "WebSearch",
        { query: "guide" },
        {
          output: {
            content: [
              {
                type: "text",
                text: "Search results for: guide\n1. Guide\n   URL: https://docs.example/guide\n   snippet\n2. Reference\n   URL: https://docs.example/reference?q=one\n   snippet",
              },
            ],
          },
        }
      ),
      tool(
        "shell",
        "Shell",
        {},
        {
          output: { content: [{ type: "text", text: "https://logs.example/internal" }] },
        }
      ),
      tool("unsafe", "WebFetch", { url: "javascript:alert(1)" }),
    ]
    const sources = collectSessionSources(view)
    expect(sources).toHaveLength(2)
    expect(
      sources.find((source) => source.kind === "url" && source.url.includes("guide"))
    ).toMatchObject({ kind: "url", origin: "read", url: "https://docs.example/guide" })
    expect(sources.find((source) => source.label === "Reference")).toMatchObject({
      kind: "url",
      origin: "search",
      url: "https://docs.example/reference?q=one",
    })
  })

  it("deduplicates sent attachments by asset and excludes generated output", () => {
    const view = emptySessionView("chat")
    const attachment = {
      id: "attachment",
      sessionId: "chat",
      inputId: "input",
      assetId: "asset-1",
      seq: 1,
      intent: "auto" as const,
      displayName: "spec.txt",
      mediaType: "text/plain",
      sizeBytes: 4,
      metadata: {},
      createdAt: 1,
    }
    view.inputs = [
      {
        id: "input",
        sessionId: "chat",
        seq: 1,
        delivery: "queue",
        content: "",
        items: [],
        attachments: [attachment, { ...attachment, id: "duplicate" }],
        metadata: {},
        createdAt: 1,
      },
    ]
    view.parts = [
      {
        id: "generated",
        sessionId: "chat",
        messageId: "assistant",
        seq: 2,
        type: "attachment",
        status: "completed",
        assetId: "asset-generated",
        intent: "auto",
        displayName: "generated.png",
        mediaType: "image/png",
        sizeBytes: 10,
        metadata: { source: "image_generation" },
        createdAt: 2,
        updatedAt: 2,
      },
    ]
    expect(collectSessionSources(view)).toHaveLength(1)
    expect(collectSessionSources(view)[0]).toMatchObject({
      kind: "attachment",
      assetId: "asset-1",
      origin: "provided",
    })
  })
})
