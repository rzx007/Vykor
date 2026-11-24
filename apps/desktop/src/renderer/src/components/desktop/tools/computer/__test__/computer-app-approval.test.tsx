// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { DesktopComputerInteractionEvent } from "@shared/computer-types"
import { ComputerAppPermissionCard, ComputerInteractionProvider } from "../computer-interaction"

let root: Root
let container: HTMLDivElement
let receive: (event: DesktopComputerInteractionEvent) => void
const reply = vi.fn(async () => true)

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  vi.stubGlobal("desktop", { computer: {
    onInteraction: (listener: typeof receive) => { receive = listener; return () => {} },
    reply,
  } })
  reply.mockClear()
  container = document.body.appendChild(document.createElement("div"))
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

it("offers the task grant in the originating conversation and clears it when answered or revoked", async () => {
  await act(async () => root.render(<ComputerInteractionProvider>
    <div id="original"><ComputerAppPermissionCard sessionId="original" /></div>
    <div id="other"><ComputerAppPermissionCard sessionId="other" /></div>
  </ComputerInteractionProvider>))
  const prompt = { kind: "authorize", id: "request", sessionId: "original", appName: "计算器" } as const
  await act(async () => receive({ type: "prompt", prompt }))
  const original = container.querySelector("#original")!
  expect(original.textContent).toContain("允许 Vykor 使用「计算器」？")
  expect(container.querySelector("#other")?.textContent).toBe("")
  expect(document.querySelector("[role=dialog]")).toBeNull()
  expect(original.textContent).toContain("始终允许")
  const approve = [...original.querySelectorAll("button")].find((button) => button.textContent === "仅本任务")!
  await act(async () => approve.click())
  expect(reply).toHaveBeenCalledExactlyOnceWith({ id: "request", choice: "once" })
  expect(original.textContent).toBe("")

  await act(async () => receive({ type: "prompt", prompt: { ...prompt, id: "later" } }))
  expect(original.textContent).toContain("始终允许")
  await act(async () => receive({ type: "dismissed", id: "request" }))
  expect(original.textContent).toContain("始终允许")
  await act(async () => receive({ type: "dismissed", id: "later" }))
  expect(original.textContent).toBe("")
})
