import { describe, expect, it } from "vitest"
import { composerDocument, selectComposerDocumentText } from "./composer-document"

describe("composer document", () => {
  it("uses plugin display names without losing their structured identity", () => {
    const document = composerDocument([
      { type: "capability", kind: "plugin", pluginId: "dev.quality", displayName: "Quality" },
      { type: "text", text: " review" },
    ])
    expect(selectComposerDocumentText(document)).toBe("@Quality review")
    expect(document.items[0]).toEqual({ type: "capability", kind: "plugin", pluginId: "dev.quality", displayName: "Quality" })
  })
  it("preserves ordered items and derives the readable submission text", () => {
    const document = composerDocument([
      { type: "text", text: "使用 " },
      {
        type: "skill",
        name: "writing-plans",
        path: "D:/skills/plan/SKILL.md",
        displayName: "Writing Plans",
      },
      { type: "text", text: " 编写计划" },
    ])

    expect(document).toEqual({
      version: 1,
      items: [
        { type: "text", text: "使用 " },
        {
          type: "skill",
          name: "writing-plans",
          path: "D:/skills/plan/SKILL.md",
          displayName: "Writing Plans",
        },
        { type: "text", text: " 编写计划" },
      ],
    })
    expect(selectComposerDocumentText(document)).toBe("使用 $writing-plans 编写计划")
  })

  it("merges adjacent text and drops empty text items", () => {
    expect(
      composerDocument([
        { type: "text", text: "" },
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ])
    ).toEqual({ version: 1, items: [{ type: "text", text: "ab" }] })
  })
})
