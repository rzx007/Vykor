import { afterEach, expect, it, vi } from "vitest"
import { DESKTOP_SOUND_OPTIONS } from "@shared/settings-types"
import { playNotificationSound } from "./notification-sound"

afterEach(() => vi.unstubAllGlobals())

it("can play every sound offered in the dropdown and keeps the no-sound option silent", async () => {
  const play = vi.fn(async () => undefined)
  const audio = vi.fn(function () {
    return { play, pause: vi.fn() }
  })
  vi.stubGlobal("Audio", audio)
  await playNotificationSound("none")
  expect(play).not.toHaveBeenCalled()
  for (const { value } of DESKTOP_SOUND_OPTIONS) {
    if (value === "none") continue
    await playNotificationSound(value)
    expect(audio).toHaveBeenLastCalledWith(expect.stringContaining(`${value}.mp3`))
  }
  expect(play).toHaveBeenCalledTimes(45)
})
