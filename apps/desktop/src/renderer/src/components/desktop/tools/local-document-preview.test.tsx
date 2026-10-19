// @vitest-environment jsdom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"
import { LocalDocumentPreview } from "./local-document-preview"
import type { WorkspaceReadFileResult } from "@shared/workspace-types"

vi.mock("@renderer/components/appearance/appearance-provider", () => ({
  useAppearance: () => ({ resolvedTheme: "light" }),
}))

it("sends only local bytes to its opaque sandbox and ignores unrelated messages", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  const bytes = new ArrayBuffer(4)
  try {
    await act(async () =>
      root.render(
        <LocalDocumentPreview
          preview={
            {
              name: "真实名称.pdf",
              documentPreview: { format: "pdf", bytes },
            } as WorkspaceReadFileResult
          }
        />
      )
    )
    const frame = host.querySelector("iframe")!
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts")
    expect(frame.src).toBe("vykor-preview://app/index.html")
    const post = vi.spyOn(frame.contentWindow!, "postMessage")
    const message = (source: Window | null, type: string, detail?: string) =>
      act(() =>
        window.dispatchEvent(new MessageEvent("message", { source, data: { type, detail } }))
      )
    message(window, "document:ready")
    expect(post).not.toHaveBeenCalled()
    message(frame.contentWindow, "document:ready")
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({ type: "document:open", name: "真实名称.pdf", bytes }),
      "*"
    )
    message(window, "document:error", "unrelated")
    expect(host.querySelector('[role="alert"]')).toBeNull()
    message(frame.contentWindow, "document:loaded")
    expect(host.querySelector('[role="status"]')).toBeNull()
    message(frame.contentWindow, "document:error", "文件已损坏")
    expect(host.textContent).toContain("文件已损坏")
    await act(async () => (host.querySelector("button") as HTMLButtonElement).click())
    expect(post).toHaveBeenCalledTimes(2)
    expect(host.querySelector('[role="alert"]')).toBeNull()
  } finally {
    act(() => root.unmount())
    host.remove()
    vi.restoreAllMocks()
    Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT")
  }
})
