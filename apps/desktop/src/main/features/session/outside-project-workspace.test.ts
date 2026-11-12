import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, posix, win32 } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import {
  allocateOutsideProjectWorkspace,
  buildOutsideProjectDayRoot,
  isChannelProjectHidden,
  isOutsideProjectWorkspacePath,
  normalizeWorkspacePath,
} from "./outside-project-workspace"

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

describe("outside-project workspace paths", () => {
  const date = new Date(2026, 7, 24, 15, 30)

  it("uses the supplied Windows workspace root", () => {
    expect(
      buildOutsideProjectDayRoot("C:\\Users\\tester\\.vykor\\workspaces", date, win32.join)
    ).toBe("C:\\Users\\tester\\.vykor\\workspaces\\2026-08-24")
  })

  it.each([
    ["macOS", "/Users/tester/.vykor/workspaces"],
    ["Linux", "/home/tester/.vykor/workspaces"],
  ])("uses the supplied %s workspace root", (_platform, workspacesDir) => {
    expect(buildOutsideProjectDayRoot(workspacesDir, date, posix.join)).toBe(
      `${workspacesDir}/2026-08-24`
    )
  })

  it("recognizes only managed Windows workspaces", () => {
    expect(
      isOutsideProjectWorkspacePath(
        "C:\\Users\\tester\\.vykor\\workspaces\\2026-08-24\\x1",
        "C:\\Users\\tester\\.vykor\\workspaces",
        win32
      )
    ).toBe(true)
    expect(
      isOutsideProjectWorkspacePath(
        "C:\\Users\\tester\\.vykor\\workspaces-backup\\x1",
        "C:\\Users\\tester\\.vykor\\workspaces",
        win32
      )
    ).toBe(false)
  })

  it.each([
    ["macOS", "/Users/tester/.vykor/workspaces", "/Users/tester/.vykor/workspaces/2026-08-24/x1"],
    ["Linux", "/home/tester/.vykor/workspaces", "/home/tester/.vykor/workspaces/2026-08-24/x1"],
  ])("recognizes a managed %s workspace", (_platform, workspacesDir, workspacePath) => {
    expect(isOutsideProjectWorkspacePath(workspacePath, workspacesDir, posix)).toBe(true)
  })

  it("atomically allocates a different xN directory for concurrent sessions", async () => {
    const workspacesDir = await mkdtemp(join(tmpdir(), "vykor-workspaces-"))
    temporaryRoots.push(workspacesDir)

    const allocated = await Promise.all([
      allocateOutsideProjectWorkspace(workspacesDir, date),
      allocateOutsideProjectWorkspace(workspacesDir, date),
      allocateOutsideProjectWorkspace(workspacesDir, date),
    ])

    expect(new Set(allocated).size).toBe(3)
    expect(allocated.map((path) => path.split(/[\\/]/).at(-1)).sort()).toEqual(["x1", "x2", "x3"])
  })

  it("normalizes workspace paths for comparison", () => {
    expect(normalizeWorkspacePath("C:\\Data\\Channels\\")).toBe("c:/data/channels")
    expect(normalizeWorkspacePath("/data/channels")).toBe("/data/channels")
  })

  it("hides a project that is a channel session cwd, regardless of the workspace root", () => {
    const channelCwd = "/data/channels/feishu/oc_1-abc"
    const channelCwds = new Set([normalizeWorkspacePath(channelCwd)])
    expect(isChannelProjectHidden(channelCwd, channelCwds, "/Users/tester/.vykor/workspaces")).toBe(
      true
    )
    expect(
      isChannelProjectHidden("/work/alpha", channelCwds, "/Users/tester/.vykor/workspaces")
    ).toBe(false)
  })

  it("hides the configured workspaces root by path", () => {
    expect(
      isChannelProjectHidden(
        "/Users/tester/.vykor/workspaces/x1",
        new Set(),
        "/Users/tester/.vykor/workspaces"
      )
    ).toBe(true)
  })

  it("allocates a real cwd without requiring a project record", async () => {
    const workspacesDir = await mkdtemp(join(tmpdir(), "vykor-projectless-"))
    temporaryRoots.push(workspacesDir)

    const cwd = await allocateOutsideProjectWorkspace(workspacesDir, date)

    expect(isOutsideProjectWorkspacePath(cwd, workspacesDir)).toBe(true)
    expect(cwd).toContain(join("2026-08-24", "x1"))
  })
})
