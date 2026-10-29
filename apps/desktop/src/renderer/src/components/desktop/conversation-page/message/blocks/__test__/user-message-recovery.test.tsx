// @vitest-environment jsdom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"
import type { ComposerDocument } from "@renderer/stores/desktop-session/composer-document"
import type { DesktopSessionMessage, DesktopSessionPart } from "@shared/session-types"

const editor = vi.hoisted(() => ({ change: null as ((value: ComposerDocument) => void) | null }))
vi.mock("../../../composer/rich-prompt-input", () => ({
  RichPromptInput: ({
    value,
    id,
    onChange,
  }: {
    value: ComposerDocument
    id: string
    onChange: (value: ComposerDocument) => void
  }) => {
    editor.change = onChange
    return (
      <textarea
        id={id}
        readOnly
        value={value.items.map((item) => (item.type === "text" ? item.text : "")).join("")}
      />
    )
  },
}))
vi.mock("../../../transcript/virtual-transcript-row", () => ({ useRetainTranscriptRow: () => {} }))
vi.mock("../user-message-bubble", () => ({ UserMessageBubble: () => <div>原消息</div> }))

import { UserMessage } from "../user-message"

it("opening input recovery only opens the original editor; execution needs explicit submission", () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  const onEdit = vi.fn()
  const onEditingChange = vi.fn()
  const message: DesktopSessionMessage = {
    id: "m",
    sessionId: "s",
    inputId: "i",
    role: "user",
    seq: 1,
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
  }
  const parts: DesktopSessionPart[] = [
    {
      id: "p",
      sessionId: "s",
      messageId: "m",
      seq: 1,
      type: "text",
      status: "completed",
      text: "original",
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    },
  ]
  const render = (editing: boolean) =>
    act(() =>
      root.render(
        <UserMessage
          message={message}
          parts={parts}
          inputItems={[{ type: "text", text: "original" }]}
          userActions={{ canEdit: true, editing, onEdit, onEditingChange }}
        />
      )
    )
  try {
    render(false)
    expect(container.querySelector("textarea")).toBeNull()
    render(true)
    expect(container.querySelector("textarea")?.value).toBe("original")
    expect(onEdit).not.toHaveBeenCalled()
    act(() => editor.change!({ version: 1, items: [{ type: "text", text: "unsaved revision" }] }))
    render(true)
    expect(container.querySelector("textarea")?.value).toBe("unsaved revision")
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="取消编辑"]')!.click())
    expect(onEditingChange).toHaveBeenCalledWith(false)
    render(false)
    expect(onEdit).not.toHaveBeenCalled()
    render(true)
    act(() =>
      container
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    )
    expect(onEdit).toHaveBeenCalledExactlyOnceWith({
      version: 1,
      items: [{ type: "text", text: "original" }],
    })
  } finally {
    act(() => root.unmount())
    container.remove()
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT
  }
})
