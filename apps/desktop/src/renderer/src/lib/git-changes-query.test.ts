// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import type { DesktopGitChangesInput } from "@shared/git-types"
import {
  queryGitChanges,
  resetGitChangesQueryCacheForTests,
} from "./git-changes-query"

const emptyResult = (rootPath: string) => ({
  rootPath,
  files: [],
  totalAdditions: 0,
  totalDeletions: 0,
})

describe("queryGitChanges", () => {
  afterEach(() => {
    resetGitChangesQueryCacheForTests()
    vi.useRealTimers()
  })

  it("shares an in-flight request for normalized root and scope", async () => {
    let resolveRequest!: (value: ReturnType<typeof emptyResult>) => void
    const changes = vi.fn(() => new Promise<ReturnType<typeof emptyResult>>((resolve) => {
      resolveRequest = resolve
    }))
    Object.defineProperty(window, "desktop", {
      configurable: true,
      value: { git: { changes } },
    })

    const first = queryGitChanges({ rootPath: "D:\\repo\\", scope: "uncommitted" })
    const second = queryGitChanges({ rootPath: "d:/repo", scope: undefined })
    expect(changes).toHaveBeenCalledTimes(1)
    resolveRequest(emptyResult("D:/repo"))
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
  })

  it("isolates different roots and scopes", async () => {
    const changes = vi.fn(({ rootPath }: DesktopGitChangesInput) =>
      Promise.resolve(emptyResult(rootPath))
    )
    Object.defineProperty(window, "desktop", {
      configurable: true,
      value: { git: { changes } },
    })
    await Promise.all([
      queryGitChanges({ rootPath: "D:/one", scope: "uncommitted" }),
      queryGitChanges({ rootPath: "D:/two", scope: "uncommitted" }),
      queryGitChanges({ rootPath: "D:/one", scope: "staged" }),
    ])
    expect(changes).toHaveBeenCalledTimes(3)
  })

  it("reuses a fresh result, expires it, and lets force bypass it", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-09-17T00:00:00Z"))
    const changes = vi.fn(({ rootPath }: DesktopGitChangesInput) =>
      Promise.resolve(emptyResult(rootPath))
    )
    Object.defineProperty(window, "desktop", {
      configurable: true,
      value: { git: { changes } },
    })
    const input = { rootPath: "D:/repo", scope: "uncommitted" as const }
    await queryGitChanges(input)
    await queryGitChanges(input)
    expect(changes).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1001)
    await queryGitChanges(input)
    await queryGitChanges(input, { force: true })
    expect(changes).toHaveBeenCalledTimes(3)
  })

  it("shares concurrent forced refreshes and does not cache failures", async () => {
    const failure = new Error("git failed")
    const changes = vi.fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(emptyResult("D:/repo"))
    Object.defineProperty(window, "desktop", {
      configurable: true,
      value: { git: { changes } },
    })
    const input = { rootPath: "D:/repo", scope: "unstaged" as const }
    await expect(queryGitChanges(input)).rejects.toThrow("git failed")
    await expect(queryGitChanges(input)).resolves.toEqual(emptyResult("D:/repo"))

    resetGitChangesQueryCacheForTests()
    let resolveRequest!: (value: ReturnType<typeof emptyResult>) => void
    changes.mockImplementation(() => new Promise((resolve) => { resolveRequest = resolve }))
    const first = queryGitChanges(input, { force: true })
    const second = queryGitChanges(input, { force: true })
    expect(changes).toHaveBeenCalledTimes(3)
    resolveRequest(emptyResult("D:/repo"))
    await Promise.all([first, second])
  })
})
