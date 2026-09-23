// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { McpManager, type McpManagerProps } from "./mcp-manager"
import { loadMcpStorage, parseMcpJson, saveMcpStorage } from "./mcp-config"

describe("MCP manager local workflow", () => {
  let root: Root
  let container: HTMLDivElement
  let props: McpManagerProps
  beforeEach(() => {
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
    localStorage.clear()
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
    props = {
      query: "",
      addRequest: 0,
      refreshRequest: 0,
      projectPath: "D:/project",
      notify: () => {},
    }
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT
  })
  async function render(next: Partial<McpManagerProps> = {}): Promise<void> {
    props = { ...props, ...next }
    await act(async () => root.render(<McpManager {...props} />))
  }
  async function click(label: string): Promise<void> {
    const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent?.trim() === label || b.getAttribute("aria-label") === label
    )
    expect(button, `button: ${label}`).toBeTruthy()
    await act(async () => button!.click())
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

  it("saves an HTTP server from the form without writing it before confirm", async () => {
    await render()
    await render({ addRequest: 1 })
    expect(loadMcpStorage(localStorage, props.projectPath).document.servers).toHaveLength(0)
    await click("流式 HTTP")
    await input('input[id$="-name"]', "remote")
    await input('input[id$="-url"]', "https://example.com/mcp")
    await input('input[aria-label="标头 1 键"]', "Accept")
    await input('input[aria-label="标头 1 值"]', "application/json")
    await click("保存")
    expect(loadMcpStorage(localStorage, props.projectPath).document.servers[0]).toMatchObject({
      name: "remote",
      config: {
        type: "http",
        url: "https://example.com/mcp",
        headers: { Accept: "application/json" },
      },
    })
  })

  it("opens only on new add requests and confirms abandoning a dirty editor", async () => {
    await render()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    await render({ addRequest: 1 })
    expect(document.querySelector('input[id$="-name"]')).toBeTruthy()
    await input('input[id$="-name"]', "draft")
    await click("取消")
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("放弃未保存")
    await click("继续编辑")
    expect(document.querySelector<HTMLInputElement>('input[id$="-name"]')?.value).toBe("draft")
    await click("取消")
    await click("放弃更改")
    await render({ query: "anything" })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(loadMcpStorage(localStorage, props.projectPath).document.servers).toEqual([])
    await render({ projectPath: "D:/another-project" })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it("preserves real fields through JSON → form → JSON and persists an edited command", async () => {
    await render()
    await render({ addRequest: 1 })
    await click("JSON")
    await input(
      "textarea",
      '{"name":"local","type":"stdio","command":"node","env":{"EMPTY":""}}'
    )
    await click("表单")
    await input('input[id$="-command"]', "bun")
    await click("JSON")
    expect(JSON.parse(document.querySelector("textarea")!.value)).toMatchObject({
      type: "stdio",
      command: "bun",
      env: { EMPTY: "" },
    })
    await click("保存")
    expect(loadMcpStorage(localStorage, props.projectPath).document.servers).toEqual([
      { name: "local", config: { type: "stdio", command: "bun", env: { EMPTY: "" } } },
    ])
    expect(container.querySelectorAll("[data-extension-row]")).toHaveLength(1)
    expect(container.textContent).toContain("未连接")
  })

  it("rejects a partially invalid batch without saving any server", async () => {
    await render()
    await render({ addRequest: 1 })
    await click("JSON")
    await input(
      "textarea",
      '{"mcpServers":{"good":{"type":"stdio","command":"node"},"bad":{"type":"http","url":"ftp://example.com"}}}'
    )
    await click("保存")
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("http")
    expect(loadMcpStorage(localStorage, props.projectPath).document.servers).toHaveLength(0)
  })

  it("filters persisted servers, refreshes local changes and requires confirmation to remove", async () => {
    saveMcpStorage(
      localStorage,
      props.projectPath,
      parseMcpJson(
        '{"mcpServers":{"alpha":{"type":"stdio","command":"node"},"beta":{"type":"http","url":"https://example.com/mcp","enabled":false}}}'
      ),
      null
    )
    await render()
    await click("已停用")
    expect(container.querySelectorAll("[data-extension-row]")).toHaveLength(1)
    expect(container.querySelector("[data-extension-row]")?.textContent).toContain("beta")
    await click("全部")
    await render({ query: "alpha" })
    expect(container.querySelectorAll("[data-extension-row]")).toHaveLength(1)
    await click("查看 alpha 的 MCP 配置")
    await click("移除")
    expect(loadMcpStorage(localStorage, props.projectPath).document.servers).toHaveLength(2)
    await click("移除配置")
    expect(
      loadMcpStorage(localStorage, props.projectPath).document.servers.map((s) => s.name)
    ).toEqual(["beta"])
    const current = loadMcpStorage(localStorage, props.projectPath)
    saveMcpStorage(
      localStorage,
      props.projectPath,
      parseMcpJson('{"name":"external","type":"stdio","command":"bun"}'),
      current.raw
    )
    await render({ refreshRequest: 1, query: "" })
    expect(container.textContent).toContain("external")
    expect(container.querySelectorAll("[data-extension-row]")).toHaveLength(1)
  })

  it("keeps a title-only empty state without starter templates", async () => {
    await render()

    expect(container.textContent).toContain("还没有 MCP")
    expect(container.textContent).not.toContain("尚未添加 MCP 服务器")
    expect(container.textContent).not.toContain("添加本地命令")
    expect(container.textContent).not.toContain("STDIO")
    expect(
      [...document.querySelectorAll("button")].filter(
        (item) => item.textContent?.trim() === "添加 MCP"
      )
    ).toHaveLength(0)
  })
})
