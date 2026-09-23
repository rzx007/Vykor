// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { parseMcpJson, type McpDocument } from "./mcp-config"
import { McpEditor } from "./mcp-editor"

function documentFor(mcpServers: Record<string, unknown>) {
  return parseMcpJson(JSON.stringify({ mcpServers }))
}

describe("McpEditor", () => {
  let root: Root
  let container: HTMLDivElement

  beforeEach(() => {
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.restoreAllMocks()
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT
  })

  async function render(props: {
    initial: McpDocument
    editingName?: string
    existingNames?: string[]
    onSave: (document: McpDocument) => Promise<void>
    onClose: () => void
  }): Promise<void> {
    const { existingNames = [], ...rest } = props
    await act(async () => {
      root.render(<McpEditor existingNames={existingNames} {...rest} />)
    })
  }
  async function click(label: string): Promise<void> {
    const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent?.trim() === label
    )
    expect(button, `button: ${label}`).toBeTruthy()
    await act(async () => {
      button!.click()
      await Promise.resolve()
    })
  }
  async function input(selector: string, value: string): Promise<void> {
    const element = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!
    expect(element).toBeTruthy()
    const prototype =
      element.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    await act(async () => {
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value)
      element.dispatchEvent(new Event("input", { bubbles: true }))
    })
  }

  it("keeps the dialog open while saving and closes only after onSave resolves", async () => {
    let release!: () => void
    const onSave = vi.fn(
      () => new Promise<void>((resolve) => { release = resolve })
    )
    const onClose = vi.fn()
    await render({
      initial: documentFor({ local: { type: "stdio", command: "node" } }),
      onSave,
      onClose,
    })
    await input('input[id$="-command"]', "bun")
    await click("保存")

    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
    const saveButton = [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) =>
      item.textContent?.trim().startsWith("保存")
    )!
    expect(saveButton.disabled).toBe(true)

    await act(async () => {
      release()
      await Promise.resolve()
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("keeps the input and shows the error when saving fails", async () => {
    const onSave = vi.fn(async () => {
      throw new Error("配置已保存，但同步失败")
    })
    const onClose = vi.fn()
    await render({
      initial: documentFor({ local: { type: "stdio", command: "node" } }),
      onSave,
      onClose,
    })
    await input('input[id$="-command"]', "bun")
    await click("保存")

    expect(onClose).not.toHaveBeenCalled()
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    expect(document.body.textContent).toContain("同步失败")
    expect(document.querySelector<HTMLInputElement>('input[id$="-command"]')?.value).toBe("bun")
    // The save button is usable again so the user can retry.
    expect(
      [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        (item) => item.textContent?.trim() === "保存"
      )?.disabled
    ).toBe(false)
  })

  it("submits a real stdio config without demo fields", async () => {
    const onSave = vi.fn(async () => undefined)
    await render({
      initial: documentFor({ local: { type: "stdio", command: "node" } }),
      onSave,
      onClose: vi.fn(),
    })
    await input('input[id$="-name"]', "beui")
    await input('input[id$="-command"]', "npx")
    await click("保存")

    expect(onSave).toHaveBeenCalledWith({
      servers: [{ name: "beui", config: { type: "stdio", command: "npx" } }],
      extras: {},
      wrapped: true,
    })
  })

  it("locks the name in form mode and rejects a rename in JSON mode", async () => {
    const onSave = vi.fn(async () => undefined)
    await render({
      initial: documentFor({ linear: { type: "http", url: "https://mcp.linear.app/mcp" } }),
      editingName: "linear",
      onSave,
      onClose: vi.fn(),
    })

    expect(document.querySelector<HTMLInputElement>('input[id$="-name"]')?.disabled).toBe(true)

    await click("JSON")
    await input(
      "textarea",
      '{"mcpServers":{"renamed":{"type":"http","url":"https://mcp.linear.app/mcp"}}}'
    )
    await click("保存")

    expect(onSave).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain("不能修改名称")
  })

  it("opens an SSE server in JSON mode so it stays editable", async () => {
    await render({
      initial: documentFor({ legacy: { type: "sse", url: "https://mcp.example/sse" } }),
      editingName: "legacy",
      onSave: vi.fn(async () => undefined),
      onClose: vi.fn(),
    })

    expect(document.querySelector("textarea")).not.toBeNull()
    expect(document.querySelector('input[id$="-command"]')).toBeNull()
  })
})
