// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"

import { probeWorkspaceGit, resetWorkspaceGitProbeCacheForTests } from "./workspace-git-probe"

function installProbe(isRepository: boolean | (() => Promise<never>)) {
  const probe = vi.fn(async () => {
    if (typeof isRepository === "function") return await isRepository()
    return { isRepository, rootPath: isRepository ? "D:/repo" : null }
  })
  Object.defineProperty(window, "desktop", {
    configurable: true,
    value: { git: { isRepository: probe } },
  })
  return probe
}

describe("probeWorkspaceGit", () => {
  afterEach(() => {
    resetWorkspaceGitProbeCacheForTests()
    vi.useRealTimers()
  })

  it("calls the IPC probe once and reuses the cached result within the TTL", async () => {
    const probe = installProbe(true)

    await expect(probeWorkspaceGit("D:\\Repo\\")).resolves.toBe(true)
    await expect(probeWorkspaceGit("D:/repo")).resolves.toBe(true)

    expect(probe).toHaveBeenCalledTimes(1)
  })

  it("re-probes after the TTL expires", async () => {
    vi.useFakeTimers()
    const probe = installProbe(true)

    await probeWorkspaceGit("D:/repo")
    vi.advanceTimersByTime(1_001)
    await probeWorkspaceGit("D:/repo")

    expect(probe).toHaveBeenCalledTimes(2)
  })

  it("caches each path independently", async () => {
    const probe = installProbe(true)

    await probeWorkspaceGit("/work/One")
    await probeWorkspaceGit("/work/Two")

    expect(probe).toHaveBeenCalledTimes(2)
  })

  it("shares one in-flight probe for the same normalized path", async () => {
    let resolveProbe!: (value: { isRepository: boolean; rootPath: string | null }) => void
    const probe = vi.fn(
      () =>
        new Promise<{ isRepository: boolean; rootPath: string | null }>((resolve) => {
          resolveProbe = resolve
        })
    )
    Object.defineProperty(window, "desktop", {
      configurable: true,
      value: { git: { isRepository: probe } },
    })

    const first = probeWorkspaceGit("D:\\Repo\\")
    const second = probeWorkspaceGit("d:/repo")
    expect(probe).toHaveBeenCalledTimes(1)

    resolveProbe({ isRepository: true, rootPath: "D:/Repo" })
    await expect(Promise.all([first, second])).resolves.toEqual([true, true])
  })

  it("returns false and does not cache when the IPC probe rejects", async () => {
    const probe = installProbe(() => Promise.reject(new Error("ipc down")))

    await expect(probeWorkspaceGit("D:/repo")).resolves.toBe(false)
    await expect(probeWorkspaceGit("D:/repo")).resolves.toBe(false)

    expect(probe).toHaveBeenCalledTimes(2)
  })

  it("re-probes after a failure instead of leaving a pending in-flight entry", async () => {
    const probe = vi
      .fn()
      .mockRejectedValueOnce(new Error("ipc down"))
      .mockResolvedValueOnce({ isRepository: true, rootPath: "D:/repo" })
    Object.defineProperty(window, "desktop", {
      configurable: true,
      value: { git: { isRepository: probe } },
    })

    await expect(probeWorkspaceGit("D:/repo")).resolves.toBe(false)
    await expect(probeWorkspaceGit("D:/repo")).resolves.toBe(true)

    expect(probe).toHaveBeenCalledTimes(2)
  })

  it("returns false when the IPC probe resolves with a malformed response", async () => {
    const probe = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(window, "desktop", {
      configurable: true,
      value: { git: { isRepository: probe } },
    })

    await expect(probeWorkspaceGit("D:/repo")).resolves.toBe(false)
    await expect(probeWorkspaceGit("D:/repo")).resolves.toBe(false)

    expect(probe).toHaveBeenCalledTimes(2)
  })

  it("returns false without probing for an empty path", async () => {
    const probe = installProbe(true)

    await expect(probeWorkspaceGit("   ")).resolves.toBe(false)
    expect(probe).not.toHaveBeenCalled()
  })

  it("evicts the oldest entries instead of growing the cache without bound", async () => {
    const probe = installProbe(true)

    for (let index = 0; index < 70; index += 1) {
      await probeWorkspaceGit(`D:/workspace-${index}`)
    }
    expect(probe).toHaveBeenCalledTimes(70)

    // 最早插入的路径已被挤出：再问它一次会重新发探测。
    await probeWorkspaceGit("D:/workspace-0")
    expect(probe).toHaveBeenCalledTimes(71)
  })
})
