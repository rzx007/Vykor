// @vitest-environment jsdom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"
import type { DesktopWorkflowSnapshot } from "@shared/workflow-types"
import { WorkflowProvider, useWorkflows } from "../workflow-provider"

it("does not let completion of a previous session cancellation invalidate the new session read", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  let releaseCancel!: () => void
  let resolveNew!: (snapshot: DesktopWorkflowSnapshot) => void
  const read = ({ sessionId }: { sessionId: string }) =>
    sessionId === "old"
      ? Promise.resolve({ sessionId, runs: [{ jobId: "a", target: { kind: "workflow", jobId: "a" } }], errors: [], hasMore: false } as DesktopWorkflowSnapshot)
      : new Promise<DesktopWorkflowSnapshot>((resolve) => {
          resolveNew = resolve
        })
  Object.defineProperty(window, "desktop", {
    configurable: true,
    value: {
      workflows: {
        read,
        cancel: () =>
          new Promise<void>((resolve) => {
            releaseCancel = resolve
          }),
      },
    },
  })
  const container = document.createElement("div")
  const root = createRoot(container)
  function Probe() {
    const state = useWorkflows()
    return (
      <>
        <p>{state?.snapshot?.sessionId ?? "loading"}</p>
        <button
          onClick={() => {
            void state?.cancel("a")
          }}
        >
          stop
        </button>
      </>
    )
  }
  const render = (sessionId: string) => (
    <WorkflowProvider sessionId={sessionId} revision={0} syncStatus="connected" onOpen={() => {}}>
      <Probe />
    </WorkflowProvider>
  )
  try {
    await act(async () => root.render(render("old")))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 130))
    })
    await act(async () => container.querySelector("button")!.click())
    await act(async () => root.render(render("new")))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 130))
    })
    await act(async () => releaseCancel())
    await act(async () => resolveNew({ sessionId: "new", runs: [], errors: [], hasMore: false }))
    expect(container.querySelector("p")?.textContent).toBe("new")
  } finally {
    await act(async () => root.unmount())
    vi.unstubAllGlobals()
  }
})

it("ignores an old session response arriving after the user has switched sessions", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  let resolveOld!: (snapshot: DesktopWorkflowSnapshot) => void
  const read = vi.fn(({ sessionId }: { sessionId: string }) =>
    sessionId === "old"
      ? new Promise<DesktopWorkflowSnapshot>((resolve) => {
          resolveOld = resolve
        })
      : Promise.resolve({ sessionId, runs: [], errors: [], hasMore: false })
  )
  vi.stubGlobal("desktop", { workflows: { read } })
  Object.defineProperty(window, "desktop", { configurable: true, value: { workflows: { read } } })
  const container = document.createElement("div")
  const root = createRoot(container)
  function Probe() {
    const state = useWorkflows()
    return <p>{state?.snapshot?.sessionId ?? "loading"}</p>
  }
  const render = (sessionId: string) => (
    <WorkflowProvider sessionId={sessionId} revision={0} syncStatus="connected" onOpen={() => {}}>
      <Probe />
    </WorkflowProvider>
  )
  await act(async () => {
    root.render(render("old"))
  })
  await act(async () => {
    await new Promise((r) => setTimeout(r, 130))
  })
  await act(async () => {
    root.render(render("new"))
  })
  await act(async () => {
    await new Promise((r) => setTimeout(r, 130))
  })
  expect(container.textContent).toBe("new")
  await act(async () => {
    resolveOld({ sessionId: "old", runs: [], errors: [], hasMore: false })
  })
  expect(container.textContent).toBe("new")
  await act(async () => root.unmount())
  vi.unstubAllGlobals()
})
