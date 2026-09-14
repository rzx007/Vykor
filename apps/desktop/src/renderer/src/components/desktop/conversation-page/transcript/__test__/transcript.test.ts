import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import type { DesktopSessionMessage, DesktopSessionPart } from "@shared/session-types"
import { MessageBlock, renderUserItems } from "../../message/message-block"
import { visibleTranscriptParts } from "../transcript-visibility"

describe("visibleTranscriptParts", () => {
  it("renders a model switch presentation message as an accessible divider", () => {
    const html = renderToStaticMarkup(
      createElement(MessageBlock, {
        message: {
          id: "model-switch",
          sessionId: "session-1",
          seq: 1,
          role: "system",
          metadata: {
            presentation: {
              kind: "model_switch",
              fromModel: "GLM-5.3",
              toModel: "GLM-5.3-Flash",
            },
          },
          createdAt: 1,
          updatedAt: 1,
        },
        parts: [],
        streaming: false,
        onOpenFile: () => undefined,
        canOpenReview: false,
        onOpenReview: () => undefined,
        onOpenTerminal: () => undefined,
      })
    )

    expect(html).toContain('role="separator"')
    expect(html).toContain("模型已切换")
    expect(html).toContain("GLM-5.3")
    expect(html).toContain("GLM-5.3-Flash")
    expect(html).toContain('aria-label="模型已切换 GLM-5.3 到 GLM-5.3-Flash"')
  })

  it("keeps ordinary system messages in their existing text presentation", () => {
    const html = renderToStaticMarkup(
      createElement(MessageBlock, {
        message: {
          id: "ordinary-system",
          sessionId: "session-1",
          seq: 1,
          role: "system",
          metadata: {},
          createdAt: 1,
          updatedAt: 1,
        },
        parts: [
          {
            id: "ordinary-system-part",
            sessionId: "session-1",
            messageId: "ordinary-system",
            seq: 1,
            type: "text",
            status: "completed",
            text: "普通系统提示",
            metadata: {},
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        streaming: false,
        onOpenFile: () => undefined,
        canOpenReview: false,
        onOpenReview: () => undefined,
        onOpenTerminal: () => undefined,
      })
    )

    expect(html).toContain("普通系统提示")
    expect(html).not.toContain('role="separator"')
  })

  it("renders structured user items inline in their original order without exposing paths", () => {
    const message: DesktopSessionMessage = {
      id: "message-skill",
      sessionId: "session-1",
      seq: 1,
      role: "user",
      inputId: "input-skill",
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    }
    const html = renderToStaticMarkup(
      createElement(MessageBlock, {
        message,
        parts: [
          {
            id: "text-skill",
            sessionId: "session-1",
            messageId: "message-skill",
            seq: 0,
            type: "text",
            status: "completed",
            text: "使用 $archify 画一下系统架构",
            metadata: {
              items: [
                { type: "text", text: "使用 " },
                {
                  type: "skill",
                  name: "archify",
                  displayName: "Archify",
                  path: "D:/skills/archify/SKILL.md",
                  source: "project",
                },
                { type: "text", text: " 画一下系统架构" },
                {
                  type: "skill",
                  name: "writing-plans",
                  displayName: "Writing Plans",
                  path: "D:/skills/writing-plans/SKILL.md",
                  source: "user",
                },
              ],
            },
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        streaming: false,
        onOpenFile: () => undefined,
        canOpenReview: false,
        onOpenReview: () => undefined,
        onOpenTerminal: () => undefined,
      })
    )

    expect(html).not.toContain('aria-label="使用的技能"')
    expect(html).toContain("Archify")
    expect(html).toContain("Writing Plans")
    expect(html).toContain("画一下系统架构")
    expect(html).not.toContain("SKILL.md")
    expect(html.indexOf("使用 ")).toBeLessThan(html.indexOf("Archify"))
    expect(html.indexOf("Archify")).toBeLessThan(html.indexOf("画一下系统架构"))
    expect(html.indexOf("画一下系统架构")).toBeLessThan(html.indexOf("Writing Plans"))
    expect(html).toContain("align-middle")
  })

  it("keeps ordered text and skill display items for transcript rendering", () => {
    expect(
      renderUserItems([
        { type: "text", text: "使用 " },
        { type: "skill", name: "a", path: "/a/SKILL.md", displayName: "Skill A" },
        { type: "text", text: " 然后 " },
        { type: "skill", name: "b", path: "/b/SKILL.md", displayName: "Skill B" },
      ])
    ).toEqual([
      { kind: "text", text: "使用 " },
      { kind: "skill", name: "a", displayName: "Skill A" },
      { kind: "text", text: " 然后 " },
      { kind: "skill", name: "b", displayName: "Skill B" },
    ])
  })

  it("keeps a Chinese skill name as a rich transcript item", () => {
    expect(
      renderUserItems([
        {
          type: "skill",
          name: "会议纪要汇总工作流",
          path: "D:/skills/meeting-summary/SKILL.md",
          displayName: "会议纪要汇总工作流",
        },
        { type: "text", text: " 这是什么技能" },
      ])
    ).toEqual([
      {
        kind: "skill",
        name: "会议纪要汇总工作流",
        displayName: "会议纪要汇总工作流",
      },
      { kind: "text", text: " 这是什么技能" },
    ])
  })

  it("renders a skill-only structured message without a capsule", () => {
    const html = renderToStaticMarkup(
      createElement(MessageBlock, {
        message: {
          id: "skill-only",
          sessionId: "session-1",
          seq: 1,
          role: "user",
          metadata: {},
          createdAt: 1,
          updatedAt: 1,
        },
        parts: [
          {
            id: "skill-only-text",
            sessionId: "session-1",
            messageId: "skill-only",
            seq: 0,
            type: "text",
            status: "completed",
            text: "",
            metadata: {
              items: [
                {
                  type: "skill",
                  name: "archify",
                  displayName: "Archify",
                  path: "D:/skills/archify/SKILL.md",
                },
              ],
            },
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        streaming: false,
        onOpenFile: () => undefined,
        canOpenReview: false,
        onOpenReview: () => undefined,
        onOpenTerminal: () => undefined,
      })
    )

    expect(html).toContain("Archify")
    expect(html).not.toContain('aria-label="使用的技能"')
    expect(html).not.toContain("SKILL.md")
  })

  it("removes reasoning from a read-only child replay without hiding other activity", () => {
    const parts = [
      part("reasoning", "private reasoning"),
      part("text", "visible answer"),
      part("tool", undefined, "read_file"),
      part("tool_result", "visible result"),
      part("error", "visible failure"),
    ]

    const visible = visibleTranscriptParts(parts, false)

    expect(visible.map((item) => item.type)).toEqual(["text", "tool", "tool_result", "error"])
    expect(visible.some((item) => item.text === "private reasoning")).toBe(false)
  })

  it("keeps reasoning in the normal conversation transcript", () => {
    const parts = [part("reasoning", "normal reasoning")]

    expect(visibleTranscriptParts(parts, true)).toBe(parts)
  })

  it("renders attachments above user text and hides internal transformation parts", () => {
    const message: DesktopSessionMessage = {
      id: "message-1",
      sessionId: "session-1",
      seq: 1,
      role: "user",
      inputId: "input-1",
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    }
    const html = renderToStaticMarkup(
      createElement(MessageBlock, {
        message,
        parts: [
          {
            id: "text-1",
            sessionId: "session-1",
            messageId: "message-1",
            seq: 0,
            type: "text",
            status: "completed",
            text: "解析一下",
            metadata: {},
            createdAt: 1,
            updatedAt: 1,
          },
          {
            id: "attachment-1",
            sessionId: "session-1",
            messageId: "message-1",
            seq: 1,
            type: "attachment",
            status: "completed",
            assetId: "asset-1",
            intent: "auto",
            displayName: "evidence.pdf",
            mediaType: "application/pdf",
            sizeBytes: 10,
            metadata: {},
            createdAt: 1,
            updatedAt: 1,
          },
          {
            id: "transformation-1",
            sessionId: "session-1",
            messageId: "message-1",
            seq: 2,
            type: "transformation",
            status: "completed",
            assetId: "asset-1",
            kind: "direct",
            metadata: {},
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        streaming: false,
        userActions: { canEdit: true, onEdit: () => undefined },
        onOpenFile: () => undefined,
        canOpenReview: false,
        onOpenReview: () => undefined,
        onOpenTerminal: () => undefined,
      })
    )

    expect(html).toContain("evidence.pdf")
    expect(html.indexOf("evidence.pdf")).toBeLessThan(html.indexOf("解析一下"))
    expect(html).not.toContain("附件已处理")
    expect(html).not.toContain("已作为原生图片输入")
    expect(html).toContain('aria-label="重新编辑"')
    expect(html).not.toContain("已发送消息")
  })

  it("renders generated image attachments inside assistant messages", () => {
    const message: DesktopSessionMessage = {
      id: "assistant-message",
      sessionId: "session-1",
      seq: 2,
      role: "assistant",
      runId: "run-1",
      metadata: {},
      createdAt: 2,
      updatedAt: 2,
    }
    const html = renderToStaticMarkup(
      createElement(MessageBlock, {
        message,
        parts: [
          {
            id: "image-1",
            sessionId: "session-1",
            messageId: "assistant-message",
            seq: 0,
            type: "tool",
            status: "completed",
            toolUseId: "image-1",
            toolName: "ImageGeneration",
            input: { prompt: "draw", ratio: "1:1" },
            metadata: {},
            createdAt: 2,
            updatedAt: 2,
          },
          {
            id: "generated-attachment:image-1:0",
            sessionId: "session-1",
            messageId: "assistant-message",
            seq: 1,
            type: "attachment",
            status: "completed",
            assetId: "att-generated",
            intent: "tool_resource",
            displayName: "generated-image-1.png",
            mediaType: "image/png",
            sizeBytes: 128,
            metadata: { source: "image_generation", toolUseId: "image-1" },
            createdAt: 2,
            updatedAt: 2,
          },
        ],
        streaming: false,
        onOpenFile: () => undefined,
        canOpenReview: false,
        onOpenReview: () => undefined,
        onOpenTerminal: () => undefined,
      })
    )

    expect(html).toContain('aria-label="生成的附件"')
    expect(html).toContain("data-generated-image-gallery")
    expect(html).toContain("generated-image-1.png")
    expect(html).toContain('aria-label="打开 generated-image-1.png"')
    expect(html).toContain('aria-label="另存为 generated-image-1.png"')
  })

  it("removes internal transformation parts from the visible transcript", () => {
    const transformation = {
      id: "transformation-1",
      sessionId: "session-1",
      messageId: "message-1",
      seq: 1,
      type: "transformation" as const,
      status: "completed" as const,
      assetId: "asset-1",
      kind: "direct" as const,
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    }

    expect(visibleTranscriptParts([transformation], true)).toEqual([])
    expect(visibleTranscriptParts([transformation], false)).toEqual([])
  })
})

function part(
  type: "text" | "reasoning" | "tool" | "tool_result" | "error" | "log",
  text?: string,
  toolName?: string
): DesktopSessionPart {
  return {
    id: `${type}-part`,
    sessionId: "child-session",
    messageId: "message",
    seq: 1,
    type,
    status: "completed",
    ...(text ? { text } : {}),
    ...(toolName ? { toolName } : {}),
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
  }
}
