// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

import { PetWindow } from "../pet-page"

const clickedHandlers = new Set<() => void>()
let showMainRequests = 0
let container: HTMLDivElement
let root: Root | null
let previousReducedMotion: string | undefined
let previousDesktop: PropertyDescriptor | undefined

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  clickedHandlers.clear()
  showMainRequests = 0
  previousReducedMotion = document.documentElement.dataset.reducedMotion
  document.documentElement.dataset.reducedMotion = "true"
  previousDesktop = Object.getOwnPropertyDescriptor(window, "desktop")
  Object.defineProperty(window, "desktop", {
    configurable: true,
    value: {
      pet: {
        onClicked(listener: () => void) {
          clickedHandlers.add(listener)
          return () => clickedHandlers.delete(listener)
        },
      },
      window: {
        async showMain() {
          showMainRequests += 1
        },
      },
    },
  })
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root!.render(<PetWindow />))
  await vi.waitFor(() => expect(container.querySelector("svg")).not.toBeNull())
})

afterEach(async () => {
  await act(async () => root?.unmount())
  container.remove()
  if (previousReducedMotion === undefined) delete document.documentElement.dataset.reducedMotion
  else document.documentElement.dataset.reducedMotion = previousReducedMotion
  if (previousDesktop) Object.defineProperty(window, "desktop", previousDesktop)
  else Reflect.deleteProperty(window, "desktop")
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function avatar(): string {
  const svg = container.querySelector("svg")
  expect(svg).not.toBeNull()
  return svg!.outerHTML
}

async function clickPet(): Promise<void> {
  await act(async () => container.querySelector<HTMLButtonElement>("button")!.click())
}

it("waits for the single-click delay before switching the avatar", async () => {
  const original = avatar()

  await clickPet()
  await act(async () => {
    vi.advanceTimersByTime(279)
  })
  expect(avatar()).toBe(original)

  await act(async () => {
    vi.advanceTimersByTime(1)
  })
  expect(avatar()).not.toBe(original)
  expect(showMainRequests).toBe(0)
})

it("cancels the pending avatar switch when a double-click opens the main window", async () => {
  const original = avatar()

  await clickPet()
  await act(async () => {
    vi.advanceTimersByTime(100)
  })
  await clickPet()
  await act(async () => {
    container
      .querySelector<HTMLButtonElement>("button")!
      .dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))
  })
  expect(showMainRequests).toBe(1)

  await act(async () => {
    vi.advanceTimersByTime(280)
  })
  expect(avatar()).toBe(original)
})

it("switches the avatar when the host forwards a pet click", async () => {
  const original = avatar()

  await act(async () => {
    for (const handler of clickedHandlers) handler()
  })

  expect(avatar()).not.toBe(original)
  expect(showMainRequests).toBe(0)
})

it("releases the host click subscription and pending click when unmounted", async () => {
  await clickPet()
  expect(clickedHandlers.size).toBe(1)
  expect(vi.getTimerCount()).toBe(1)

  await act(async () => root!.unmount())
  root = null

  expect(clickedHandlers.size).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
})
