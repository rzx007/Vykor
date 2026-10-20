import { describe, expect, it } from "vitest"

import type { WorkspaceOpener } from "@shared/workspace-types"

import { resolveSelectedOpener } from "../resolve-selected-opener"

const openers = [
  opener("explorer", "folder"),
  opener("vscode", "editor"),
  opener("cursor", "editor"),
] satisfies WorkspaceOpener[]

function opener(id: string, kind: WorkspaceOpener["kind"]): WorkspaceOpener {
  return { id, label: id, kind, iconDataUrl: null }
}

describe("resolveSelectedOpener", () => {
  it("returns null when the list is empty", () => {
    expect(resolveSelectedOpener([], "vscode")).toBeNull()
  })

  it("uses the saved id when it is still installed", () => {
    expect(resolveSelectedOpener(openers, "vscode")?.id).toBe("vscode")
  })

  it("falls back to cursor then vscode then the first opener", () => {
    expect(resolveSelectedOpener(openers, "gone")?.id).toBe("cursor")
    expect(
      resolveSelectedOpener(
        openers.filter((item) => item.id !== "cursor"),
        null
      )?.id
    ).toBe("vscode")
    expect(
      resolveSelectedOpener(
        openers.filter((item) => item.id !== "cursor" && item.id !== "vscode"),
        "gone"
      )?.id
    ).toBe("explorer")
  })
})
