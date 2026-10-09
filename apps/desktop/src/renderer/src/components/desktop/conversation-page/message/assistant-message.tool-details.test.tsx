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
import { TooltipProvider } from "@renderer/components/ui/tooltip"
import { sourcePart as pluginSource } from "../plugin-ui/plugin-ui-fixtures.test-support"
import { summarizePart } from "../../../../../../../../../packages/server/src/http/part-wire-view.js"
import { buildAssistantContent } from "./message-render-model"
import { useToolDetails } from "./use-tool-details"
import { ImageViewerProvider } from "@renderer/components/desktop/image-viewer/image-viewer-provider"

const openReadImage = vi.fn()

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
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  openReadImage.mockClear()
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
      <ImageViewerProvider onOpenImage={openReadImage}><TooltipProvider><AssistantMessage
        parts={parts}
        streaming={streaming}
        onOpenFile={vi.fn()}
        canOpenReview={false}
        onOpenReview={vi.fn()}
        onOpenTerminal={vi.fn()}
      /></TooltipProvider></ImageViewerProvider>
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

describe("Read image previews", () => {
  it("uses the canonical Read record when a legacy result has a null body", async () => {
    const readToolImagePreview = vi.fn().mockResolvedValue({ bytes: new ArrayBuffer(8), mediaType: "image/png" })
    vi.stubGlobal("desktop", { sessions: { readToolImagePreview } })
    vi.stubGlobal("URL", { createObjectURL: vi.fn().mockReturnValue("blob:legacy"), revokeObjectURL: vi.fn() })
    const call = part("Read", { file_path: "legacy.png" }, { output: { content: [{ type: "image", source: { type: "file", path: "legacy.png", mediaType: "image/png" } }] } })
    const result = { ...call, id: "legacy-result", type: "tool_result", seq: 2, output: null } as DesktopSessionPart
    render([call, result])
    await act(async () => click("读取文件"))
    expect(readToolImagePreview).toHaveBeenCalledWith({ sessionId: call.sessionId, messageId: call.messageId, partId: call.id })
  })
  it("loads on expansion, keeps two previews open, and opens the existing viewer", async () => {
    const readToolImagePreview = vi.fn().mockResolvedValue({ bytes: new ArrayBuffer(8), mediaType: "image/png" })
    vi.stubGlobal("desktop", { sessions: { readToolImagePreview } })
    vi.stubGlobal("URL", { createObjectURL: vi.fn().mockReturnValue("blob:preview"), revokeObjectURL: vi.fn() })
    const first = part("Read", { file_path: "C:\\Temp\\first.png" })
    const second = { ...part("Read", { file_path: "second.png" }), id: "read-2", seq: 2 }
    render([first, second])
    expect(readToolImagePreview).not.toHaveBeenCalled()
    act(() => click("工具查看"))
    await act(async () => click("first.png"))
    expect(readToolImagePreview).toHaveBeenCalledWith({ sessionId: first.sessionId, messageId: first.messageId, partId: first.id })
    expect(container.querySelector('img[alt="first.png"]')).not.toBeNull()
    await act(async () => { click("second.png") })
    expect(container.querySelectorAll("img")).toHaveLength(2)
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="查看图片 first.png"]')!.click())
    expect(openReadImage).toHaveBeenCalledWith(expect.objectContaining({ kind: "file", path: "C:\\Temp\\first.png", mediaType: "image/png" }))
    act(() => click("first.png"))
    expect(container.querySelector('img[alt="first.png"]')).toBeNull()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview")
  })
  it("shows read failures and can retry", async () => {
    const readToolImagePreview = vi.fn().mockRejectedValueOnce(new Error("图片文件已不存在")).mockResolvedValueOnce({ bytes: new ArrayBuffer(8), mediaType: "image/png" })
    vi.stubGlobal("desktop", { sessions: { readToolImagePreview } })
    vi.stubGlobal("URL", { createObjectURL: vi.fn().mockReturnValue("blob:retry"), revokeObjectURL: vi.fn() })
    render([part("Read", { file_path: "missing.png" })])
    await act(async () => click("读取文件"))
    expect(container.textContent).toContain("图片文件已不存在")
    await act(async () => click("重试"))
    expect(container.querySelector('img[alt="missing.png"]')).not.toBeNull()
  })
  it("ignores a response after collapse", async () => {
    let resolvePreview!: (preview: unknown) => void
    const readToolImagePreview = vi.fn().mockReturnValue(new Promise(resolve => { resolvePreview = resolve }))
    const createObjectURL = vi.fn()
    vi.stubGlobal("desktop", { sessions: { readToolImagePreview } })
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL: vi.fn() })
    render([part("Read", { file_path: "late.png" })])
    await act(async () => click("读取文件"))
    expect(readToolImagePreview).toHaveBeenCalledTimes(1)
    act(() => click("读取文件"))
    await act(async () => resolvePreview({ bytes: new ArrayBuffer(8), mediaType: "image/png" }))
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(container.querySelector("img")).toBeNull()
  })
})

describe("tool parameter and result display", () => {
  it("keeps preview semantics when a separate legacy Plugin UI result has null output", async () => {
    const full = { ...pluginSource, output: "CANONICAL_PLUGIN_BODY" }
    const getMessagePart = vi.fn().mockResolvedValue(full)
    vi.stubGlobal("desktop", { sessions: { getMessagePart } })
    render([{ ...pluginSource, output: "PLUGIN_PREVIEW", bodyView: { input: "unavailable", output: "preview" } }, { ...pluginSource, id: "legacy-result", seq: 2, type: "tool_result", output: null, metadata: {} }])
    expect(container.textContent).toContain("结果预览")
    const details = container.querySelector("details")!
    await act(async () => { details.open = true; details.dispatchEvent(new Event("toggle")); })
    expect(container.textContent).toContain("CANONICAL_PLUGIN_BODY")
    expect(getMessagePart).toHaveBeenCalledTimes(1)
  })
  it("reads only canonical bodies while live status and metadata stay owned by the current part", async () => {
    const source = part("Write", {}, { status: "failed", isError: true, metadata: { fact: "CURRENT_FACT" }, bodyView: { input: "preview", output: "unavailable" } })
    const getMessagePart = vi.fn().mockResolvedValue({ ...source, status: "completed", isError: false, metadata: { fact: "OLD_FACT" }, input: { content: "CANONICAL_BODY" }, output: "CANONICAL_OUTPUT" })
    vi.stubGlobal("desktop", { sessions: { getMessagePart } })
    function Probe() {
      const detail = useToolDetails(source, undefined, true)
      return <p>{detail.call.status} {String(detail.call.isError)} {String(detail.call.metadata.fact)} {String(detail.call.input?.content ?? "")} {String(detail.call.output ?? "")}</p>
    }
    await act(async () => { root.render(<Probe />) })
    expect(container.textContent).toContain("failed true CURRENT_FACT")
    expect(container.textContent).toContain("CANONICAL_BODY")
    expect(container.textContent).toContain("CANONICAL_OUTPUT")
    expect(container.textContent).not.toContain("OLD_FACT")
  })
  it("keeps the existing Agent task button linked after summarizing a legal long description", () => {
    const description = "a".repeat(5000)
    const summary = summarizePart(part("Agent", { description }, { output: { content: [{ type: "text", text: JSON.stringify({ kind: "job", action: "created", jobKind: "agent", jobId: "task-real", label: description }) }] } }) as any) as DesktopSessionPart
    const openAgents = vi.fn()
    act(() => root.render(<TooltipProvider><AssistantMessage parts={[summary]} tasks={[{ id: "task-real", sessionId: "s1", childSessionId: "child-real", type: "agent", status: "running", description, cwd: "/repo", metadata: {}, createdAt: 1, updatedAt: 1 }]} streaming={false} onOpenAgents={openAgents} onOpenFile={vi.fn()} canOpenReview={false} onOpenReview={vi.fn()} onOpenTerminal={vi.fn()} /></TooltipProvider>))
    const button = container.querySelector<HTMLButtonElement>("[data-agent-activity]")!
    expect(button.disabled).toBe(false)
    act(() => button.click())
    expect(openAgents).toHaveBeenCalledWith("task-real")
    expect(container.textContent).toContain("运行中")
  })
  it("uses the retained ImageGeneration ratio for its placeholder and generated gallery", () => {
    const summary = summarizePart(part("ImageGeneration", { prompt: "p".repeat(5000), ratio: "16:9" }, { status: "running" }) as any) as DesktopSessionPart
    render([summary], true)
    expect(container.querySelector('[data-image-ratio="16:9"]')).not.toBeNull()
    const attachment: DesktopSessionPart = { id: "image", sessionId: "s1", messageId: "m1", seq: 2, type: "attachment", status: "completed", assetId: "image-asset", intent: "tool_resource", displayName: "image.png", mediaType: "image/png", sizeBytes: 1, metadata: { source: "image_generation", toolUseId: summary.toolUseId }, createdAt: 1, updatedAt: 2 }
    expect(buildAssistantContent([{ ...summary, status: "completed" }, attachment]).find(unit => unit.type === "generated_attachments")).toMatchObject({ ratio: "16:9" })
  })
  it.each(["plugin", "image"] as const)("states unavailable %s detail without disguising the remaining preview", async kind => {
    const getMessagePart = vi.fn().mockRejectedValue(new Error("404 unavailable"))
    vi.stubGlobal("desktop", { sessions: { getMessagePart } })
    const preview = kind === "plugin" ? { ...pluginSource, output: "REMAINING_PREVIEW", bodyView: { input: "unavailable", output: "preview" } } as DesktopSessionPart
      : part("ImageGeneration", {}, { status: "failed", output: "REMAINING_PREVIEW", bodyView: { input: "full", output: "preview" } })
    render([preview])
    const details = container.querySelector("details")!
    await act(async () => { details.open = true; details.dispatchEvent(new Event("toggle")); })
    expect(container.textContent).toContain("完整详情不可用")
    expect(container.textContent).toContain("REMAINING_PREVIEW")
    expect(getMessagePart).toHaveBeenCalledTimes(1)
  })
  it.each(["session", "part"] as const)("ignores a late detail after a %s identity switch", async changed => {
    let resolveOld!: (value: DesktopSessionPart) => void
    const full = part("Write", { content: "OLD_SCOPE_BODY" })
    const next = { ...full, sessionId: changed === "session" ? "s2" : full.sessionId, id: changed === "part" ? "part-2" : full.id, input: { content: "NEW_SCOPE_BODY" } }
    const getMessagePart = vi.fn().mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve })).mockResolvedValueOnce(next)
    vi.stubGlobal("desktop", { sessions: { getMessagePart } })
    const preview = { ...full, input: { file_path: "a.ts" }, bodyView: { input: "preview", output: "unavailable" } } as DesktopSessionPart
    render([preview]); click("写入")
    await act(async () => { render([{ ...next, input: preview.input, bodyView: preview.bodyView }]); })
    if (changed === "part") await act(async () => { click("写入"); })
    await act(async () => { resolveOld(full); })
    expect(container.textContent).toContain("NEW_SCOPE_BODY")
    expect(container.textContent).not.toContain("OLD_SCOPE_BODY")
  })
  it("ignores a late response after the detail is unmounted and reopened", async () => {
    let resolveOld!: (value: DesktopSessionPart) => void
    const full = part("Write", { content: "UNMOUNTED_BODY" })
    const getMessagePart = vi.fn().mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve })).mockResolvedValueOnce({ ...full, input: { content: "REOPENED_BODY" } })
    vi.stubGlobal("desktop", { sessions: { getMessagePart } })
    const preview = { ...full, input: { file_path: "a.ts" }, bodyView: { input: "preview", output: "unavailable" } } as DesktopSessionPart
    render([preview]); click("写入")
    render([])
    render([preview])
    await act(async () => { click("写入"); resolveOld(full); })
    expect(container.textContent).toContain("REOPENED_BODY")
    expect(container.textContent).not.toContain("UNMOUNTED_BODY")
  })
  it("marks Plugin UI result text as preview and reads the canonical body only on expansion", async () => {
    const full = { ...pluginSource, output: { content: [{ type: "text", text: "PLUGIN_FULL_BODY" }] } }
    const getMessagePart = vi.fn().mockResolvedValue(full)
    vi.stubGlobal("desktop", { sessions: { getMessagePart } })
    render([{ ...pluginSource, output: { content: [{ type: "text", text: "PLUGIN_PREVIEW" }] }, bodyView: { input: "unavailable", output: "preview" } }])
    expect(container.textContent).toContain("结果预览")
    expect(getMessagePart).not.toHaveBeenCalled()
    const details = container.querySelector("details")!
    expect(details).not.toBeNull()
    await act(async () => { details.open = true; details.dispatchEvent(new Event("toggle")); })
    expect(container.textContent).toContain("PLUGIN_FULL_BODY")
    expect(getMessagePart).toHaveBeenCalledWith({ sessionId: "session", messageId: "message", partId: "part" })
  })
  it("marks previewed image failure output and reads it only when its existing details open", async () => {
    const full = part("ImageGeneration", { ratio: "16:9" }, { status: "failed", output: "IMAGE_COMPLETE_ERROR" })
    const getMessagePart = vi.fn().mockResolvedValue(full)
    vi.stubGlobal("desktop", { sessions: { getMessagePart } })
    render([{ ...full, output: "IMAGE_PREVIEW", bodyView: { input: "full", output: "preview" } }])
    expect(container.textContent).toContain("预览")
    expect(getMessagePart).not.toHaveBeenCalled()
    const details = container.querySelector("details")!
    await act(async () => { details.open = true; details.dispatchEvent(new Event("toggle")); })
    expect(container.textContent).toContain("IMAGE_COMPLETE_ERROR")
    expect(getMessagePart).toHaveBeenCalledTimes(1)
  })
  it.each(["completed", "failed"] as const)("invalidates loaded details for a same-timestamp %s result", async status => {
    const running = part("Write", { content: "FULL_INPUT" }, { status: "running", output: undefined })
    const finished = { ...running, status, isError: status === "failed", output: { content: [{ type: "text", text: "NEW_TERMINAL_RESULT" }] } }
    const getMessagePart = vi.fn().mockResolvedValueOnce(running).mockResolvedValueOnce(finished)
    vi.stubGlobal("desktop", { sessions: { getMessagePart } })
    const summary = { ...running, input: { file_path: "a.ts" }, bodyView: { input: "preview", output: "unavailable" } } as DesktopSessionPart
    render([summary])
    await act(async () => { click("写入"); })
    expect(container.textContent).toContain("FULL_INPUT")
    await act(async () => { render([{ ...finished, input: summary.input, bodyView: { input: "preview", output: "full" } } as DesktopSessionPart]); })
    expect(container.textContent).toContain("NEW_TERMINAL_RESULT")
    expect(getMessagePart).toHaveBeenCalledTimes(2)
  })
  it("discards a late running result when completion shares its timestamp", async () => {
    let resolveRunning!: (part: DesktopSessionPart) => void
    const running = part("Write", { content: "STALE_RUNNING" }, { status: "running", output: undefined })
    const completed = { ...running, status: "completed" as const, input: { content: "CURRENT_INPUT" }, output: "CURRENT_RESULT" }
    const getMessagePart = vi.fn().mockReturnValueOnce(new Promise(resolve => { resolveRunning = resolve })).mockResolvedValueOnce(completed)
    vi.stubGlobal("desktop", { sessions: { getMessagePart } })
    const summary = { ...running, input: { file_path: "a.ts" }, bodyView: { input: "preview", output: "unavailable" } } as DesktopSessionPart
    render([summary]); click("写入")
    await act(async () => { render([{ ...completed, input: summary.input, bodyView: { input: "preview", output: "full" } } as DesktopSessionPart]); })
    await act(async () => { resolveRunning(running); })
    expect(container.textContent).toContain("CURRENT_RESULT")
    expect(container.textContent).not.toContain("STALE_RUNNING")
  })
  it("states bounded executed file identities without claiming the shown count is the total", () => {
    render([part("ApplyPatch", {}, { bodyView: { input: "preview", output: "full" }, output: { content: [{ type: "text", text: "applied" }] }, metadata: { executionState: "completed", changedFiles: { files: [{ path: "a.ts", operation: "update" }], fileCount: 40, truncated: true } } } as any)])
    expect(container.textContent).toContain("工具文件列表仅显示 1 / 40 个文件")
    expect(container.textContent).toContain("a.ts")
  })
  it("loads full previewed arguments only after expansion and states unavailable detail", async () => {
    const getMessagePart = vi.fn().mockResolvedValue(part("Write", { content: "FULL_WRITE_BODY" }));
    vi.stubGlobal("desktop", { sessions: { getMessagePart } });
    render([part("Write", { file_path: "sample.ts" }, { bodyView: { input: "preview", output: "unavailable" } } as any)]);
    expect(getMessagePart).not.toHaveBeenCalled();
    await act(async () => { click("写入"); });
    expect(container.textContent).toContain("FULL_WRITE_BODY");
    expect(getMessagePart).toHaveBeenCalledWith({ sessionId: "s1", messageId: "m1", partId: "tool-1" });
    getMessagePart.mockRejectedValue(new Error("expired"));
    click("写入");
    await act(async () => { click("写入"); });
    expect(container.textContent).toContain("完整详情不可用");
    expect(container.textContent).not.toContain("FULL_WRITE_BODY");
    vi.unstubAllGlobals();
  });
  it("ignores an older detail request after switching the expanded part's revision", async () => {
    let resolveOld!: (value: DesktopSessionPart) => void
    const older = new Promise<DesktopSessionPart>(resolve => { resolveOld = resolve })
    const getMessagePart = vi.fn().mockReturnValueOnce(older).mockResolvedValueOnce(part("Write", { content: "CURRENT_FULL_BODY" }, { updatedAt: 3 }))
    vi.stubGlobal("desktop", { sessions: { getMessagePart } })
    const summary = part("Write", { file_path: "sample.ts" }, { bodyView: { input: "preview", output: "unavailable" } } as any)
    render([summary])
    click("写入")
    await act(async () => { render([{ ...summary, updatedAt: 3 }]); })
    expect(container.textContent).toContain("CURRENT_FULL_BODY")
    await act(async () => { resolveOld(part("Write", { content: "STALE_FULL_BODY" })); })
    expect(container.textContent).not.toContain("STALE_FULL_BODY")
    expect(container.textContent).toContain("CURRENT_FULL_BODY")
  })
  it("keeps permission feedback visible without a redundant running label in production", () => {
    vi.stubEnv("DEV", false)
    render([
      part(
        "Shell",
        { command: "first" },
        { status: "running", metadata: { toolProgress: { phase: "waiting_permission" } } }
      ),
    ])
    expect(container.textContent).toContain("等待你的确认")
    render([
      part(
        "Shell",
        { command: "first" },
        { status: "running", metadata: { toolProgress: { phase: "running" } } }
      ),
    ])
    expect(container.textContent).not.toContain("正在执行工具")
  })
  it.each([true, false])(
    "shows diagnostic tool states only in dev=%s while preserving raw results",
    (dev) => {
      vi.stubEnv("DEV", dev)
      render([
        part(
          "Shell",
          { command: "exit 1" },
          { status: "failed", isError: true, output: "exit code 1" }
        ),
      ])
      expect(container.textContent).not.toContain("失败")
      expect(Boolean(container.querySelector('[data-tool-diagnostic][aria-label="失败"]'))).toBe(
        dev
      )
      expect(container.querySelector(".text-destructive")).toBeNull()
      if (dev) {
        const dot = container.querySelector<HTMLElement>("[data-tool-diagnostic]")!
        expect(dot.textContent).toBe("")
        expect(dot.title).toBe("失败")
      }
      click("运行命令")
      expect(container.textContent).toContain("exit code 1")
      render([
        part("Shell", { command: "first" }, { status: "failed", isError: true }),
        part(
          "Shell",
          { command: "second" },
          {
            id: "second",
            toolUseId: "second",
            seq: 2,
            status: "running",
            metadata: { executionState: "unknown" },
          }
        ),
      ])
      expect(container.textContent).not.toContain("次失败")
      expect(container.textContent).not.toContain("结果不确定")
      expect(Boolean(container.querySelector("[data-tool-diagnostic]"))).toBe(dev)
      expect(container.querySelector(".shimmer")).toBeNull()
      click("命令调用 2 次")
      expect(container.textContent).not.toContain("结果不确定")
      expect(
        Boolean(container.querySelector('[data-tool-diagnostic][aria-label*="结果不确定"]'))
      ).toBe(dev)
      render([
        part(
          "Shell",
          {},
          {
            id: "invalid",
            toolUseId: "invalid",
            status: "failed",
            isError: true,
            metadata: { toolInputError: { reason: "invalid_json" } },
            output: "Invalid JSON",
          }
        ),
      ])
      expect(container.textContent).not.toContain("参数解析失败")
      click("运行命令")
      expect(container.textContent?.includes("参数解析失败")).toBe(dev)
      expect(container.textContent).toContain("Invalid JSON")
    }
  )
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
  it.each([
    ["Agent", "调用子智能体"],
    ["ImageGeneration", "生成图片"],
    ["BackgroundShellCreate", "创建后台终端"],
    ["ImageToText", "识别图片文字"],
  ])("shows %s generation as a compact non-expandable status", (toolName, actionName) => {
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
    expect(container.textContent).toContain(actionName)
    expect(container.textContent).not.toContain(toolName)
    expect(container.textContent).not.toContain("准备中")
    expect(container.textContent).not.toMatch(/生成参数|100|字符/)
    expect(container.textContent).not.toContain("未执行")
    expect(container.textContent).not.toMatch(/文件编辑|工具查看|命令调用/)
    expect(container.querySelector("button[aria-expanded]")).toBeNull()
    expect(
      container.querySelector('[role="img"][aria-label="正在生成工具参数，尚未开始执行"]')
    ).not.toBeNull()
  })

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
    expect(container.textContent).toContain("写入文件")
    expect(container.textContent).not.toContain("准备中")
    expect(container.textContent).not.toMatch(/Write|生成参数|9,337|字符/)
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
    expect(group!.textContent).toContain("写入文件")
  })

  it("reveals the complete target and received count on keyboard focus without a details button", async () => {
    render([part("Write", {}, {
      id: "ui-tool-generation:r:g:1:0", input: undefined, toolUseId: undefined, status: "running",
      metadata: { uiToolGeneration: true, toolProgress: {
        phase: "generating", filePath: "C:/a/long/workspace/path/fixture/index.html", receivedChars: 9337, executionState: "not_started",
      } },
    })])
    const row = container.querySelector<HTMLElement>('[data-slot="tooltip-trigger"][tabindex="0"]')!
    expect(row).not.toBeNull()
    expect(row.textContent).toContain("index.html")
    expect(row.textContent).toContain("fixture/index.html")
    expect(row.textContent).not.toContain("C:/a/long/workspace/path")
    expect(row.textContent).not.toMatch(/9337|字符|生成参数|准备中/)
    expect(row.querySelectorAll('[aria-label="正在生成文件内容，尚未开始执行"]')).toHaveLength(1)
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }))
      row.focus()
    })
    expect(document.activeElement).toBe(row)
    const tooltip = document.querySelector('[role="tooltip"]')
    expect(tooltip?.textContent).toContain("C:/a/long/workspace/path/fixture/index.html")
    expect(tooltip?.textContent).toContain("已接收 9337 字符；尚未开始执行")
    expect(row.getAttribute("aria-describedby")).toBe(tooltip?.id)
    expect(container.querySelector("pre")).toBeNull()
    expect(container.querySelector("button[aria-expanded]")).toBeNull()
  })

  it("keeps completed Read and generating Write in one collapsible tool group", () => {
    render([
      part("Read", { file_path: "source.html" }, { output: "file content" }),
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
              receivedChars: 9337,
              filePath: "C:/fixture/index.html",
              executionState: "not_started",
            },
          },
        }
      ),
    ])
    const group = container.querySelector("section")
    expect(group).not.toBeNull()
    expect(group!.textContent).toContain("写入文件")
    expect(group!.getAttribute("aria-label")).toBe("工具活动组")
    const heading = group!.querySelector<HTMLButtonElement>("button[aria-expanded]")
    expect(heading?.getAttribute("aria-expanded")).toBe("false")
    expect(heading?.textContent).toContain("工具查看 1 次")
    expect(heading?.textContent).toContain("写入文件")
    expect(heading?.textContent).toContain("index.html")
    expect(heading?.textContent).not.toMatch(/9337|字符|生成参数|准备中/)
    expect(heading?.textContent).not.toMatch(/文件编辑|工具调用 2 次/)
    expect(group!.querySelectorAll("pre")).toHaveLength(0)
    act(() => heading!.click())
    const read = [...group!.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")].find(
      (button) => button.textContent?.includes("读取文件")
    )
    expect(read).toBeDefined()
    expect(group!.textContent).toContain("写入文件")
    expect(group!.textContent).not.toMatch(/准备中|9337|字符|生成参数/)
    expect(heading?.textContent).not.toContain("index.html")
    expect(group!.textContent?.match(/index.html/g)).toHaveLength(1)
    expect(group!.querySelectorAll('[aria-label="正在生成文件内容，尚未开始执行"]')).toHaveLength(1)
    expect(group!.textContent).not.toMatch(/Write|生成参数|100|字符/)
    expect(
      [...group!.querySelectorAll("button[aria-expanded]")]
        .filter((button) => button !== heading)
        .some((button) => button.textContent?.includes("写入文件"))
    ).toBe(false)
    expect(group!.querySelectorAll("pre")).toHaveLength(0)
    act(() => read!.click())
    expect(group!.textContent).toContain("file content")
    expect(group!.querySelectorAll("pre")).toHaveLength(2)
  })

  it("names an all-generating group without counting unsubmitted calls", () => {
    const generated = part(
      "Write",
      {},
      {
        id: "ui-tool-generation:r:g:1:0",
        input: undefined,
        toolUseId: undefined,
        status: "running",
        metadata: {
          uiToolGeneration: true,
          toolProgress: { phase: "generating", receivedChars: 10, executionState: "not_started" },
        },
      }
    )
    render([
      generated,
      { ...generated, id: "ui-tool-generation:r:g:1:1", seq: 2, toolName: "Read" },
    ])
    const group = container.querySelector('section[aria-label="工具活动组"]')
    expect(group).not.toBeNull()
    const heading = group!.querySelector<HTMLButtonElement>("button[aria-expanded]")
    expect(heading?.textContent).toContain("写入文件")
    expect(heading?.textContent).toContain("读取文件")
    expect(heading?.textContent).not.toMatch(/Write|Read|生成参数|字符/)
    expect(heading?.textContent).not.toMatch(/工具调用|工具查看|文件编辑/)
    act(() => heading!.click())
    expect(
      group!.querySelectorAll('[role="img"][aria-label="正在生成文件内容，尚未开始执行"]')
    ).toHaveLength(1)
    expect(group!.querySelectorAll('[role="img"][aria-label="正在生成工具参数，尚未开始执行"]')).toHaveLength(1)
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
    expect(container.querySelector('[data-tool-diagnostic][aria-label="失败"]')).not.toBeNull()
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
    expect(container.querySelector('[data-tool-diagnostic][aria-label="失败"]')).not.toBeNull()
    expect(container.querySelector(".shimmer")).toBeNull()
    expect(container.textContent).toContain("exit code 1")
    expect(container.textContent).toContain('"command": "exit 1"')
  })
})
