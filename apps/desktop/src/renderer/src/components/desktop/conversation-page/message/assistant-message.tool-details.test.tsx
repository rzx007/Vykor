// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { DesktopSessionPart } from "@shared/session-types"

vi.mock("@renderer/stores/desktop-session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@renderer/stores/desktop-session")>()
  return { ...actual, useDesktopSessionStore: () => null }
})

import { AssistantMessage } from "./assistant-message"

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT
})

function part(toolName: string, input: Record<string, unknown>, options: Partial<DesktopSessionPart> = {}): DesktopSessionPart {
  return {
    id: "tool-1", sessionId: "s1", messageId: "m1", seq: 1,
    type: "tool", toolUseId: "call-1", toolName, input,
    status: "completed", metadata: {}, createdAt: 1, updatedAt: 2,
    ...options,
  } as DesktopSessionPart
}

function render(parts: DesktopSessionPart[]) {
  act(() => root.render(<AssistantMessage parts={parts} streaming={false}
    onOpenFile={vi.fn()} canOpenReview={false} onOpenReview={vi.fn()} onOpenTerminal={vi.fn()} />))
}

function click(text: string) {
  const button = [...container.querySelectorAll("button")].find((item) => item.textContent?.includes(text))
  expect(button, `button containing ${text}`).toBeDefined()
  act(() => button!.click())
  return button!
}

describe("tool parameter and result display", () => {
  it("shows a wrapped failed edit's path, original parameters and result separately", () => {
    render([part("Edit", { arguments: { file_path: "C:/workspace/index.html", old_string: "original", new_string: "replacement" } }, {
      status: "failed", isError: true, output: { content: [{ type: "text", text: "old_string not found in file." }], isError: true },
    })])
    expect(container.textContent).not.toContain("编辑了 1 个文件")
    const group = click("文件编辑 1 次")
    expect(group.getAttribute("aria-expanded")).toBe("true")
    expect(container.textContent).toContain("C:/workspace/index.html")
    expect(container.textContent).toContain("失败")
    const row = click("编辑文件")
    expect(row.getAttribute("aria-expanded")).toBe("true")
    expect(container.textContent).toContain("参数")
    expect(container.textContent).toContain("结果")
    const blocks = [...container.querySelectorAll("pre")].map((element) => element.textContent)
    expect(blocks[0]).toContain('"arguments"')
    expect(blocks[0]).toContain('"old_string": "original"')
    expect(blocks[1]).toContain("old_string not found")
  })

  it("keeps command parameters visible after a result has arrived", () => {
    render([part("Shell", { arguments: { command: "Get-ChildItem -Force" } }, {
      output: { content: [{ type: "text", text: "files listed" }] },
    })])
    click("命令调用 1 次")
    expect(container.textContent).toContain("Get-ChildItem -Force")
    click("运行命令")
    const blocks = [...container.querySelectorAll("pre")].map((element) => element.textContent)
    expect(blocks[0]).toContain("Get-ChildItem -Force")
    expect(blocks[1]).toContain("files listed")
  })

  it("shows the completed-file summary when a legacy edit's result has arrived", () => {
    render([
      part("Edit", { arguments: { file_path: "index.html", old_string: "old", new_string: "new" } }, { status: "running" }),
      part("Edit", {}, { id: "result-1", seq: 2, type: "tool_result", output: "Successfully edited index.html", isError: false }),
    ])
    expect(container.textContent).toContain("已编辑 1 个文件")
    expect(container.textContent).toContain("index.html")
  })

  it("distinguishes invalid JSON from a legitimate empty input", () => {
    render([part("Shell", {}, {
      status: "failed", isError: true,
      metadata: { toolInputError: { reason: "invalid_json", argumentLength: 12 } },
      output: "Tool input parsing failed",
    })])
    click("命令调用 1 次")
    expect(container.textContent).toContain("参数解析失败")
    expect(container.textContent).not.toContain("无参数")
  })

  it("does not keep a completed legacy result shimmering or claim a failed command ran successfully", () => {
    render([
      part("Shell", { command: "exit 1" }, { status: "running" }),
      part("Shell", {}, { id: "result-1", seq: 2, type: "tool_result", isError: true, output: "exit code 1" }),
    ])
    click("命令调用 1 次")
    expect(container.textContent).toContain("失败")
    expect(container.querySelector(".shimmer")).toBeNull()
    click("运行命令")
    expect(container.textContent).toContain("exit code 1")
    expect(container.textContent).toContain('"command": "exit 1"')
  })
})
