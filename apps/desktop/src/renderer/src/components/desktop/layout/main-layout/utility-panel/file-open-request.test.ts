import { describe, expect, it } from "vitest"

import { prepareFileOpenRequest } from "./file-open-request"

describe("prepareFileOpenRequest", () => {
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
