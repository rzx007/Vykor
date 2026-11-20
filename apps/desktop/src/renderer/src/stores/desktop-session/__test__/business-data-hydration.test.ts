// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest"
import {
  businessDataFixture,
  businessDataSnapshot,
} from "@renderer/lib/__test__/business-data-fixture"
import {
  importOtherLegacyBusinessData,
  flushRendererBusinessData,
} from "@renderer/lib/business-data"
import { useDesktopSessionStore } from "../store"
import { resetDesktopSessionStore, refreshedBootstrap } from "../store-test-fixtures"
import { readComposerRecovery } from "../composer-recovery"
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
const draft = (text: string) => ({
  document: { version: 1, items: [{ type: "text", text }] },
  attachments: [],
})
it("does not write empty state during hydration or replace a newer edit with the old read", async () => {
  resetDesktopSessionStore()
  localStorage.clear()
  let release!: (value: unknown) => void
  const write = vi.spyOn(businessDataFixture, "write")
  vi.spyOn(businessDataFixture, "read").mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve as never
      })
  )
  vi.stubGlobal("window", {
    desktop: {
      businessData: businessDataFixture,
      sessions: {
        bootstrap: async () => refreshedBootstrap,
        daemonStatus: async () => ({ phase: "ready" }),
      },
    },
  })
  const starting = useDesktopSessionStore.getState().initialize()
  await vi.waitFor(() => expect(release).toBeTypeOf("function"))
  useDesktopSessionStore.getState().setComposerDraftText("new-conversation", "new edit")
  await expect(flushRendererBusinessData()).rejects.toThrow(/加载/)
  expect(write).not.toHaveBeenCalled()
  release({
    version: 1,
    revision: 1,
    value: {
      version: 1,
      drafts: { "new-conversation": draft("old edit"), "session:s": draft("keep") },
      submissions: [],
    },
  })
  await starting
  expect(useDesktopSessionStore.getState().loadStatus).toBe("ready")
  expect(
    useDesktopSessionStore.getState().composerDraftsByScope["new-conversation"]?.document.items
  ).toEqual([{ type: "text", text: "new edit" }])
  expect(
    useDesktopSessionStore.getState().composerDraftsByScope["session:s"]?.document.items
  ).toEqual([{ type: "text", text: "keep" }])
})
it("filters old memory and linked-chat bodies before import and preserves the source", async () => {
  resetDesktopSessionStore()
  localStorage.clear()
  const source = JSON.stringify({
    version: 1,
    drafts: {
      "session:persistent-child": draft("persist"),
      "session:memory": draft("PRIVATE"),
      "session:missing": draft("UNKNOWN PRIVATE"),
      "linked-chat:source": draft("LINKED PRIVATE"),
      "new-conversation": draft("new"),
    },
    submissions: [],
  })
  localStorage.setItem("vykor.desktop.composer-recovery.v1", source)
  vi.spyOn(businessDataFixture, "classifySessions").mockResolvedValue({
    "persistent-child": "persistent",
    memory: "memory",
    missing: "unknown",
  })
  const imported = vi.spyOn(businessDataFixture, "importLegacy")
  const restored = await readComposerRecovery()
  expect(Object.keys(restored.composerDraftsByScope).sort()).toEqual([
    "new-conversation",
    "session:persistent-child",
  ])
  expect(JSON.stringify(imported.mock.calls)).not.toContain("PRIVATE")
  expect(imported.mock.calls[0]?.[3]).toEqual(["missing"])
  expect(localStorage.getItem("vykor.desktop.composer-recovery.v1")).toBe(source)
})
it("exports only known note and SHA-256 image keys and retains all legacy copies", async () => {
  resetDesktopSessionStore()
  localStorage.clear()
  const imageKey = "a".repeat(64)
  localStorage.setItem(
    `vykor-image-annotations-v1:${imageKey}`,
    JSON.stringify([{ id: "r", x: 0, y: 0, width: 2, height: 2, comment: "mark" }])
  )
  localStorage.setItem("vykor-image-annotations-v1:../../outside", "PRIVATE")
  localStorage.setItem("window-preference", "stay")
  await importOtherLegacyBusinessData()
  expect(businessDataSnapshot({ kind: "image-annotations", imageKey })).toMatchObject([
    { id: "r", comment: "mark" },
  ])
  expect(localStorage.length).toBe(3)
})
