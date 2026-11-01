import type { WebContents } from "electron"
import { expect, it } from "vitest"
import { BrowserAnnotationController, type AnnotationPageContext } from "../browser-annotation-controller"
import type { PageAnnotationSnapshot } from "../../../../shared/browser-annotation"

it("does not reuse saved annotation IDs after the controller restarts", async () => {
  const snapshot: PageAnnotationSnapshot = {
    mode: "pick", interactionVersion: 1, eventSequence: 1, focusedAnnotationId: null,
    viewport: { width: 800, height: 600 }, markers: [],
    selected: {
      handleId: "handle", target: "button: 提交", selector: "#submit", locatorKind: "unique-id",
      tagName: "button", role: "button", name: "提交", rect: { x: 0, y: 0, width: 80, height: 30 },
    },
  }
  const page: AnnotationPageContext = {
    tabId: "tab", pageUrl: "https://example.com/", pageRevision: 1, ready: true,
    contents: { id: 42, executeJavaScriptInIsolatedWorld: async () => snapshot } as unknown as WebContents,
    assertCurrent() {},
  }
  async function saveWithNewController() {
    const controller = new BrowserAnnotationController()
    controller.pageReady(42, page.pageUrl, 1)
    await controller.setMode(page, { tabId: "tab", pageRevision: 1, mode: "pick" })
    const selected = await controller.read(page)
    const saved = await controller.add(page, {
      tabId: "tab", pageRevision: 1, selectionId: selected.selection!.selectionId, comment: "增加间距",
    })
    return saved.annotations[0]!.record.id
  }

  const previousRunId = await saveWithNewController()
  const restartedRunId = await saveWithNewController()
  expect(restartedRunId).not.toBe(previousRunId)
})
