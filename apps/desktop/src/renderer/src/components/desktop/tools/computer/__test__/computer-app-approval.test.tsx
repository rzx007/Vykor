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

it("remembers only an explicitly approved app and resets the choice for a replacement prompt", async () => {
  await act(async () => root.render(<ComputerInteractionProvider>
    <ComputerAppPermissionCard sessionId="original" />
  </ComputerInteractionProvider>))
  const prompt = { kind: "authorize", id: "first", sessionId: "original", appName: "计算器" } as const
  const checkbox = () => container.querySelector<HTMLElement>('[role="checkbox"]')!
  const button = (name: string) => [...container.querySelectorAll("button")].find(item => item.textContent === name)!
  await act(async () => receive({ type: "prompt", prompt }))
  expect(checkbox()?.getAttribute("aria-checked")).toBe("false")
  await act(async () => checkbox().click())
  expect(reply).not.toHaveBeenCalled()
  await act(async () => receive({ type: "prompt", prompt: { ...prompt, id: "second", appName: "记事本" } }))
  expect(checkbox().getAttribute("aria-checked")).toBe("false")
  await act(async () => checkbox().click())
  await act(async () => button("拒绝").click())
  expect(reply).toHaveBeenCalledExactlyOnceWith({ id: "second", choice: null })

  await act(async () => receive({ type: "prompt", prompt: { ...prompt, id: "third" } }))
  await act(async () => checkbox().click())
  await act(async () => button("始终允许").click())
  expect(reply).toHaveBeenNthCalledWith(2, { id: "third", choice: "always" })
})
