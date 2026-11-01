// @vitest-environment jsdom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type {
  DesktopSessionMessage,
  DesktopSessionPart,
  SessionUserInputItem,
} from "@shared/session-types"
import { UserMessage } from "../user-message"

const context =
  '\n\n<browser_annotations>\n{"url":"http://localhost/design","annotations":[{"target":"提交按钮","selector":"#submit","comment":"增加按钮留白"}]}\n</browser_annotations>'
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

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT
})

function parts(text: string, items?: SessionUserInputItem[]): DesktopSessionPart[] {
  return [
    {
      id: "p",
      sessionId: "s",
      messageId: "m",
      seq: 1,
      type: "text",
      status: "completed",
      text,
      metadata: items ? { items } : {},
      createdAt: 1,
      updatedAt: 1,
    },
  ]
}

it.each([false, true])(
  "shows the user text and an expandable annotation summary without exposing JSON (items=%s)",
  async (withItems) => {
    const text = `按批注修改${context}`
    await act(async () =>
      root.render(
        <UserMessage
          message={message}
          parts={parts(text, withItems ? [{ type: "text", text }] : undefined)}
        />
      )
    )
    expect(container.querySelector("[data-chat-search-text]")?.textContent).toBe("按批注修改")
    expect(container.textContent).not.toContain("browser_annotations")
    expect(container.textContent).not.toContain("#submit")
    const trigger = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("1 条批注")
    )
    expect(trigger).toBeDefined()
    expect(trigger!.getAttribute("aria-expanded")).toBe("false")
    expect(container.textContent).not.toContain("增加按钮留白")
    await act(async () => trigger!.click())
    expect(trigger!.getAttribute("aria-expanded")).toBe("true")
    expect(container.textContent).toContain("提交按钮")
    expect(container.textContent).toContain("增加按钮留白")
    expect(container.textContent).not.toContain("#submit")
    expect(container.querySelector("[data-chat-search-text]")?.textContent).toBe("按批注修改")
  }
)

it("keeps mentions while removing a separate automatic text item", async () => {
  const items: SessionUserInputItem[] = [
    { type: "text", text: "请用 " },
    { type: "capability", kind: "plugin", pluginId: "design", displayName: "设计助手" },
    { type: "text", text: context },
  ]
  await act(async () =>
    root.render(<UserMessage message={message} parts={parts(`请用 @设计助手${context}`, items)} />)
  )
  expect(container.querySelector("[data-chat-search-text]")?.textContent).toBe("请用 设计助手")
  expect(container.textContent).not.toContain("browser_annotations")
})

it.each([false, true])(
  "opens the real message editor with only user input and submits no automatic JSON (items=%s)",
  async (withItems) => {
    const onEdit = vi.fn()
    const items: SessionUserInputItem[] = [{ type: "text", text: `按批注修改${context}` }]
    await act(async () =>
      root.render(
        <UserMessage
          message={message}
          parts={parts(`按批注修改${context}`, withItems ? items : undefined)}
          inputItems={withItems ? items : undefined}
          userActions={{ canEdit: true, editing: true, onEdit }}
        />
      )
    )
    expect(container.querySelector("#latest-message-editor")?.textContent).toBe("按批注修改")
    expect(container.textContent).not.toContain("browser_annotations")
    await act(async () =>
      container
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    )
    expect(onEdit).toHaveBeenCalledExactlyOnceWith({
      version: 1,
      items: [{ type: "text", text: "按批注修改" }],
    })
    expect(items[0]).toEqual({ type: "text", text: `按批注修改${context}` })
  }
)

it("preserves malformed or non-trailing annotation-looking text", async () => {
  const text = `请参考${context}\n我还要保留这段示例`
  await act(async () =>
    root.render(<UserMessage message={message} parts={parts(text, [{ type: "text", text }])} />)
  )
  expect(container.querySelector("[data-chat-search-text]")?.textContent).toBe(text)
  expect(container.textContent).not.toContain("1 条批注")
})

it("can submit an annotation-only message edit while its source snapshot stays in the parent", async () => {
  const onEdit = vi.fn()
  await act(async () =>
    root.render(
      <UserMessage
        message={message}
        parts={parts(context)}
        inputItems={[{ type: "text", text: context }]}
        userActions={{ canEdit: true, editing: true, onEdit }}
      />
    )
  )
  expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false)
  await act(async () =>
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  )
  expect(onEdit).toHaveBeenCalledExactlyOnceWith({ version: 1, items: [] })
})

it("still shows attachment-only messages without adding an empty annotation summary", async () => {
  await act(async () =>
    root.render(
      <UserMessage
        message={message}
        parts={[
          {
            id: "file",
            sessionId: "s",
            messageId: "m",
            seq: 1,
            type: "attachment",
            status: "completed",
            assetId: "asset",
            intent: "auto",
            displayName: "notes.txt",
            mediaType: "text/plain",
            sizeBytes: 4,
            metadata: {},
            createdAt: 1,
            updatedAt: 1,
          },
        ]}
        userActions={{ canEdit: true, onEdit: vi.fn() }}
      />
    )
  )
  expect(container.textContent).toContain("notes.txt")
  expect(container.querySelector("[data-chat-search-text]")).toBeNull()
  expect(container.textContent).not.toContain("条批注")
  expect(container.querySelector('[aria-label="重新编辑"]')).not.toBeNull()
})
