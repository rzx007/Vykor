// @vitest-environment jsdom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"
import { ConversationTranscript } from "../transcript"
import type {
  DesktopSessionInput,
  DesktopSessionMessage,
  DesktopSessionPart,
  DesktopSessionRun,
} from "@shared/session-types"

vi.mock("@renderer/components/ui/code-block", () => ({
  CodeBlock: ({ code }: { code: string }) => <pre>{code}</pre>,
}))

const common = { sessionId: "chat", metadata: {}, createdAt: 1, updatedAt: 1 }
const prompt = "用表格展示项目分数。"
const heading = 'root = FilterableTable("项目评分", ["项目", "团队", "分数"]'
const program = heading + ', [["Alpha", "工程", 10], ["Beta", "设计", 2], ["Gamma", "工程", 30]])'
const opening = "共 3 个项目。\n\n```vykor-ui-v1\n"
const openResponse = opening + program
const closedResponse = openResponse + "\n```"
const noop = () => {}

const inputs: DesktopSessionInput[] = [
  {
    ...common,
    id: "input",
    seq: 1,
    delivery: "queue",
    content: prompt,
    items: [],
    attachments: [],
    metadata: { replyPresentation: "vykor-ui-v1" },
  },
]
const messages: DesktopSessionMessage[] = [
  { ...common, id: "prompt", seq: 1, role: "user", inputId: "input", runId: "run" },
  { ...common, id: "reply", seq: 2, role: "assistant", runId: "run" },
]
const userPart: DesktopSessionPart = {
  ...common,
  id: "user-text",
  messageId: "prompt",
  seq: 1,
  type: "text",
  status: "completed",
  text: prompt,
}
const replyMetadata = { phase: "final_answer" }
const runningRun: DesktopSessionRun = {
  ...common,
  id: "run",
  inputId: "input",
  status: "running",
  startedAt: 1,
}

function transcript(text: string, status: DesktopSessionRun["status"]) {
  const running = status === "running"
  return (
    <ConversationTranscript
      inputs={inputs}
      messages={messages}
      parts={[
        userPart,
        {
          ...common,
          id: "reply-text",
          messageId: "reply",
          seq: 2,
          type: "text",
          status: running ? "running" : "completed",
          text,
          metadata: replyMetadata,
        },
      ]}
      runs={[running ? runningRun : { ...runningRun, status, finishedAt: 2 }]}
      running={running}
      canEditLastUserMessage={false}
      onEditLastUserMessage={noop}
      onCopyAssistantMessage={noop}
      onOpenFile={noop}
      canOpenReview={false}
      onOpenReview={noop}
      onOpenTerminal={noop}
    />
  )
}

it("updates a reopened reply when the desktop reads or changes the interactive UI preference", async () => {
  const preference = Promise.withResolvers<boolean>()
  let preferenceChanged: ((enabled: boolean) => void) | undefined
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  vi.stubGlobal("desktop", {
    settings: {
      getInteractiveUiEnabled: () => preference.promise,
      onInteractiveUiEnabledChanged: (listener: (enabled: boolean) => void) => {
        preferenceChanged = listener
        return () => {
          preferenceChanged = undefined
        }
      },
    },
  })
  const container = document.body.appendChild(document.createElement("div"))
  const root = createRoot(container)

  try {
    await act(async () => root.render(transcript(closedResponse, "completed")))
    expect(container.querySelector("pre")?.textContent).toBe(program)

    await act(async () => {
      preference.resolve(true)
    })
    await act(async () => {
      await import("../../message/interactive-ui/interactive-ui-block")
    })
    expect(Array.from(container.querySelectorAll("tbody tr"), (row) => row.textContent)).toEqual([
      "Alpha工程10",
      "Beta设计2",
      "Gamma工程30",
    ])

    await act(async () => {
      preferenceChanged?.(false)
    })
    expect(container.querySelector("table")).toBeNull()
    expect(container.querySelector("pre")?.textContent).toBe(program)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  }
})

it.each(["completed", "interrupted"] as const)(
  "adds validated rows while streaming before the run becomes %s",
  async (endStatus) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
    vi.stubGlobal("desktop", {
      settings: {
        getInteractiveUiEnabled: async () => true,
        onInteractiveUiEnabledChanged: () => noop,
      },
    })
    const container = document.body.appendChild(document.createElement("div"))
    const root = createRoot(container)
    const render = (text: string, status: DesktopSessionRun["status"] = "running") =>
      act(async () => root.render(transcript(text, status)))
    const rows = () => Array.from(container.querySelectorAll("tbody tr"), (row) => row.textContent)

    try {
      await render(opening + heading.slice(0, -1))
      expect(container.querySelector("table")).toBeNull()
      await render(opening + heading)
      await act(async () => {
        await import("../../message/interactive-ui/interactive-ui-block")
      })
      const table = container.querySelector("table")
      expect(table).not.toBeNull()
      expect(table?.querySelector("thead")?.textContent).toBe("项目团队分数")
      expect(rows()).toEqual([])

      const first = opening + heading + ', [["Alpha", "工程", 1'
      await render(first)
      expect(rows()).toEqual([])
      await render(first + '0], ["Beta", "设计", 2]')
      expect(rows()).toEqual(["Alpha工程10", "Beta设计2"])
      await act(async () =>
        container.querySelector<HTMLButtonElement>("th:nth-child(3) button")!.click()
      )
      const input = container.querySelector<HTMLInputElement>('input[aria-label="筛选表格"]')!
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
          input,
          "工程"
        )
        input.dispatchEvent(new Event("input", { bubbles: true }))
      })
      expect(rows()).toEqual(["Alpha工程10"])

      await render(openResponse + "\n``")
      expect(container.querySelector("table")).toBe(table)
      expect(rows()).toEqual(["Alpha工程10", "Gamma工程30"])

      if (endStatus === "interrupted") {
        await render(openResponse + "\n``", endStatus)
        expect(container.querySelector("table")).toBeNull()
        expect(container.querySelector("pre")?.textContent).toBe(program + "\n``")
        return
      }

      await render(closedResponse)
      expect(container.querySelector("table")).toBe(table)
      expect(container.querySelector('input[aria-label="筛选表格"]')).toBe(input)
      expect(input.value).toBe("工程")
      expect(container.querySelector("th:nth-child(3)")?.getAttribute("aria-sort")).toBe(
        "ascending"
      )

      const continued = closedResponse + "\n\n项目分数汇总如下。"
      await render(continued)
      expect(container.querySelector("table")).toBe(table)
      expect(container.textContent).toContain("项目分数汇总如下。")
      await render(continued, endStatus)
      expect(container.querySelector("table")).toBe(table)
    } finally {
      await act(async () => root.unmount())
      container.remove()
      vi.unstubAllGlobals()
    }
  }
)
