import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import type { DesktopSessionInput, DesktopSessionRun } from "@shared/session-types"
import { PendingPromptQueue } from "../pending-prompt-queue"

describe("PendingPromptQueue", () => {
  it.each([
    { source: "local", content: "", label: "1 条批注" },
    { source: "local", content: "按批注修改", label: "按批注修改" },
    { source: "server", content: "", label: "1 条批注" },
    { source: "server", content: "按批注修改", label: "按批注修改" },
  ])(
    "hides annotation JSON and keeps a readable queued title ($source, $content)",
    ({ source, content, label }) => {
      const browserAnnotationContext =
        '\n\n<browser_annotations>\n{"url":"http://localhost/design","annotations":[{"target":"按钮","selector":"#submit","comment":"增加留白"}]}\n</browser_annotations>'
      const input: DesktopSessionInput = {
        id: "input",
        sessionId: "chat",
        seq: 1,
        delivery: "queue",
        content: content + browserAnnotationContext,
        items: [],
        attachments: [],
        metadata: {},
        createdAt: 1,
      }
      const run: DesktopSessionRun = {
        id: "queued",
        sessionId: "chat",
        inputId: "input",
        status: "pending",
        metadata: {},
        createdAt: 1,
        updatedAt: 1,
      }
      const html = renderToStaticMarkup(
        createElement(PendingPromptQueue, {
          prompts: source === "server" ? [{ input, run }] : [],
          localSubmissions:
            source === "local"
              ? [
                  {
                    id: "input",
                    sessionId: "chat",
                    content,
                    browserAnnotationContext,
                    phase: "submitting",
                    placement: "queue",
                  },
                ]
              : [],
          activeRunId: "active",
          onPromote: () => {},
          onCancel: () => {},
        })
      )
      expect(html).toContain(label)
      expect(html).not.toContain("browser_annotations")
      expect(html).not.toContain("#submit")
      expect(html).not.toContain("增加留白")
    }
  )

  it("offers recovery for failed sends and keeps dismissed records out of the UI", () => {
    const failed = {
      id: "failed",
      sessionId: "s",
      content: "recoverable",
      phase: "failed" as const,
      placement: "transcript" as const,
    }
    const props = { prompts: [], onPromote: vi.fn(), onCancel: vi.fn(), onRetryLocal: vi.fn() }
    const html = renderToStaticMarkup(
      createElement(PendingPromptQueue, { ...props, localSubmissions: [failed] })
    )
    expect(html).toContain("核对并重试")
    const hidden = renderToStaticMarkup(
      createElement(PendingPromptQueue, {
        ...props,
        localSubmissions: [{ ...failed, dismissed: true }],
      })
    )
    expect(hidden).toBe("")
  })
  it("only shows local submissions that were sent while another run was active", () => {
    const html = renderToStaticMarkup(
      createElement(PendingPromptQueue, {
        prompts: [],
        activeRunId: "run-active",
        localSubmissions: [
          {
            id: "input-direct",
            sessionId: "session-1",
            content: "normal request",
            phase: "submitting",
            placement: "transcript",
          },
          {
            id: "input-queued",
            sessionId: "session-1",
            content: "queued request",
            phase: "submitting",
            placement: "queue",
          },
        ],
        onPromote: vi.fn(),
        onCancel: vi.fn(),
      })
    )

    expect(html).not.toContain("normal request")
    expect(html).toContain("queued request")
    expect(html).toContain("正在发送")
  })

  it("shows the error when a local submission fails", () => {
    const html = renderToStaticMarkup(
      createElement(PendingPromptQueue, {
        prompts: [],
        activeRunId: "run-active",
        localSubmissions: [
          {
            id: "input-failed",
            sessionId: "session-1",
            content: "new request",
            phase: "failed",
            placement: "transcript",
            error: "网络连接已断开",
          },
        ],
        onPromote: vi.fn(),
        onCancel: vi.fn(),
      })
    )

    expect(html).toContain("new request")
    expect(html).toContain("发送失败")
    expect(html).toContain("网络连接已断开")
    expect(html).toContain('aria-label="关闭发送错误"')
  })

  it("does not treat the first pending run as queued before it starts running", () => {
    const html = renderToStaticMarkup(
      createElement(PendingPromptQueue, {
        prompts: [
          {
            input: {
              id: "input-direct",
              sessionId: "session-1",
              seq: 1,
              delivery: "queue" as const,
              items: [{ type: "text" as const, text: "normal request" }],
              content: "normal request",
              attachments: [],
              metadata: {},
              createdAt: 1,
            },
            run: {
              id: "run-direct",
              sessionId: "session-1",
              inputId: "input-direct",
              status: "pending" as const,
              metadata: {},
              createdAt: 1,
              updatedAt: 1,
            },
          },
        ],
        onPromote: vi.fn(),
        onCancel: vi.fn(),
      })
    )

    expect(html).not.toContain("normal request")
  })

  it("keeps later pending runs visible while the first pending run is about to start", () => {
    const prompt = (
      id: string,
      content: string,
      createdAt: number
    ): { input: DesktopSessionInput; run: DesktopSessionRun } => ({
      input: {
        id: `input-${id}`,
        sessionId: "session-1",
        seq: createdAt,
        delivery: "queue" as const,
        content,
        items: [{ type: "text", text: content }],
        attachments: [],
        metadata: {},
        createdAt,
      },
      run: {
        id: `run-${id}`,
        sessionId: "session-1",
        inputId: `input-${id}`,
        status: "pending" as const,
        metadata: {},
        createdAt,
        updatedAt: createdAt,
      },
    })
    const html = renderToStaticMarkup(
      createElement(PendingPromptQueue, {
        prompts: [prompt("first", "normal request", 1), prompt("second", "queued request", 2)],
        onPromote: vi.fn(),
        onCancel: vi.fn(),
      })
    )

    expect(html).not.toContain("normal request")
    expect(html).toContain("queued request")
  })

  it("keeps a failed action visible with an inline error", () => {
    const prompt = {
      input: {
        id: "input-queued",
        sessionId: "session-1",
        seq: 2,
        delivery: "queue" as const,
        items: [{ type: "text" as const, text: "change direction" }],
        content: "change direction",
        attachments: [],
        metadata: {},
        createdAt: 2,
      },
      run: {
        id: "run-queued",
        sessionId: "session-1",
        inputId: "input-queued",
        status: "pending" as const,
        metadata: {},
        createdAt: 2,
        updatedAt: 2,
      },
      action: {
        sessionId: "session-1",
        inputId: "input-queued",
        runId: "run-queued",
        kind: "promote" as const,
        phase: "failed" as const,
        error: "当前回答已经切换",
      },
    }

    const html = renderToStaticMarkup(
      createElement(PendingPromptQueue, {
        prompts: [prompt],
        activeRunId: "run-active",
        onPromote: vi.fn(),
        onCancel: vi.fn(),
      })
    )

    expect(html).toContain("change direction")
    expect(html).toContain("当前回答已经切换")
  })

  it("hides an acknowledged action before the session stream catches up", () => {
    const html = renderToStaticMarkup(
      createElement(PendingPromptQueue, {
        prompts: [
          {
            input: {
              id: "input-queued",
              sessionId: "session-1",
              seq: 2,
              delivery: "queue" as const,
              items: [{ type: "text" as const, text: "already promoted" }],
              content: "already promoted",
              attachments: [],
              metadata: {},
              createdAt: 2,
            },
            run: {
              id: "run-queued",
              sessionId: "session-1",
              inputId: "input-queued",
              status: "pending" as const,
              metadata: {},
              createdAt: 2,
              updatedAt: 2,
            },
            action: {
              kind: "promote" as const,
              phase: "acknowledged" as const,
            },
          },
        ],
        activeRunId: "run-active",
        onPromote: vi.fn(),
        onCancel: vi.fn(),
      })
    )

    expect(html).not.toContain("already promoted")
  })
})
