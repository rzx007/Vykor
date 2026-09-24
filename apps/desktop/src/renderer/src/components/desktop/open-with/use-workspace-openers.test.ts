// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest"

import { launchProjectFolderOpener, launchWorkspaceOpener } from "./use-workspace-openers"

describe("launchWorkspaceOpener", () => {
  const openWith = vi.fn(async () => undefined)
  const updateDefaultOpener = vi.fn(async () => undefined)

  beforeEach(() => {
    openWith.mockClear()
    updateDefaultOpener.mockClear()
    localStorage.clear()
    vi.stubGlobal("window", {
      desktop: {
        workspace: { openWith },
        settings: { updateDefaultOpener },
      },
    })
  })

  it("opens without writing the default opener or localStorage", async () => {
    await launchWorkspaceOpener({ openerId: "vscode", path: "E:/code/app" })
    expect(openWith).toHaveBeenCalledWith({
      openerId: "vscode",
      path: "E:/code/app",
      rootPath: undefined,
    })
    expect(updateDefaultOpener).not.toHaveBeenCalled()
    expect(localStorage.getItem("vykor.desktop.open-with.v1")).toBeNull()
  })

  it("opens a project folder with the folder as both path and rootPath", async () => {
    await launchProjectFolderOpener("vscode", "E:/code/app")
    expect(openWith).toHaveBeenCalledWith({
      openerId: "vscode",
      path: "E:/code/app",
      rootPath: "E:/code/app",
    })
  })
})
