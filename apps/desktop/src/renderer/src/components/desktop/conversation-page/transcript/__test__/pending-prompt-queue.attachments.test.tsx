// @vitest-environment jsdom
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { expect, it, vi } from "vitest"

import type { DesktopSessionInput, DesktopSessionRun } from "@shared/session-types"
import { PendingPromptQueue } from "../pending-prompt-queue"

function renderQueue(
  content: string,
  names: string[],
  source: "submitting" | "accepted" | "failed" | "server"
) {
  const attachments = names.map((displayName, index) => ({
    id: `attachment-${index}`,
    sessionId: "chat",
    inputId: "input",
    assetId: `asset-${index}`,
    seq: index,
    intent: "auto" as const,
    displayName,
    mediaType: "image/png",
    sizeBytes: 123,
    metadata: {},
    createdAt: 1,
  }))
  const local = {
    id: "input",
    sessionId: "chat",
    content,
    attachments,
    phase: source === "server" ? ("accepted" as const) : source,
    placement: "queue" as const,
  }
  const input: DesktopSessionInput = {
    id: "input",
    sessionId: "chat",
    content,
    attachments,
    seq: 1,
    delivery: "queue",
    items: [],
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
  const onPromote = vi.fn(),
    onCancel = vi.fn()
  const host = document.createElement("div")
  host.innerHTML = renderToStaticMarkup(
    createElement(PendingPromptQueue, {
      activeRunId: "active",
      localSubmissions: [local],
      prompts: source === "server" ? [{ input, run }] : [],
      onPromote,
      onCancel,
    })
  )
  expect(host.querySelectorAll('[data-slot="item"]')).toHaveLength(1)
  expect(onPromote).not.toHaveBeenCalled()
  expect(onCancel).not.toHaveBeenCalled()
  return host.querySelector<HTMLElement>('[data-slot="item-title"]')!
}

it.each([
  { content: "", names: ["截图.png"], label: "截图.png", fullNames: "截图.png" },
  {
    content: " \n\t ",
    names: ["截图.png", "报告.pdf", "说明.txt"],
    label: "截图.png 等 3 个附件",
    fullNames: "截图.png\n报告.pdf\n说明.txt",
  },
  { content: "", names: [""], label: "1 个附件", fullNames: "未命名附件" },
  { content: "", names: ["", "  "], label: "2 个附件", fullNames: "未命名附件\n未命名附件" },
  { content: "", names: ["", "说明.txt"], label: "2 个附件", fullNames: "未命名附件\n说明.txt" },
  { content: "", names: [" 截图.png "], label: "截图.png", fullNames: "截图.png" },
  {
    content: "",
    names: [`${"长文件名".repeat(30)}.png`],
    label: `${"长文件名".repeat(30)}.png`,
    fullNames: `${"长文件名".repeat(30)}.png`,
  },
])(
  "shows the same attachment fallback locally and after server confirmation: $label",
  ({ content, names, label, fullNames }) => {
    for (const source of ["submitting", "accepted", "failed", "server"] as const) {
      const title = renderQueue(content, names, source)
      expect(title.textContent).toBe(label)
      expect(title.title).toBe(fullNames)
      expect(title.querySelector("svg.lucide-paperclip")).not.toBeNull()
      expect(title.classList.contains("truncate")).toBe(true)
      expect(title.querySelector("button")).toBeNull()
    }
  }
)

it.each(["submitting", "accepted", "failed", "server"] as const)(
  "preserves the original text when %s records also include attachments",
  (source) => {
    const title = renderQueue(" 帮我看看这张图 ", ["截图.png", "报告.pdf"], source)
    expect(title.textContent).toBe(" 帮我看看这张图 ")
    expect(title.title).toBe("")
    expect(title.querySelector("svg")).toBeNull()
  }
)

it("does not invent an attachment summary for an empty record without attachments", () => {
  const title = renderQueue("", [], "accepted")
  expect(title.textContent).toBe("")
  expect(title.querySelector("svg")).toBeNull()
})
