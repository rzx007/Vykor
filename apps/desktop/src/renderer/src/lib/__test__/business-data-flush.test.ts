// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest"
import { flushRendererBusinessData } from "../business-data"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session/store"
import { resetDesktopSessionStore } from "@renderer/stores/desktop-session/store-test-fixtures"
import { businessDataFixture } from "./business-data-fixture"
afterEach(() => {
  useDesktopSessionStore.setState({ loadStatus: "idle", composerDraftsByScope: {} })
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
it("waits for an edit made while the previous close flush is writing", async () => {
  resetDesktopSessionStore()
  let release!: () => void
  const write = businessDataFixture.write.bind(businessDataFixture)
  const saved: unknown[] = []
  vi.spyOn(businessDataFixture, "write").mockImplementation(async (key, value, revision) => {
    saved.push(value)
    if (saved.length === 1)
      await new Promise<void>((resolve) => {
        release = resolve
      })
    return write(key, value, revision)
  })
  useDesktopSessionStore.setState({ loadStatus: "ready" })
  useDesktopSessionStore.getState().setComposerDraftText("new-conversation", "first")
  const flushing = flushRendererBusinessData()
  await vi.waitFor(() => expect(release).toBeTypeOf("function"))
  useDesktopSessionStore.getState().setComposerDraftText("new-conversation", "last edit")
  release()
  await flushing
  expect(saved).toHaveLength(2)
  expect(JSON.stringify(saved[1])).toContain("last edit")
})
