// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { toMcpForm } from "./mcp-config"
import { McpFormFields } from "./mcp-form"

describe("McpFormFields layout", () => {
  let root: Root
  let host: HTMLDivElement

  beforeEach(() => {
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
    host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT
  })

  async function render(
    type: "stdio" | "http" = "stdio",
    options: { nameLocked?: boolean } = {}
  ): Promise<void> {
    const value = toMcpForm({
      name: "srv",
      config: type === "stdio" ? { type, command: "" } : { type, url: "" },
    })
    await act(async () => {
      root.render(
        <McpFormFields
          value={value}
          error=""
          errorId="mcp-error"
          onChange={() => undefined}
          nameLocked={options.nameLocked}
        />
      )
    })
  }

  it("renders the STDIO form with real fields only", async () => {
    await render()

    expect(host.textContent).toContain("名称")
    expect(host.textContent).toContain("类型")
    expect(host.textContent).toContain("启动命令")
    expect(host.textContent).toContain("参数")
    expect(host.textContent).toContain("环境变量")
    expect(host.textContent).toContain("工作目录")
    expect(host.textContent).toContain("STDIO")
    expect(host.textContent).toContain("流式 HTTP")
    expect(host.querySelector('input[placeholder="MCP server name"]')).not.toBeNull()
    expect(host.querySelector('input[placeholder="openai-dev-mcp serve-sqlite"]')).not.toBeNull()
    expect(host.querySelector('input[placeholder="~/code"]')).not.toBeNull()
    expect(host.textContent).toContain("添加参数")
    expect(host.textContent).toContain("添加环境变量")
    expect(host.textContent).not.toContain("环境变量传递")
    expect(host.textContent).not.toContain("Bearer 令牌环境变量")
    expect(host.querySelectorAll("[data-mcp-form-card]")).toHaveLength(2)
  })

  it("renders the HTTP form with URL, headers and OAuth scopes", async () => {
    await render("http")

    expect(host.textContent).toContain("URL")
    expect(host.textContent).toContain("标头")
    expect(host.textContent).toContain("OAuth scopes")
    expect(host.querySelector('input[placeholder="https://mcp.example.com/mcp"]')).not.toBeNull()
    expect(host.textContent).toContain("添加标头")
    expect(host.textContent).not.toContain("Bearer 令牌环境变量")
    expect(host.textContent).not.toContain("来自环境变量的标头")
  })

  it("locks the name when editing an existing server", async () => {
    await render("stdio", { nameLocked: true })

    const name = host.querySelector<HTMLInputElement>('input[id$="-name"]')!
    expect(name.disabled).toBe(true)
    expect(host.textContent).toContain("名称不可修改")
  })
})
