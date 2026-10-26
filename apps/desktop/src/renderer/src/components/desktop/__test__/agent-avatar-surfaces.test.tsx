// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { AgentActivityMessage } from "../conversation-page/message/activity/agent-activity-message"
import { AgentsTool } from "../tools/agents/agents-tool"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session"
import { createActivityState } from "@renderer/stores/desktop-session/activity-state"
import { emptySessionView } from "@renderer/stores/desktop-session/store-test-fixtures"
import type { DesktopSessionPart, DesktopSessionTask } from "@shared/session-types"

let root: Root
let container: HTMLDivElement
const task: DesktopSessionTask = {
  id: "planet-task",
  sessionId: "main",
  childSessionId: "child",
  type: "agent",
  status: "running",
  description: "检查界面",
  cwd: "/repo",
  metadata: {},
  createdAt: 1,
  updatedAt: 1,
}
const call: DesktopSessionPart = {
  id: "dispatch",
  sessionId: "main",
  messageId: "message",
  seq: 1,
  type: "tool",
  toolName: "Agent",
  toolUseId: "dispatch-id",
  input: { description: task.description },
  output: JSON.stringify({ kind: "job", action: "created", jobKind: "agent", jobId: task.id }),
  status: "completed",
  metadata: {},
  createdAt: 1,
  updatedAt: 1,
}
const callbacks = {
  onOpenFile: vi.fn(),
  canOpenReview: false,
  onOpenReview: vi.fn(),
  onOpenTerminal: vi.fn(),
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  // jsdom does not decode data-URI images. Model an already decoded local SVG.
  vi.stubGlobal(
    "Image",
    class {
      complete = true
      naturalWidth = 100
    }
  )
  Object.defineProperty(window, "desktop", {
    configurable: true,
    value: {
      sessions: {
        onAuxUpdated: () => () => {},
        openAux: () => new Promise(() => {}),
        closeAux: vi.fn(async () => undefined),
      },
    },
  })
  useDesktopSessionStore.setState({
    activeSessionId: "main",
    activity: createActivityState(),
    sessionView: { ...emptySessionView("main"), tasks: [task] },
  })
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function render(tasks: DesktopSessionTask[] = [task]) {
  await act(async () =>
    root.render(
      <>
        <AgentActivityMessage call={call} tasks={tasks} />
        <AgentsTool {...callbacks} active />
      </>
    )
  )
}

function avatarSource(selector: string): string {
  const image = container.querySelector<HTMLImageElement>(`${selector} [data-slot="avatar-image"]`)
  expect(image).not.toBeNull()
  return image!.getAttribute("src")!
}

it("shares one local planet across the chat, task list, and detail heading", async () => {
  await render()
  const source = avatarSource("[data-agent-activity]")
  expect(source).toMatch(/^data:image\/svg\+xml[;,]/)
  expect(avatarSource('[role="list"]')).toBe(source)
  await act(async () => container.querySelector<HTMLButtonElement>('[role="list"] button')!.click())
  expect(avatarSource("header")).toBe(source)
  expect(container.querySelector("header")?.textContent).toContain("运行中")
})

it("keeps the dispatch identity when the task arrives, finishes, and remounts", async () => {
  await render([])
  const source = avatarSource("[data-agent-activity]")
  await render()
  expect(avatarSource("[data-agent-activity]")).toBe(source)
  await render([{ ...task, status: "completed" }])
  expect(avatarSource("[data-agent-activity]")).toBe(source)
  expect(container.querySelector("[data-agent-activity]")?.textContent).toContain("已完成")
  await act(async () => root.unmount())
  root = createRoot(container)
  await render()
  expect(avatarSource("[data-agent-activity]")).toBe(source)
})

it("gives separate identities to agents with the same description", async () => {
  await act(async () =>
    useDesktopSessionStore.setState({
      sessionView: {
        ...emptySessionView("main"),
        tasks: [task, { ...task, id: "other-planet-task", childSessionId: "other-child" }],
      },
    })
  )
  await render()
  const sources = [
    ...container.querySelectorAll<HTMLImageElement>('[role="list"] [data-slot="avatar-image"]'),
  ].map((image) => image.getAttribute("src"))
  expect(sources).toHaveLength(2)
  expect(new Set(sources).size).toBe(2)
})
