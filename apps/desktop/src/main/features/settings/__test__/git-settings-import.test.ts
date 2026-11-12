import { afterEach, expect, it, vi } from "vitest"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
vi.mock("electron", () => ({ app: { getPath: () => "unused" } }))
import {
  importLegacyGitSettings,
  readGitSettingsAt,
  writeGitSettingsAt,
} from "../git-settings-storage"
import { defaultGitPreferences } from "../../../../shared/git-settings-types"
const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))
it("imports business JSON once, retaining source and real worktree paths", () => {
  const root = mkdtempSync(join(tmpdir(), "git-import-"))
  roots.push(root)
  const old = join(root, "old"),
    target = join(root, "target"),
    manifest = join(target, "legacy-import.json")
  const data = {
    version: 1 as const,
    preferences: defaultGitPreferences,
    worktrees: [
      {
        id: "w",
        projectId: "p",
        projectPath: "/project",
        path: "/old/worktree",
        branch: "b",
        slug: "s",
        configDir: "/old/config",
        disposable: false,
        baseCommit: "a",
      },
    ],
  }
  writeGitSettingsAt(old, data)
  importLegacyGitSettings(old, target, manifest)
  expect(readGitSettingsAt(target)).toEqual(data)
  expect(readFileSync(join(old, "git-settings.json"), "utf8")).toContain("/old/worktree")
  writeGitSettingsAt(target, {
    ...data,
    preferences: { ...defaultGitPreferences, autoCleanup: true },
  })
  importLegacyGitSettings(old, target, manifest)
  expect(readGitSettingsAt(target).preferences.autoCleanup).toBe(true)
  writeGitSettingsAt(old, { ...data, worktrees: [] })
  expect(() => importLegacyGitSettings(old, target, manifest)).toThrow(/LEGACY_CHANGED/)
})
