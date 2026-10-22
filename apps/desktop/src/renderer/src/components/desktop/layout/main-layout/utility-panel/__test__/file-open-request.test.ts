import { describe, expect, it } from "vitest"

import { prepareFileOpenRequest } from "../file-open-request"

describe("prepareFileOpenRequest", () => {
  it("routes outside HTML to a browser while leaving project HTML in the file viewer", () => {
    expect(
      prepareFileOpenRequest("C:/Users/ruanz/.answer-me-with-html/pages/更新 #1.html:42", "D:/repo")
    ).toMatchObject({
      browserUrl:
        "file:///C:/Users/ruanz/.answer-me-with-html/pages/%E6%9B%B4%E6%96%B0%20%231.html",
    })
    expect(prepareFileOpenRequest("/tmp/report.htm", "/repo")).toMatchObject({
      browserUrl: "file:///tmp/report.htm",
    })
    expect(prepareFileOpenRequest("D:/repo/index.html", "D:/repo")).not.toHaveProperty("browserUrl")
    expect(prepareFileOpenRequest("D:/repository/index.html", "D:/repo")).toHaveProperty(
      "browserUrl"
    )
    expect(prepareFileOpenRequest("D:/repo/../report.html", "D:/repo")).toMatchObject({
      browserUrl: "file:///D:/report.html",
    })
    expect(prepareFileOpenRequest("/C:/reports/更新.html", "D:/repo")).toMatchObject({
      browserUrl: "file:///C:/reports/%E6%9B%B4%E6%96%B0.html",
    })
    expect(prepareFileOpenRequest("//server/share/report.html", "D:/repo")).not.toHaveProperty(
      "browserUrl"
    )
    expect(prepareFileOpenRequest("index.html", "D:/repo")).not.toHaveProperty("browserUrl")
    expect(prepareFileOpenRequest("C:/other/readme.md", "D:/repo")).not.toHaveProperty("browserUrl")
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
