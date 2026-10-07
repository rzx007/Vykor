// @vitest-environment jsdom
import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}))
vi.mock("./attachment-storage-settings", () => ({
  AttachmentStorageSettings: () => <div>原有附件存储设计</div>,
}))
import { StorageSettings } from "./storage-settings"
describe("storage settings reading order and safety", () => {
  let container: HTMLDivElement, root: Root
  const updateStoragePolicy = vi.fn(async () => ({
    version: 1,
    enabled: true,
    days: 90,
    lastRunAt: null,
  }))
  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
    updateStoragePolicy.mockClear()
    Object.defineProperty(window, "desktop", {
      configurable: true,
      value: {
        maintenance: {
          storage: async () => ({
            scannedAt: 1,
            dataDirectory: "D:/data",
            totalBytes: 0,
            availableBytes: null,
            writable: true,
            categories: [],
            backups: [],
          }),
          cleanupAudits: async () => ({ audits: [] }),
          storagePolicy: async () => ({ version: 1, enabled: false, days: 90, lastRunAt: null }),
          updateStoragePolicy,
        },
      },
    })
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root.render(<StorageSettings />))
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })
  it("places the original attachment design before new statistics and folds maintenance", () => {
    const attachments = container.querySelector("#storage-attachments")!
    const space = container.querySelector("#storage-space")!
    expect(attachments.compareDocumentPosition(space) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(
      0
    )
    for (const id of [
      "storage-retention",
      "storage-cleanup",
      "storage-backup",
      "storage-restore",
    ]) {
      const details = container.querySelector<HTMLDetailsElement>(`#${id}`)!
      expect(details.tagName).toBe("DETAILS")
      expect(details.open).toBe(false)
    }
  })
  it("still requires confirmation before enabling irreversible cleanup", async () => {
    container.querySelector<HTMLDetailsElement>("#storage-retention")!.open = true
    expect(container.querySelector('[aria-label="自动保留天数"]')).toBeNull()
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "设置并启用")!
        .click()
    )
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "保存并启用")!
        .click()
    )
    expect(updateStoragePolicy).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain("无法撤销")
    await act(async () =>
      [...document.querySelectorAll("button")]
        .find((button) => button.textContent === "取消")!
        .click()
    )
    expect(updateStoragePolicy).not.toHaveBeenCalled()
  })
  it("does not enable cleanup just by opening or cancelling its setup form", async () => {
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "设置并启用")!
        .click()
    )
    expect(container.querySelector<HTMLInputElement>('[aria-label="自动保留天数"]')?.value).toBe(
      "90"
    )
    expect(updateStoragePolicy).not.toHaveBeenCalled()
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "取消设置")!
        .click()
    )
    expect(container.querySelector('[aria-label="自动保留天数"]')).toBeNull()
    expect(updateStoragePolicy).not.toHaveBeenCalled()
  })
})
