import { describe, expect, it } from "vitest"

import { buildDesktopSettingsSnapshot } from "../../../../shared/settings-types"
import { DesktopSettingsService } from "../settings-service"

describe("desktop reply style", () => {
  it.each([undefined, null, "chatty", "", false, {}])(
    "uses collaborative for a missing or invalid saved value: %j",
    (replyStyle) => {
      expect(buildDesktopSettingsSnapshot({ replyStyle })).toMatchObject({
        replyStyle: "collaborative",
      })
    }
  )

  it.each(["collaborative", "direct", "explanatory"])(
    "loads the saved %s reply style",
    (replyStyle) => {
      expect(buildDesktopSettingsSnapshot({ replyStyle })).toMatchObject({ replyStyle })
    }
  )

  it("saves a reply style and reads it back without changing progress notifications", async () => {
    const { service, saved } = createService()

    const result = await service.updateReplyStyle({ replyStyle: "explanatory" })

    expect(saved).toEqual({ replyStyle: "explanatory", workStyle: "efficient" })
    expect(result).toMatchObject({ replyStyle: "explanatory", workStyle: "efficient" })
    expect(await service.snapshot()).toMatchObject({
      replyStyle: "explanatory",
      workStyle: "efficient",
    })
  })

  it.each([undefined, null, "inherit", "chatty", false, 1, {}])(
    "rejects an invalid update before changing saved settings: %j",
    async (replyStyle) => {
      const { service, saved } = createService()

      await expect(service.updateReplyStyle({ replyStyle } as never)).rejects.toThrow("回复风格")

      expect(saved).toEqual({ replyStyle: "direct", workStyle: "efficient" })
    }
  )

  it("surfaces a save failure and leaves the last saved value readable", async () => {
    const { service, saved } = createService(true)

    await expect(service.updateReplyStyle({ replyStyle: "collaborative" })).rejects.toThrow(
      "设置未保存"
    )

    expect(saved.replyStyle).toBe("direct")
    expect(await service.snapshot()).toMatchObject({ replyStyle: "direct" })
  })
})

function createService(failSave = false) {
  const saved: Record<string, unknown> = { replyStyle: "direct", workStyle: "efficient" }
  const client = {
    protocol: {
      capabilities: async () => ({
        serverVersion: "1",
        protocol: { version: 2 },
        features: {},
      }),
    },
    system: {
      getSettings: async () => ({ ...saved }),
      patchSettings: async (patch: Record<string, unknown>) => {
        if (failSave) throw new Error("设置未保存")
        Object.assign(saved, patch)
        return { ...saved }
      },
    },
  }
  const service = new DesktopSettingsService({
    daemonClient: async () => client,
    refreshDaemonClient: async () => client,
    getPreferences: () => ({ notificationMode: "when_unfocused" }),
    patchPreferences: () => ({ notificationMode: "when_unfocused" }),
  })
  return { service, saved }
}
