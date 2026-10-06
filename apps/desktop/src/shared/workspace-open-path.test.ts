import { describe, expect, it } from "vitest"

import { isAbsoluteFileInRepository, routeChangedFileClick, toProjectRelativePath } from "./workspace-open-path"

describe("stored repository membership", () => {
  it.each([
    ["D:/repo/../outside/result.txt", "D:/repo", false],
    ["d:\\REPO\\..\\outside\\result.txt", "D:/repo", false],
    ["../outside/result.txt", "D:/repo", false],
    ["src/result.txt", "D:/repo", false],
    ["D:/repo/src/../result.txt", "d:\\REPO", true],
    ["\\\\?\\D:\\repo\\result.txt", "D:/Repo", true],
    ["D:/repo-other/result.txt", "D:/repo", false],
    ["/work/repo/../outside/result.txt", "/work/repo", false],
    ["/work/repo/src/../result.txt", "/work/repo", true],
    ["/work/Repo/result.txt", "/work/repo", false],
    ["/work/repo/name/file.txt", "/work/repo\\name", false],
    ["/work/repo\\name/file.txt", "/work/repo\\name", true],
    ["/outside/..\\repo/result.txt", "/repo", false],
    ["/repo?name/../../outside/result.txt", "/repo", false],
  ])("resolves %s against %s without assuming a relative cwd", (path, root, inside) => {
    expect(isAbsoluteFileInRepository(path as string, root as string)).toBe(inside)
  })
})

const project = "E:/code/vykor"

describe("toProjectRelativePath", () => {
  it("keeps project-relative paths including a leading slash", () => {
    expect(toProjectRelativePath("src/foo.ts", project)).toBe("src/foo.ts")
    expect(toProjectRelativePath("/src/foo.ts", project)).toBe("src/foo.ts")
    expect(toProjectRelativePath("./src/foo.ts", project)).toBe("src/foo.ts")
    expect(toProjectRelativePath("src/foo.ts:12", project)).toBe("src/foo.ts")
  })

  it("strips a Windows project prefix", () => {
    expect(toProjectRelativePath("E:\\code\\vykor\\src\\foo.ts", project)).toBe("src/foo.ts")
    expect(toProjectRelativePath("\\\\?\\E:\\code\\vykor\\src\\foo.ts", project)).toBe(
      "src/foo.ts"
    )
  })

  it("returns null for Windows paths outside the project", () => {
    expect(
      toProjectRelativePath(
        "C:\\Users\\ruanz\\.vykor\\skills\\show-me\\SKILL.md",
        project
      )
    ).toBeNull()
  })

  it("does not treat a POSIX home path as a project-relative path", () => {
    expect(
      toProjectRelativePath("/Users/ruanz/.vykor/skills/show-me/SKILL.md", project)
    ).toBe("Users/ruanz/.vykor/skills/show-me/SKILL.md")
  })
})

describe("routeChangedFileClick", () => {
  it("opens review for /src/foo.ts when git is available", () => {
    expect(routeChangedFileClick("/src/foo.ts", "E:/code/vykor", true)).toBe("review")
  })

  it("opens preview for an extra-root Windows skill path", () => {
    expect(
      routeChangedFileClick(
        "C:\\Users\\ruanz\\.vykor\\skills\\show-me\\SKILL.md",
        "E:/code/vykor",
        true
      )
    ).toBe("preview")
  })

  it("opens preview for a POSIX absolute path outside a POSIX project", () => {
    expect(routeChangedFileClick("/Users/ruanz/other/file.ts", "/work/repo", true)).toBe("preview")
    expect(routeChangedFileClick("/work/repo/src/file.ts", "/work/repo", true)).toBe("review")
  })
})
