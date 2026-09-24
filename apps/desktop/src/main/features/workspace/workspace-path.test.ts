import { posix, win32 } from "node:path"
import { describe, expect, it } from "vitest"

import { classifyWorkspacePath } from "./workspace-path"

const windowsRoots = {
  projectRoot: "E:\\code\\vykor",
  configDir: "C:\\Users\\ruanz\\.vykor",
  skillsDir: "C:\\Users\\ruanz\\.vykor\\skills",
  userProfilePath: "C:\\Users\\ruanz\\.vykor\\USER.md",
  outsideProjectRoot: "C:\\Users\\ruanz\\Documents\\Vykor",
}

const posixRoots = {
  projectRoot: "/repo",
  configDir: "/Users/ruanz/.vykor",
  skillsDir: "/Users/ruanz/.vykor/skills",
  userProfilePath: "/Users/ruanz/.vykor/USER.md",
  outsideProjectRoot: "/Users/ruanz/Documents/Vykor",
}

describe("classifyWorkspacePath", () => {
  it("classifies project-relative and in-project Windows absolute paths", () => {
    expect(classifyWorkspacePath("src/a.ts", windowsRoots, { win32, posix })?.kind).toBe("project")
    expect(
      classifyWorkspacePath("E:\\code\\vykor\\src\\a.ts", windowsRoots, { win32, posix })
        ?.relativePath
    ).toBe("src/a.ts")
  })

  it("classifies personal skills and USER.md as extra-root", () => {
    const skill = classifyWorkspacePath(
      "C:\\Users\\ruanz\\.vykor\\skills\\show-me\\SKILL.md",
      windowsRoots,
      { win32, posix }
    )
    expect(skill).toMatchObject({
      kind: "extra-root",
      relativePath: "skills/show-me/SKILL.md",
      rootLabel: "个人配置",
    })
    expect(
      classifyWorkspacePath("C:\\Users\\ruanz\\.vykor\\USER.md", windowsRoots, {
        win32,
        posix,
      })?.kind
    ).toBe("extra-root")
    expect(
      classifyWorkspacePath("C:\\Users\\ruanz\\.vykor\\credentials.json", windowsRoots, {
        win32,
        posix,
      })
    ).toBeNull()
  })

  it("maps POSIX skill paths using each root drive, not the process drive", () => {
    const result = classifyWorkspacePath(
      "/Users/ruanz/.vykor/skills/show-me/SKILL.md",
      windowsRoots,
      { win32, posix }
    )
    expect(result?.kind).toBe("extra-root")
    expect(result?.tabPath.replace(/\\/g, "/")).toContain(
      "C:/Users/ruanz/.vykor/skills/show-me/SKILL.md"
    )
  })

  it("falls back /src/foo.ts to a project-relative path", () => {
    expect(classifyWorkspacePath("/src/foo.ts", windowsRoots, { win32, posix })).toMatchObject({
      kind: "project",
      relativePath: "src/foo.ts",
    })
  })

  it("keeps a POSIX skill relative path when win32.resolve has no drive letter", () => {
    const linuxLikeWin32 = {
      ...win32,
      resolve: (...segments: string[]) => win32.resolve(...segments).replace(/^[a-zA-Z]:/, ""),
    }
    const tmpRoots = {
      projectRoot: "/tmp/vykor-workspace-project",
      configDir: "/tmp/vykor-workspace-h1YEt7",
      skillsDir: "/tmp/vykor-workspace-h1YEt7/skills",
      userProfilePath: "/tmp/vykor-workspace-h1YEt7/USER.md",
      outsideProjectRoot: "/tmp/vykor-workspace-docs/Vykor",
    }

    expect(
      classifyWorkspacePath(
        "/tmp/vykor-workspace-h1YEt7/skills/show-me/SKILL.md",
        tmpRoots,
        { win32: linuxLikeWin32, posix }
      )
    ).toMatchObject({
      kind: "extra-root",
      relativePath: "skills/show-me/SKILL.md",
      rootLabel: "个人配置",
    })
  })

  it("classifies POSIX skill paths against POSIX roots", () => {
    expect(
      classifyWorkspacePath(
        "/Users/ruanz/.vykor/skills/show-me/SKILL.md",
        posixRoots,
        { win32, posix }
      )
    ).toMatchObject({
      kind: "extra-root",
      relativePath: "skills/show-me/SKILL.md",
      rootLabel: "个人配置",
    })
  })

  it("does not classify /etc/passwd as extra-root", () => {
    expect(classifyWorkspacePath("/etc/passwd", posixRoots, { win32, posix })?.kind).not.toBe(
      "extra-root"
    )
    expect(classifyWorkspacePath("/etc/passwd", posixRoots, { win32, posix })).toMatchObject({
      kind: "project",
      relativePath: "etc/passwd",
    })
  })

  it("prefers the current project when it sits inside an extra root", () => {
    const sessionRoots = {
      ...windowsRoots,
      projectRoot: "C:\\Users\\ruanz\\Documents\\Vykor\\2026-09-06\\x1",
    }
    expect(
      classifyWorkspacePath(
        "C:\\Users\\ruanz\\Documents\\Vykor\\2026-09-06\\x1\\src\\a.ts",
        sessionRoots,
        { win32, posix }
      )
    ).toMatchObject({ kind: "project", relativePath: "src/a.ts" })
    expect(
      classifyWorkspacePath(
        "C:\\Users\\ruanz\\Documents\\Vykor\\2026-09-06\\x2\\note.md",
        sessionRoots,
        { win32, posix }
      )?.kind
    ).toBe("extra-root")
  })
})
