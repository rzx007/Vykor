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
  ;(
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT
})

function part(
  toolName: string,
  input: Record<string, unknown>,
  options: Partial<DesktopSessionPart> = {}
): DesktopSessionPart {
  return {
    id: "tool-1",
    sessionId: "s1",
    messageId: "m1",
    seq: 1,
    type: "tool",
    toolUseId: "call-1",
    toolName,
    input,
    status: "completed",
    metadata: {},
    createdAt: 1,
    updatedAt: 2,
    ...options,
  } as DesktopSessionPart
}

function render(parts: DesktopSessionPart[], streaming = false) {
  act(() =>
    root.render(
      <AssistantMessage
        parts={parts}
        streaming={streaming}
        onOpenFile={vi.fn()}
        canOpenReview={false}
        onOpenReview={vi.fn()}
        onOpenTerminal={vi.fn()}
      />
    )
  )
}

function click(text: string) {
  const button = [...container.querySelectorAll("button")].find((item) =>
    item.textContent?.includes(text)
  )
  expect(button, `button containing ${text}`).toBeDefined()
  act(() => button!.click())
  return button!
}

describe("tool parameter and result display", () => {
  it("shows the first executing tool directly without a one-tool group", () => {
    render([part("Shell", { command: "npm run test" }, { status: "running" })], true)
    expect(container.textContent).toContain("运行命令")
    expect(container.textContent).toContain("npm run test")
    expect(container.textContent).not.toContain("命令调用 1 次")
    expect(container.querySelectorAll("button[aria-expanded]")).toHaveLength(1)
  })

  it("promotes consecutive tools into a group while preserving an opened first tool", () => {
    const first = part("Shell", { command: "npm run test" }, { status: "running" })
    const second = part(
      "Read",
      { file_path: "result.txt" },
      { id: "tool-2", toolUseId: "call-2", seq: 2 }
    )
    render([first], true)
    const firstButton = click("运行命令")
    render([first, second], true)
    const heading = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("命令调用 1 次，工具查看 1 次")
    )
    expect(heading?.getAttribute("aria-expanded")).toBe("true")
    expect(firstButton.isConnected).toBe(true)
    expect(firstButton.getAttribute("aria-expanded")).toBe("true")
    expect(container.querySelector("pre")?.textContent).toContain("npm run test")
    expect(container.textContent).toContain("读取文件")
  })

  it("collapses a new consecutive group when the first tool was not opened", () => {
    const first = part("Shell", { command: "first" }, { status: "running" })
    render([first], true)
    expect(container.textContent).toContain("运行命令")
    render(
      [
        first,
        { ...first, id: "tool-2", toolUseId: "call-2", seq: 2, input: { command: "second" } },
      ],
      true
    )
    expect(container.querySelectorAll("button[aria-expanded]")).toHaveLength(1)
    expect(container.querySelector("button[aria-expanded]")?.getAttribute("aria-expanded")).toBe(
      "false"
    )
    expect(container.textContent).toContain("命令调用 2 次")
    expect(container.textContent).not.toContain("运行命令")
  })

  it("keeps calls separated by narrative as independent tool rows", () => {
    render([
      part("Shell", { command: "first" }),
      part(
        "",
        {},
        { id: "narrative", seq: 2, type: "text", toolUseId: undefined, text: "接着检查结果" }
      ),
      part("Read", { file_path: "result.txt" }, { id: "tool-2", seq: 3, toolUseId: "call-2" }),
    ])
    expect(container.textContent).toContain("接着检查结果")
    expect(container.textContent).toContain("运行命令")
    expect(container.textContent).toContain("读取文件")
    expect(container.textContent).not.toMatch(/命令调用|工具查看/)
    expect(container.querySelectorAll("button[aria-expanded]")).toHaveLength(2)
  })
  it.each(["Agent", "ImageGeneration", "BackgroundShellCreate", "ImageToText"])(
    "shows %s generation as a compact non-expandable status",
    (toolName) => {
      render([
        part(
          toolName,
          {},
          {
            id: "ui-tool-generation:r:g:1:0",
            input: undefined,
            toolUseId: undefined,
            status: "running",
            metadata: {
              uiToolGeneration: true,
              toolProgress: {
                phase: "generating",
                receivedChars: 100,
                executionState: "not_started",
              },
            },
          }
        ),
      ])
      expect(container.textContent).toContain(toolName)
      expect(container.textContent).toContain("生成参数")
      expect(container.textContent).toContain("100")
      expect(container.textContent).not.toContain("未执行")
      expect(container.textContent).not.toMatch(/文件编辑|工具查看|命令调用/)
      expect(container.querySelector("button[aria-expanded]")).toBeNull()
      expect(
        container.querySelector('[role="img"][aria-label="正在生成参数，尚未执行"]')
      ).not.toBeNull()
    }
  )

  it("shows a generating Write once without repeated status or empty detail panels", () => {
    render([
      part(
        "Write",
        {},
        {
          id: "ui-tool-generation:r:g:1:0",
          input: undefined,
          toolUseId: undefined,
          status: "running",
          metadata: {
            uiToolGeneration: true,
            toolProgress: {
              phase: "generating",
              receivedChars: 9337,
              executionState: "not_started",
            },
          },
        }
      ),
    ])
    expect(container.textContent).toContain("Write")
    expect(container.textContent).toContain("9,337")
    expect(container.textContent?.match(/生成参数/g)).toHaveLength(1)
    expect(container.textContent?.match(/9,337/g)).toHaveLength(1)
    expect(container.textContent).not.toContain("未执行")
    expect(container.textContent).not.toMatch(/文件编辑|工具查看|命令调用/)
    expect(container.textContent).not.toContain("参数尚未完整")
    expect(container.textContent).not.toContain("工具尚未执行")
    expect(container.textContent).not.toContain("等待工具返回结果")
    expect(container.querySelector("button[aria-expanded]")).toBeNull()
    expect(container.querySelector("pre")).toBeNull()
    const group = container.querySelector("section")
    expect(group).not.toBeNull()
    expect(group!.getAttribute("aria-label")).toBe("工具活动组")
    expect(group!.textContent).toContain("Write")
  })

  it("keeps completed Read and generating Write in one collapsible tool group", () => {
    render([
      part("Read", { file_path: "index.html" }, { output: "file content" }),
      part(
        "Write",
        {},
        {
          id: "ui-tool-generation:r:g:1:0",
          seq: 2,
          input: undefined,
          toolUseId: undefined,
          status: "running",
          metadata: {
            uiToolGeneration: true,
            toolProgress: {
              phase: "generating",
              receivedChars: 100,
              executionState: "not_started",
            },
          },
        }
      ),
    ])
    const group = container.querySelector("section")
    expect(group).not.toBeNull()
    expect(group!.textContent).toContain("Write")
    expect(group!.getAttribute("aria-label")).toBe("工具活动组")
    const heading = group!.querySelector<HTMLButtonElement>("button[aria-expanded]")
    expect(heading?.getAttribute("aria-expanded")).toBe("false")
    expect(heading?.textContent).toContain("工具查看 1 次")
    expect(heading?.textContent).toContain("Write")
    expect(heading?.textContent).not.toMatch(/文件编辑|工具调用 2 次/)
    expect(group!.querySelectorAll("pre")).toHaveLength(0)
    act(() => heading!.click())
    const read = [...group!.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")].find(button => button.textContent?.includes("读取文件"))
    expect(read).toBeDefined()
    expect(group!.textContent).toContain("Write")
    expect(group!.textContent?.match(/生成参数/g)).toHaveLength(2)
    expect([...group!.querySelectorAll("button[aria-expanded]")].filter(button => button !== heading)
      .some(button => button.textContent?.includes("Write"))).toBe(false)
    expect(group!.querySelectorAll("pre")).toHaveLength(0)
    act(() => read!.click())
    expect(group!.textContent).toContain("file content")
    expect(group!.querySelectorAll("pre")).toHaveLength(2)
  })

  it("names an all-generating group without counting unsubmitted calls", () => {
    const generated = part("Write", {}, { id: "ui-tool-generation:r:g:1:0", input: undefined,
      toolUseId: undefined, status: "running", metadata: { uiToolGeneration: true,
        toolProgress: { phase: "generating", receivedChars: 10, executionState: "not_started" } } })
    render([generated, { ...generated, id: "ui-tool-generation:r:g:1:1", seq: 2, toolName: "Read" }])
    const group = container.querySelector('section[aria-label="工具活动组"]')
    expect(group).not.toBeNull()
    const heading = group!.querySelector<HTMLButtonElement>("button[aria-expanded]")
    expect(heading?.textContent).toContain("Write")
    expect(heading?.textContent).toContain("Read")
    expect(heading?.textContent).not.toMatch(/工具调用|工具查看|文件编辑/)
    act(() => heading!.click())
    expect(group!.querySelectorAll('[role="img"][aria-label="正在生成参数，尚未执行"]')).toHaveLength(2)
    expect(group!.querySelectorAll("button[aria-expanded]")).toHaveLength(1)
    expect(group!.querySelector("pre")).toBeNull()
  })

  it("shows permission and queue phases in the collapsed heading and ignores stale terminal progress", () => {
    render([
      part(
        "Write",
        { file_path: "a.ts" },
        { status: "running", metadata: { toolProgress: { phase: "waiting_permission" } } }
      ),
    ])
    expect(container.textContent).toContain("等待你的确认")
    render([
      part(
        "Write",
        { file_path: "a.ts" },
        { status: "failed", metadata: { toolProgress: { phase: "running" } } }
      ),
    ])
    expect(container.textContent).not.toContain("正在执行工具")
    expect(container.querySelector(".shimmer")).toBeNull()
  })
  it("keeps a returned tool visible without pretending it is still executing", () => {
    render([
      part(
        "Write",
        { file_path: "a.ts" },
        {
          status: "running",
          metadata: { toolProgress: { phase: "completed", executionState: "completed" } },
        }
      ),
    ])
    expect(container.textContent).toContain("工具已返回，等待本轮结果")
    expect(container.querySelector(".shimmer")).toBeNull()
  })
  it("shows a background command directly without claiming a file edit", () => {
    render([part("BackgroundShellCreate", { command: "npm run dev" })])
    expect(container.textContent).toContain("npm run dev")
    expect(container.querySelectorAll("button[aria-expanded]")).toHaveLength(1)
    expect(container.textContent).not.toContain("命令调用 1 次")
    expect(container.textContent).not.toContain("文件编辑")
  })

  it("keeps command, edit and read counts separate in a mixed group", () => {
    render([
      part("BackgroundShellCreate", { command: "npm run dev" }),
      part("Read", { file_path: "index.html" }, { id: "tool-2", seq: 2, toolUseId: "call-2" }),
      part("Write", { file_path: "style.css" }, { id: "tool-3", seq: 3, toolUseId: "call-3" }),
    ])
    expect(container.textContent).toContain("文件编辑 1 次，命令调用 1 次，工具查看 1 次")
  })

  it("shows a wrapped failed edit's path, original parameters and result separately", () => {
    render([
      part(
        "Edit",
        {
          arguments: {
            file_path: "C:/workspace/index.html",
            old_string: "original",
            new_string: "replacement",
          },
        },
        {
          status: "failed",
          isError: true,
          output: {
            content: [{ type: "text", text: "old_string not found in file." }],
            isError: true,
          },
        }
      ),
    ])
    expect(container.textContent).not.toContain("编辑了 1 个文件")
    const row = click("编辑文件")
    expect(row.getAttribute("aria-expanded")).toBe("true")
    expect(container.textContent).toContain("C:/workspace/index.html")
    expect(container.textContent).toContain("失败")
    expect(container.textContent).toContain("参数")
    expect(container.textContent).toContain("结果")
    const blocks = [...container.querySelectorAll("pre")].map((element) => element.textContent)
    expect(blocks[0]).toContain('"arguments"')
    expect(blocks[0]).toContain('"old_string": "original"')
    expect(blocks[1]).toContain("old_string not found")
  })

  it("keeps command parameters visible after a result has arrived", () => {
    render([
      part(
        "Shell",
        { arguments: { command: "Get-ChildItem -Force" } },
        {
          output: { content: [{ type: "text", text: "files listed" }] },
        }
      ),
    ])
    expect(container.textContent).toContain("Get-ChildItem -Force")
    click("运行命令")
    const blocks = [...container.querySelectorAll("pre")].map((element) => element.textContent)
    expect(blocks[0]).toContain("Get-ChildItem -Force")
    expect(blocks[1]).toContain("files listed")
  })

  it("shows the completed-file summary when a legacy edit's result has arrived", () => {
    render([
      part(
        "Edit",
        { arguments: { file_path: "index.html", old_string: "old", new_string: "new" } },
        { status: "running" }
      ),
      part(
        "Edit",
        {},
        {
          id: "result-1",
          seq: 2,
          type: "tool_result",
          output: "Successfully edited index.html",
          isError: false,
        }
      ),
    ])
    expect(container.textContent).toContain("已编辑 1 个文件")
    expect(container.textContent).toContain("index.html")
  })

  it("distinguishes invalid JSON from a legitimate empty input", () => {
    render([
      part(
        "Shell",
        {},
        {
          status: "failed",
          isError: true,
          metadata: { toolInputError: { reason: "invalid_json", argumentLength: 12 } },
          output: "Tool input parsing failed",
        }
      ),
    ])
    click("运行命令")
    expect(container.textContent).toContain("参数解析失败")
    expect(container.textContent).not.toContain("无参数")
  })

  it("does not keep a completed legacy result shimmering or claim a failed command ran successfully", () => {
    render([
      part("Shell", { command: "exit 1" }, { status: "running" }),
      part(
        "Shell",
        {},
        { id: "result-1", seq: 2, type: "tool_result", isError: true, output: "exit code 1" }
      ),
    ])
    click("运行命令")
    expect(container.textContent).toContain("失败")
    expect(container.querySelector(".shimmer")).toBeNull()
    expect(container.textContent).toContain("exit code 1")
    expect(container.textContent).toContain('"command": "exit 1"')
  })
})
