// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  reconcileOrganization,
  reorderInContainer,
  type NoteOrganizationSnapshotRecord,
  type SaveNoteOrganizationInput,
} from "@rzx/client"
import { useNoteOrganization } from "../use-note-organization"
import type { NoteView } from "../note-model"

const notes: NoteView[] = ["a", "b", "c"].map((id) => ({
  draftId: id,
  noteId: id,
  content: id,
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
  recovered: false,
}))
describe("note organization persistence", () => {
  let root: Root
  let container: HTMLDivElement
  let latest: ReturnType<typeof useNoteOrganization>
  let disk: NoteOrganizationSnapshotRecord
  let save: ReturnType<typeof vi.fn>
  function Probe() {
    latest = useNoteOrganization(notes)
    return null
  }
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    disk = {
      organization: reconcileOrganization(undefined, ["a", "b", "c"]).organization,
      etag: "e1",
      readOnly: false,
    }
    save = vi.fn(async (input: SaveNoteOrganizationInput) => {
      disk = { ...disk, organization: input.organization, etag: disk.etag + "1" }
      return disk
    })
    Object.defineProperty(window, "desktop", {
      configurable: true,
      value: { notes: { organization: vi.fn(async () => disk), saveOrganization: save } },
    })
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.restoreAllMocks()
  })
  async function mount() {
    await act(async () => {
      root.render(<Probe />)
    })
  }
  it("serializes rapid moves using each confirmed etag and keeps both operations", async () => {
    await mount()
    await act(async () => {
      const first = latest.reorder("desktop", "a", 2)
      const second = latest.reorder("desktop", "b", 2)
      await Promise.all([first, second])
    })
    expect(save).toHaveBeenCalledTimes(2)
    expect(save.mock.calls.map(([input]) => input.expectedEtag)).toEqual(["e1", "e11"])
    expect(latest.snapshot?.organization.desktop.map((item) => item.id)).toEqual(["c", "a", "b"])
  })
  it("rolls back all unconfirmed moves and skips queued writes after failure", async () => {
    save.mockRejectedValueOnce(new Error("external conflict"))
    await mount()
    const before = latest.snapshot!.organization
    let results: boolean[] = []
    await act(async () => {
      results = await Promise.all([
        latest.reorder("desktop", "a", 2),
        latest.reorder("desktop", "b", 2),
      ])
    })
    expect(results).toEqual([false, false])
    expect(save).toHaveBeenCalledTimes(1)
    expect(latest.snapshot?.organization).toEqual(before)
    expect(latest.error).toContain("已恢复原位置")
    expect(latest.saving).toBe(false)
  })
  it("retries a failed movement once from the restored layout", async () => {
    save.mockRejectedValueOnce(new Error("network"))
    await mount()
    await act(async () => {
      await latest.reorder("desktop", "a", 2)
    })
    await act(async () => {
      await latest.retry()
    })
    expect(latest.snapshot?.organization.desktop.map((item) => item.id)).toEqual(["b", "c", "a"])
    expect(latest.error).toBeNull()
  })

  it("returns the identity of the folder created by a successful merge", async () => {
    await mount()
    let folderId: string | null = null
    await act(async () => {
      folderId = await latest.mergeNotes("a", "b")
    })
    expect(folderId).not.toBeNull()
    expect(latest.snapshot?.organization.folderItems[folderId!]).toEqual(["b", "a"])
    save.mockRejectedValueOnce(new Error("disk full"))
    await act(async () => {
      expect(await latest.mergeNotes("a", "c")).toBeNull()
    })
  })
  it("does not save future versions and rolls appearance back with a failed layout", async () => {
    disk.readOnly = true
    await mount()
    await act(async () => {
      expect(await latest.reorder("desktop", "a", 2)).toBe(false)
    })
    expect(save).not.toHaveBeenCalled()
    disk.readOnly = false
    await act(async () => latest.refresh())
    const rollback = vi.fn()
    save.mockRejectedValueOnce(new Error("disk full"))
    await act(async () => {
      await latest.change(
        (value) => ({ ...value, desktop: [...value.desktop].reverse() }),
        rollback
      )
    })
    expect(rollback).toHaveBeenCalledOnce()
  })

  it("reapplies the appearance when retrying a failed pin operation", async () => {
    await mount()
    let pinned = false
    const apply = () => {
      pinned = true
    }
    const rollback = () => {
      pinned = false
    }
    save.mockRejectedValueOnce(new Error("disk full"))
    await act(async () => {
      await latest.change(
        (value) => ({ ...value, desktop: [...value.desktop].reverse() }),
        rollback,
        apply
      )
    })
    expect(pinned).toBe(false)
    await act(async () => {
      await latest.retry()
    })
    expect(pinned).toBe(true)
    expect(latest.error).toBeNull()
  })

  it("keeps recovery warnings visible after a clean subsequent read", async () => {
    disk.warning = "组织文件损坏，已保留副本并重建桌面"
    await mount()
    expect(latest.warning).toContain("保留副本")
    delete disk.warning
    await act(async () => {
      await latest.refresh()
    })
    expect(latest.warning).toContain("保留副本")
    expect(window.desktop.notes.organization).toHaveBeenCalledTimes(2)
  })

  it("clears a failed response after retry confirms the already persisted layout", async () => {
    await mount()
    save.mockImplementationOnce(async (input: SaveNoteOrganizationInput) => {
      disk = { ...disk, organization: input.organization, etag: "saved" }
      throw new Error("response lost")
    })
    await act(async () => {
      await latest.change((value) =>
        reorderInContainer(value, { containerId: "desktop", activeId: "a", toIndex: 2 })
      )
    })
    expect(latest.error).toContain("response lost")
    await act(async () => {
      await latest.retry()
    })
    expect(latest.error).toBeNull()
    expect(save).toHaveBeenCalledTimes(1)
  })
})
