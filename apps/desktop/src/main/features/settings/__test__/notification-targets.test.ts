import { mkdtemp, readFile, rmdir, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { getDesktopPreferencesAt, patchDesktopPreferencesAt } from "../desktop-preferences-storage"

it("preserves native targets and unsent replies across unrelated settings saves", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vykor-notification-targets-"))
  const file = join(directory, "desktop-preferences.json")
  try {
    const target = {
      id: "0123456789abcdef",
      sessionId: "original",
      kind: "reply" as const,
      reply: { id: "input-1", text: "尚未确认的回复" },
    }
    patchDesktopPreferencesAt(directory, { notificationTargets: [target] })
    patchDesktopPreferencesAt(directory, { notificationMode: "never" })
    expect(getDesktopPreferencesAt(directory).notificationTargets).toEqual([target])
    patchDesktopPreferencesAt(directory, {
      notificationTargets: [
        { id: target.id, sessionId: target.sessionId, kind: target.kind, resolved: true },
      ],
    })
    expect(await readFile(file, "utf8")).not.toContain("尚未确认的回复")
  } finally {
    await unlink(file).catch(() => undefined)
    await rmdir(directory)
  }
})

it("ignores malformed native targets without losing other desktop preferences", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vykor-notification-targets-"))
  const file = join(directory, "desktop-preferences.json")
  try {
    await writeFile(
      file,
      JSON.stringify({
        notificationMode: "always",
        notificationTargets: [
          null,
          { id: "x", sessionId: "original", kind: "approval" },
          {
            id: "0123456789abcdef",
            sessionId: "original",
            kind: "reply",
            reply: { id: "input-1", text: 42 },
          },
        ],
      })
    )
    expect(getDesktopPreferencesAt(directory)).toMatchObject({
      notificationMode: "always",
      notificationTargets: [],
    })
  } finally {
    await unlink(file).catch(() => undefined)
    await rmdir(directory)
  }
})
