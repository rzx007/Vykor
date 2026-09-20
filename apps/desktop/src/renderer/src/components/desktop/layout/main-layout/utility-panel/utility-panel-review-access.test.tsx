// @vitest-environment jsdom

import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const activeWorkspaceIsGit = vi.hoisted(() => ({ value: false as boolean | null }))

vi.mock("@renderer/hooks/use-active-workspace-is-git", () => ({
  useActiveWorkspaceIsGit: () => activeWorkspaceIsGit.value,
}))

import { UtilityPanel } from "./utility-panel"

let mountedRoot: Root | null = null
let mountedContainer: HTMLDivElement | null = null

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
})

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount())
    mountedContainer?.remove()
    mountedRoot = null
    mountedContainer = null
  }
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT")
})

function mountPanel(scopeId: string): HTMLDivElement {
  const container = document.createElement("div")
  document.body.append(container)
  mountedContainer = container
  mountedRoot = createRoot(container)

  act(() => {
    mountedRoot?.render(
      createElement(UtilityPanel, {
        scopeId,
        open: true,
        maximized: false,
        onToggleMaximized: vi.fn(),
        onClose: vi.fn(),
        fileOpenRequest: null,
        reviewOpenRequest: null,
        terminalOpenRequest: null,
        toolOpenRequest: null,
        onOpenFile: vi.fn(),
        onOpenReview: vi.fn(),
        onOpenTerminal: vi.fn(),
      })
    )
  })

  return container
}

describe("UtilityPanel review tool access", () => {
  it("offers the review tool when the active workspace is a git repository", () => {
    activeWorkspaceIsGit.value = true

    const container = mountPanel("session:review-access-git")

    expect(container.textContent).toContain("审阅")
  })

  it("hides the review tool when the active workspace is not a git repository", () => {
    activeWorkspaceIsGit.value = false

    const container = mountPanel("session:review-access-no-git")

    expect(container.textContent).not.toContain("审阅")
  })

  it("hides the review tool while the git probe is still undecided", () => {
    activeWorkspaceIsGit.value = null

    const container = mountPanel("session:review-access-unknown")

    expect(container.textContent).not.toContain("审阅")
  })
})
