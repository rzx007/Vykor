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

  it("builds the Windows Documents path", () => {
    expect(buildOutsideProjectDayRoot("C:\\Users\\tester\\Documents", date, win32.join)).toBe(
      "C:\\Users\\tester\\Documents\\Vykor\\2026-08-24"
    )
  })

  it.each([
    ["macOS", "/Users/tester/Documents"],
    ["Linux", "/home/tester/Documents"],
  ])("builds the %s Documents path", (_platform, documentsPath) => {
    expect(buildOutsideProjectDayRoot(documentsPath, date, posix.join)).toBe(
      `${documentsPath}/Vykor/2026-08-24`
    )
  })

  it("recognizes only managed Windows workspaces", () => {
    expect(
      isOutsideProjectWorkspacePath(
        "C:\\Users\\tester\\Documents\\Vykor\\2026-08-24\\x1",
        "C:\\Users\\tester\\Documents",
        win32
      )
    ).toBe(true)
    expect(
      isOutsideProjectWorkspacePath(
        "C:\\Users\\tester\\Documents\\Vykor-backup\\x1",
        "C:\\Users\\tester\\Documents",
        win32
      )
    ).toBe(false)
  })

  it.each([
    ["macOS", "/Users/tester/Documents", "/Users/tester/Documents/Vykor/2026-08-24/x1"],
    ["Linux", "/home/tester/Documents", "/home/tester/Documents/Vykor/2026-08-24/x1"],
  ])("recognizes a managed %s workspace", (_platform, documentsPath, workspacePath) => {
    expect(isOutsideProjectWorkspacePath(workspacePath, documentsPath, posix)).toBe(true)
  })

  it("atomically allocates a different xN directory for concurrent sessions", async () => {
    const documentsPath = await mkdtemp(join(tmpdir(), "vykor-documents-"))
    temporaryRoots.push(documentsPath)

    const allocated = await Promise.all([
      allocateOutsideProjectWorkspace(documentsPath, date),
      allocateOutsideProjectWorkspace(documentsPath, date),
      allocateOutsideProjectWorkspace(documentsPath, date),
    ])

    expect(new Set(allocated).size).toBe(3)
    expect(allocated.map((path) => path.split(/[\\/]/).at(-1)).sort()).toEqual(["x1", "x2", "x3"])
  })

  it("normalizes workspace paths for comparison", () => {
    expect(normalizeWorkspacePath("C:\\Data\\Channels\\")).toBe("c:/data/channels")
    expect(normalizeWorkspacePath("/data/channels")).toBe("/data/channels")
  })

  it("hides a project that is a channel session cwd, regardless of the documents root", () => {
    const channelCwd = "/data/channels/feishu/oc_1-abc"
    const channelCwds = new Set([normalizeWorkspacePath(channelCwd)])
    expect(isChannelProjectHidden(channelCwd, channelCwds, "/Users/tester/Documents")).toBe(true)
    expect(isChannelProjectHidden("/work/alpha", channelCwds, "/Users/tester/Documents")).toBe(false)
  })

  it("still hides documents/Vykor projects by path", () => {
    expect(
      isChannelProjectHidden(
        "/Users/tester/Documents/Vykor/x1",
        new Set(),
        "/Users/tester/Documents"
      )
    ).toBe(true)
  })

  it("allocates a real cwd without requiring a project record", async () => {
    const documentsPath = await mkdtemp(join(tmpdir(), "vykor-projectless-"))
    temporaryRoots.push(documentsPath)

    const cwd = await allocateOutsideProjectWorkspace(documentsPath, date)

    expect(isOutsideProjectWorkspacePath(cwd, documentsPath)).toBe(true)
    expect(cwd).toContain(join("Vykor", "2026-08-24", "x1"))
  })
})
