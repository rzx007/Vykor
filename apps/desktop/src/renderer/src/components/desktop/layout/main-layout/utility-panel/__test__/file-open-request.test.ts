import { describe, expect, it } from "vitest"

import { prepareFileOpenRequest } from "../file-open-request"

describe("prepareFileOpenRequest", () => {
  it.each([
    ["C:/reports/更新 #1%20.html:42", "D:/repo", "C:/reports/更新 #1%20.html"],
    ["D:/repo/index.html", "D:/repo", "D:/repo/index.html"],
    ["index.html", "D:/repo", "D:/repo/index.html"],
    ["./reports/page.htm", "D:/repo", "D:/repo/reports/page.htm"],
    ["../report.html", "D:/repo", "D:/report.html"],
    ["/tmp/report.htm", "/repo", "/tmp/report.htm"],
    ["pages/report.html", "/repo", "/repo/pages/report.html"],
    ["/C:/reports/更新.html", "D:/repo", "C:/reports/更新.html"],
    ["images/diagram.svg", "D:/repo", "D:/repo/images/diagram.svg"],
    ["../diagram.SVG", "/repo", "/diagram.SVG"],
  ])("resolves %s for the same HTML file preview and source tab", (path, root, openPath) => {
    expect(prepareFileOpenRequest(path, root)).toEqual({ openPath, placeholderPath: null })
  })
  it("keeps the raw path and does not invent a placeholder for extra-root files", () => {
    const skillPath = "C:\\Users\\ruanz\\.vykor\\skills\\show-me\\SKILL.md"
    expect(prepareFileOpenRequest(skillPath, "E:/code/vykor")).toEqual({
      openPath: skillPath,
      placeholderPath: null,
    })
  })

  it("does not invent a placeholder for project-relative paths either", () => {
    expect(prepareFileOpenRequest("src/foo.ts", "E:/code/vykor")).toEqual({
      openPath: "src/foo.ts",
      placeholderPath: null,
    })
  })
})
