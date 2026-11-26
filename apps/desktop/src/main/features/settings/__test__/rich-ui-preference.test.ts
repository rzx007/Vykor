import { mkdtempSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import type { IpcMainInvokeEvent } from "electron"
import { expect, it, vi } from "vitest"
import { IpcChannels, IpcEvents, type IpcChannel } from "@shared/ipc-channels"
import type { AppContext } from "../../../core/app-context"
import { getDesktopPreferences, patchDesktopPreferences } from "../desktop-preferences"
import { settingsIpcContribution } from "../ipc"
import { desktopSettingsService } from "../settings-service"

const { getPath } = vi.hoisted(() => ({ getPath: vi.fn() }))
vi.mock("electron", () => ({ app: { getPath } }))

function register() {
  const directory = mkdtempSync(join(process.env.VYKOR_CONFIG_DIR!, "rich-settings-"))
  getPath.mockReturnValue(directory)
  const indexHtml = join(directory, "index.html")
  const mainFrame = { url: pathToFileURL(indexHtml).href + "#/settings/general" }
  const sender = { mainFrame, isDestroyed: vi.fn(() => false), send: vi.fn() }
  const ctx = {
    paths: { indexHtml },
    windowManager: { getMain: () => ({ webContents: sender }) },
  } as unknown as AppContext
  const handlers = settingsIpcContribution.register(ctx)
  const invoke = (
    channel: IpcChannel,
    value?: unknown,
    event: unknown = { sender, senderFrame: mainFrame }
  ) =>
    handlers.find((entry) => entry.channel === channel)!.handler(event as IpcMainInvokeEvent, value)
  return { directory, mainFrame, sender, invoke }
}

it("defaults off for old preferences and persists a separate local rich-content setting", () => {
  const { directory, sender, invoke } = register()
  expect(invoke(IpcChannels.settingsGetRichUiEnabled)).toBe(false)
  writeFileSync(
    join(directory, "desktop-preferences.json"),
    JSON.stringify({ interactiveUiEnabled: true, richUiEnabled: "true" })
  )

  expect(invoke(IpcChannels.settingsGetRichUiEnabled)).toBe(false)
  expect(invoke(IpcChannels.settingsUpdateRichUiEnabled, true)).toBe(true)
  expect(sender.send).toHaveBeenLastCalledWith(IpcEvents.richUiEnabledChanged, true)
  patchDesktopPreferences({ notificationMode: "never" })
  expect(getDesktopPreferences()).toMatchObject({
    notificationMode: "never",
    interactiveUiEnabled: true,
    richUiEnabled: true,
  })
  expect(desktopSettingsService.getRichUiEnabled()).toBe(true)

  expect(invoke(IpcChannels.settingsUpdateRichUiEnabled, false)).toBe(false)
  expect(sender.send).toHaveBeenLastCalledWith(IpcEvents.richUiEnabledChanged, false)
  expect(desktopSettingsService.getRichUiEnabled()).toBe(false)
  expect(desktopSettingsService.getInteractiveUiEnabled()).toBe(true)
})

it("only accepts booleans from the registered renderer's current main frame", () => {
  const { mainFrame, sender, invoke } = register()

  expect(() => invoke(IpcChannels.settingsUpdateRichUiEnabled, "true")).toThrow(/开关值/)
  expect(() =>
    invoke(IpcChannels.settingsUpdateRichUiEnabled, true, {
      sender,
      senderFrame: { ...mainFrame },
    })
  ).toThrow(/主窗口/)
  expect(() =>
    invoke(IpcChannels.settingsUpdateRichUiEnabled, true, {
      sender: { ...sender },
      senderFrame: mainFrame,
    })
  ).toThrow(/主窗口/)
  sender.isDestroyed.mockReturnValueOnce(true)
  expect(() => invoke(IpcChannels.settingsUpdateRichUiEnabled, true)).toThrow(/主窗口/)
  mainFrame.url = "https://example.test/untrusted"
  expect(() => invoke(IpcChannels.settingsUpdateRichUiEnabled, true)).toThrow(/主窗口/)

  expect(sender.send).not.toHaveBeenCalled()
  expect(desktopSettingsService.getRichUiEnabled()).toBe(false)
})
