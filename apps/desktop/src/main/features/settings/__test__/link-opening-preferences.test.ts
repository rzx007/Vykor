import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, it } from "vitest"
import { getDesktopPreferencesAt, patchDesktopPreferencesAt } from "../desktop-preferences-storage"

let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "vykor-link-opening-"))
})
afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

it("asks by default without changing existing desktop preferences", () => {
  const preferences = getDesktopPreferencesAt(directory)
  expect(preferences.linkOpeningMode).toBeUndefined()
  expect(preferences.notificationMode).toBe("when_unfocused")
})

it.each(["ask", "builtin", "system"] as const)(
  "preserves %s across unrelated saves and a fresh read",
  (mode) => {
    patchDesktopPreferencesAt(directory, { linkOpeningMode: mode, defaultOpenerId: "vscode" })
    patchDesktopPreferencesAt(directory, { notificationMode: "never" })
    const restored = getDesktopPreferencesAt(directory)
    expect(restored).toMatchObject({
      linkOpeningMode: mode,
      defaultOpenerId: "vscode",
      notificationMode: "never",
    })
  }
)

it.each(["unknown", null, 1, {}])("falls back to asking for an invalid saved mode: %j", (mode) => {
  writeFileSync(
    join(directory, "desktop-preferences.json"),
    JSON.stringify({ linkOpeningMode: mode })
  )
  expect(getDesktopPreferencesAt(directory).linkOpeningMode).toBeUndefined()
})
