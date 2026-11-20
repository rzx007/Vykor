import { posix, win32 } from "node:path"
import { describe, expect, it } from "vitest"
import { classifyWorkspacePath, stillInsideAllowedRoot } from "../workspace-path"

const roots = {
  projectRoot: "/tmp/host/project",
  configDir: "/tmp/host/config",
  skillsDir: "/tmp/host/config/skills",
  userProfilePath: "/tmp/host/config/USER.md",
  outsideProjectRoot: "/tmp/host/workspaces",
  managedWorkspaceRoots: ["/tmp/host/channels"],
}

// Model a Windows process on C: even when this test runs on Linux.
const windowsOnC = {
  ...win32,
  resolve: (...paths: string[]) => win32.resolve("C:\\", ...paths),
}
const pathOps = { win32: windowsOnC, posix }

describe("workspace absolute path boundaries", () => {
  it.each([
    "/tmp/host/legacy-documents/Vykor/2026-11-12/x1",
    "/tmp/host/config/credentials.json",
    "/tmp/host/project-other/file.txt",
    "/src/foo.ts",
    "C:\\Windows\\file.txt",
    "\\\\other\\share\\file.txt",
  ])("rejects an unmatched absolute path: %s", (path) => {
    expect(classifyWorkspacePath(path, roots, pathOps)).toBeNull()
  })

  it.each([
    ["/tmp/host/project/src/a.ts:12:3", "project", "src/a.ts"],
    ["/tmp/host/workspaces/chat/note.md", "extra-root", "chat/note.md"],
    ["/tmp/host/channels/chat/note.md", "extra-root", "chat/note.md"],
    ["/tmp/host/config/USER.md", "extra-root", "USER.md"],
    ["/tmp/host/config/skills/demo/SKILL.md", "extra-root", "skills/demo/SKILL.md"],
  ])("preserves an allowed POSIX path: %s", (path, kind, relativePath) => {
    expect(classifyWorkspacePath(path, roots, pathOps)).toMatchObject({ kind, relativePath })
  })

  it("does not borrow the process drive to equate Windows and POSIX USER.md paths", () => {
    expect(classifyWorkspacePath("C:\\tmp\\host\\config\\USER.md", roots, pathOps)).toBeNull()
  })

  it("does not borrow the process drive during the final allowed-root check", () => {
    const classification = classifyWorkspacePath("/tmp/host/project/src/a.ts", roots, pathOps)!
    expect(
      stillInsideAllowedRoot(
        "C:\\tmp\\host\\project\\src\\a.ts",
        classification,
        roots.projectRoot,
        roots,
        pathOps
      )
    ).toBe(false)
  })

  it("preserves drive and UNC project paths", () => {
    for (const projectRoot of ["E:\\repo", "\\\\server\\share\\repo"]) {
      expect(
        classifyWorkspacePath(`${projectRoot}\\src\\a.ts`, { ...roots, projectRoot }, pathOps)
      ).toMatchObject({ kind: "project", relativePath: "src/a.ts" })
    }
  })
})
